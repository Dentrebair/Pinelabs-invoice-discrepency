// Deterministic three-way match (PO / invoice / GRN). Pure TypeScript: no LLM, no I/O.
// All money is INTEGER PAISE; quantities are whole numbers (see contracts.ts).
import { z } from 'zod';
import { CaseStatus, Discrepancy, type ExtractedDocument } from '../contracts';

export type DiscrepancyRecord = z.infer<typeof Discrepancy>;
type EvidenceRef = DiscrepancyRecord['evidenceRefs'][number];
type Item = ExtractedDocument['items'][number];

export interface MatchInput {
  po: ExtractedDocument;
  /** INVOICE for the first pass, REVISED_INVOICE when revalidating. */
  invoice: ExtractedDocument;
  grn: ExtractedDocument;
}

export interface MatchResult {
  discrepancies: DiscrepancyRecord[];
  /**
   * NO_DISCREPANCY | DISCREPANCY_FOUND | NEEDS_REVIEW (analysis view).
   * Only QUANTITY findings give DISCREPANCY_FOUND; anything uncertain or unsupported
   * (price, tax, reference/supplier/unit mismatch, ambiguous or missing lines) gives NEEDS_REVIEW.
   */
  status: z.infer<typeof CaseStatus>;
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toUpperCase();
const normDesc = (s: string) => norm(s).replace(/[^A-Z0-9 ]/g, '');

const UNIT_ALIASES: Record<string, string> = {
  CARTON: 'carton', CARTONS: 'carton', CTN: 'carton', CTNS: 'carton',
};
export function normalizeUnit(unit: string): string {
  const key = norm(unit);
  return UNIT_ALIASES[key] ?? key.toLowerCase();
}

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0 })}`;

const ref = (doc: ExtractedDocument, field: string): EvidenceRef => ({
  docType: doc.docType,
  documentNumber: doc.documentNumber,
  field,
});

const lineLabel = (item: Item) => item.lineRef ?? item.sku ?? item.description;

function safeMul(a: number, b: number): number | null {
  const r = a * b;
  return Number.isSafeInteger(r) ? r : null;
}

/** Document-level review finding (no money attached). */
function reviewIssue(
  description: string,
  recommendedAction: string,
  evidenceRefs: EvidenceRef[],
  issueType: DiscrepancyRecord['issueType'] = 'OTHER',
  extra: Partial<DiscrepancyRecord> = {},
): DiscrepancyRecord {
  return {
    issueType, lineRef: null, orderedQty: null, invoicedQty: null, receivedQty: null,
    amountUnderReviewPaise: 0, description, recommendedAction, evidenceRefs, ...extra,
  };
}

type Candidates = { index: number; item: Item }[];

/** Find candidate lines in `doc` for a PO line: SKU when both have one, else exact normalized description. */
function findCandidates(poItem: Item, doc: ExtractedDocument): Candidates {
  const all = doc.items.map((item, index) => ({ index, item }));
  if (poItem.sku) {
    const bySku = all.filter((c) => c.item.sku && norm(c.item.sku) === norm(poItem.sku!));
    if (bySku.length) return bySku;
  }
  // Description fallback only when at least one side has no SKU; two different SKUs never match.
  return all.filter(
    (c) => (!poItem.sku || !c.item.sku) && normDesc(c.item.description) === normDesc(poItem.description),
  );
}

export function matchDocuments({ po, invoice, grn }: MatchInput): MatchResult {
  const out: DiscrepancyRecord[] = [];

  // --- Document-level identity checks: never join unrelated documents -------------------------
  const expectedTypes: [ExtractedDocument, string[]][] = [
    [po, ['PO']], [invoice, ['INVOICE', 'REVISED_INVOICE']], [grn, ['GRN']],
  ];
  for (const [doc, ok] of expectedTypes) {
    if (!ok.includes(doc.docType)) {
      out.push(reviewIssue(
        `Document ${doc.documentNumber} is typed ${doc.docType} but was supplied as ${ok.join('/')}.`,
        'Re-upload the correct document.', [ref(doc, 'docType')]));
    }
  }

  const poNumber = norm(po.poNumber ?? po.documentNumber);
  for (const doc of [invoice, grn]) {
    if (!doc.poNumber) {
      out.push(reviewIssue(
        `${doc.docType} ${doc.documentNumber} does not state a PO reference, so it cannot be tied to ${po.documentNumber}.`,
        'Confirm which PO this document relates to.', [ref(doc, 'poNumber'), ref(po, 'documentNumber')]));
    } else if (norm(doc.poNumber) !== poNumber) {
      out.push(reviewIssue(
        `${doc.docType} ${doc.documentNumber} references PO ${doc.poNumber}, but the PO supplied is ${po.documentNumber}.`,
        'Do not process until the correct documents are matched.', [ref(doc, 'poNumber'), ref(po, 'documentNumber')]));
    }
  }

  // Supplier identifiers are only compared when present on both documents.
  for (const doc of [invoice, grn]) {
    if (po.supplierCode && doc.supplierCode && norm(po.supplierCode) !== norm(doc.supplierCode)) {
      out.push(reviewIssue(
        `Supplier on ${doc.docType} ${doc.documentNumber} (${doc.supplierCode}) differs from the PO supplier (${po.supplierCode}).`,
        'Verify the supplier identity before any further action.',
        [ref(doc, 'supplierCode'), ref(po, 'supplierCode')]));
    }
  }

  // --- Line-level matching, anchored on PO lines ----------------------------------------------
  const usedInvoice = new Set<number>();
  const usedGrn = new Set<number>();

  po.items.forEach((poItem, pi) => {
    const label = lineLabel(poItem);
    const invC = findCandidates(poItem, invoice);
    const grnC = findCandidates(poItem, grn);

    if (invC.length > 1 || grnC.length > 1) {
      const dup = invC.length > 1 ? invoice : grn;
      const cands = invC.length > 1 ? invC : grnC;
      cands.forEach((c) => (dup === invoice ? usedInvoice : usedGrn).add(c.index));
      out.push(reviewIssue(
        `PO line "${label}" matches ${cands.length} lines on ${dup.docType} ${dup.documentNumber}; possible duplicate or ambiguous line.`,
        'Ask the supplier to clarify or remove the duplicate line.',
        [ref(po, `items[${pi}]`), ...cands.map((c) => ref(dup, `items[${c.index}]`))],
        'DUPLICATE', { lineRef: label }));
      return;
    }
    if (invC.length === 0) {
      // Nothing billed for this PO line: no payment exposure. Fine unless the GRN has it unmatched elsewhere.
      if (grnC.length === 1) usedGrn.add(grnC[0].index);
      return;
    }
    const inv = invC[0];
    usedInvoice.add(inv.index);
    if (grnC.length === 0) {
      out.push(reviewIssue(
        `Invoice line "${label}" cannot be matched to any GRN line (by SKU or description); receipt is unknown.`,
        'Provide the GRN line for this item or confirm the item description/SKU.',
        [ref(po, `items[${pi}]`), ref(invoice, `items[${inv.index}]`), ref(grn, 'items')],
        'OTHER', { lineRef: label, orderedQty: poItem.quantity, invoicedQty: inv.item.quantity }));
      return;
    }
    const g = grnC[0];
    usedGrn.add(g.index);

    const refs = {
      po: (f: string) => ref(po, `items[${pi}].${f}`),
      inv: (f: string) => ref(invoice, `items[${inv.index}].${f}`),
      grn: (f: string) => ref(grn, `items[${g.index}].${f}`),
    };

    // Units must be compatible before any quantity comparison.
    const units = [poItem.unit, inv.item.unit, g.item.unit].map(normalizeUnit);
    if (new Set(units).size > 1) {
      out.push(reviewIssue(
        `Units differ for "${label}": PO ${poItem.unit}, invoice ${inv.item.unit}, GRN ${g.item.unit}. Quantities are not comparable.`,
        'Confirm the unit of measure with the supplier.',
        [refs.po('unit'), refs.inv('unit'), refs.grn('unit')],
        'OTHER', { lineRef: label }));
      return;
    }

    const ordered = poItem.quantity;
    const invoiced = inv.item.quantity;
    const received = g.item.quantity;

    // Price: PO is the agreed price. Missing price on either side is unresolvable, not zero.
    const poPrice = poItem.unitPricePaise;
    const invPrice = inv.item.unitPricePaise;
    if (poPrice === null || invPrice === null) {
      out.push(reviewIssue(
        `Unit price missing for "${label}" on ${poPrice === null ? `PO ${po.documentNumber}` : `${invoice.docType} ${invoice.documentNumber}`}; cannot verify the amount.`,
        'Obtain a document that states the unit price.',
        [refs.po('unitPricePaise'), refs.inv('unitPricePaise')],
        'OTHER', { lineRef: label, orderedQty: ordered, invoicedQty: invoiced, receivedQty: received }));
      return;
    }

    // Quantity: invoiced units not covered by both the order and the receipt.
    const supported = Math.min(ordered, received);
    const unsupported = invoiced - supported;
    if (unsupported > 0) {
      const amount = safeMul(unsupported, poPrice);
      const overOrder = invoiced > ordered;
      const shortReceipt = invoiced > received;
      const parts: string[] = [];
      if (shortReceipt) parts.push(`${invoiced} invoiced vs ${received} recorded as received`);
      if (overOrder) parts.push(`${invoiced} invoiced vs ${ordered} ordered`);
      out.push({
        issueType: 'QUANTITY', lineRef: label,
        orderedQty: ordered, invoicedQty: invoiced, receivedQty: received,
        amountUnderReviewPaise: amount ?? 0,
        description:
          `${unsupported} ${poItem.unit}(s) of "${label}" are not supported by both the PO and the GRN (${parts.join('; ')}). ` +
          `At the PO rate of ${rupees(poPrice)} this is ${rupees(amount ?? 0)} before GST.` +
          (shortReceipt && !overOrder ? ' This may be a legitimate partial delivery; it is not by itself an overcharge.' : ''),
        recommendedAction: shortReceipt && !overOrder
          ? `Request proof of delivery for the remaining ${unsupported} or a revised invoice for ${received}.`
          : `Request a corrected invoice limited to the quantity ordered and received (${supported}).`,
        evidenceRefs: [refs.po('quantity'), refs.inv('quantity'), refs.grn('quantity')],
      });
    }

    // Price: never silently accept a different rate.
    if (invPrice !== poPrice) {
      const diff = Math.abs(invPrice - poPrice);
      const amount = safeMul(diff, invoiced);
      out.push({
        issueType: 'PRICE', lineRef: label,
        orderedQty: ordered, invoicedQty: invoiced, receivedQty: received,
        amountUnderReviewPaise: amount ?? 0,
        description:
          `Invoiced unit price ${rupees(invPrice)} differs from the PO price ${rupees(poPrice)} for "${label}"; ` +
          `difference ${rupees(amount ?? 0)} across ${invoiced} units. No document supports a price change.`,
        recommendedAction: 'Ask the supplier for the basis of the changed rate, or a corrected invoice at the PO price.',
        evidenceRefs: [refs.po('unitPricePaise'), refs.inv('unitPricePaise')],
      });
    }

    // Tax: compared only when both sides state a rate; a difference is unresolved tax uncertainty.
    const poGst = poItem.gstRatePercent;
    const invGst = inv.item.gstRatePercent;
    if (poGst !== undefined && invGst !== undefined && poGst !== invGst) {
      const base = safeMul(invoiced, poPrice) ?? 0;
      // Basis points keep the arithmetic in integers: base * (diff% in bp) / 10_000.
      const bp = Math.round(Math.abs(invGst - poGst) * 100);
      out.push({
        issueType: 'TAX', lineRef: label,
        orderedQty: ordered, invoicedQty: invoiced, receivedQty: received,
        amountUnderReviewPaise: Math.round((base * bp) / 10_000),
        description: `GST rate on the invoice (${invGst}%) differs from the PO (${poGst}%) for "${label}".`,
        recommendedAction: 'Confirm the applicable GST rate with the supplier.',
        evidenceRefs: [refs.po('gstRatePercent'), refs.inv('gstRatePercent')],
      });
    }
  });

  // Invoice/GRN lines that matched no PO line: unordered goods cannot be assessed automatically.
  invoice.items.forEach((item, i) => {
    if (!usedInvoice.has(i)) {
      out.push(reviewIssue(
        `${invoice.docType} line "${lineLabel(item)}" does not match any PO line by SKU or description.`,
        'Confirm the item against the PO or ask the supplier to correct the line.',
        [ref(invoice, `items[${i}]`), ref(po, 'items')], 'OTHER', { lineRef: lineLabel(item), invoicedQty: item.quantity }));
    }
  });
  grn.items.forEach((item, i) => {
    if (!usedGrn.has(i)) {
      out.push(reviewIssue(
        `GRN line "${lineLabel(item)}" does not match any PO line by SKU or description.`,
        'Confirm what was received against the PO.',
        [ref(grn, `items[${i}]`), ref(po, 'items')], 'OTHER', { lineRef: lineLabel(item), receivedQty: item.quantity }));
    }
  });

  return { discrepancies: out, status: statusFor(out) };
}

export function statusFor(discrepancies: DiscrepancyRecord[]): z.infer<typeof CaseStatus> {
  if (discrepancies.length === 0) return 'NO_DISCREPANCY';
  return discrepancies.every((d) => d.issueType === 'QUANTITY') ? 'DISCREPANCY_FOUND' : 'NEEDS_REVIEW';
}
