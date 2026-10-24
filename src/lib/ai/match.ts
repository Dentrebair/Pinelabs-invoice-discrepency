import "server-only";
import type { z } from "zod";
import type { Discrepancy as DiscrepancySchema, ExtractedDocument } from "@/lib/contracts";
import { AiOutputError } from "./gemini";

type Discrepancy = z.infer<typeof DiscrepancySchema>;
type EvidenceRef = Discrepancy["evidenceRefs"][number];

// Deterministic three-way match (PO / invoice / GRN). No model involved: all
// quantities and amounts are integers, amounts are pre-GST paise.
//
// Billable quantity = min(ordered, accepted). For each invoiced item:
//   QUANTITY: (invoiced − billable) × min(invoice price, PO price)
//   PRICE:    (invoice price − PO price) × invoiced, when the invoice is higher
// Together these equal invoiced value − billable value at PO price, with no
// double counting.

type Line = { key: string; index: number; quantity: number; unitPricePaise: number | null };

const keyOf = (item: ExtractedDocument["items"][number]) =>
  (item.sku ?? item.description).trim().toUpperCase().replace(/\s+/g, " ");

// Aggregates repeated lines for the same item; index points at the first line.
function lines(doc: ExtractedDocument): Map<string, Line> {
  const map = new Map<string, Line>();
  doc.items.forEach((item, index) => {
    const key = keyOf(item);
    const prev = map.get(key);
    if (prev) prev.quantity += item.quantity;
    else map.set(key, { key, index, quantity: item.quantity, unitPricePaise: item.unitPricePaise });
  });
  return map;
}

const ref = (doc: ExtractedDocument, field: string): EvidenceRef => ({
  docType: doc.docType,
  documentNumber: doc.documentNumber,
  field,
});

export const formatInr = (paise: number) =>
  `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function threeWayMatch(po: ExtractedDocument, invoice: ExtractedDocument, grn: ExtractedDocument): Discrepancy[] {
  const out: Discrepancy[] = [];

  // Header consistency: every document must belong to the same PO and supplier.
  for (const doc of [invoice, grn]) {
    if (doc.poNumber && doc.poNumber.toUpperCase() !== po.documentNumber.toUpperCase()) {
      out.push({
        issueType: "OTHER",
        lineRef: null,
        orderedQty: null,
        invoicedQty: null,
        receivedQty: null,
        amountUnderReviewPaise: 0,
        description: `${doc.documentNumber} references ${doc.poNumber}, but the uploaded PO is ${po.documentNumber}.`,
        recommendedAction: "Confirm the correct purchase order before matching.",
        evidenceRefs: [ref(doc, "poNumber"), ref(po, "documentNumber")],
      });
    }
  }
  if (po.supplierCode && invoice.supplierCode && po.supplierCode.toUpperCase() !== invoice.supplierCode.toUpperCase()) {
    out.push({
      issueType: "OTHER",
      lineRef: null,
      orderedQty: null,
      invoicedQty: null,
      receivedQty: null,
      amountUnderReviewPaise: 0,
      description: `Invoice supplier ${invoice.supplierCode} differs from PO supplier ${po.supplierCode}.`,
      recommendedAction: "Verify the supplier before processing.",
      evidenceRefs: [ref(invoice, "supplierCode"), ref(po, "supplierCode")],
    });
  }

  const poLines = lines(po);
  const grnLines = lines(grn);

  for (const inv of lines(invoice).values()) {
    const invPrice = inv.unitPricePaise;
    if (invPrice === null) throw new AiOutputError(`No unit price for ${inv.key} on ${invoice.documentNumber}`);
    const ordered = poLines.get(inv.key);
    const received = grnLines.get(inv.key);
    const invRefs = (field: string) => ref(invoice, `items[${inv.index}].${field}`);

    if (!ordered) {
      out.push({
        issueType: "OTHER",
        lineRef: inv.key,
        orderedQty: 0,
        invoicedQty: inv.quantity,
        receivedQty: received?.quantity ?? 0,
        amountUnderReviewPaise: inv.quantity * invPrice,
        description: `${inv.key} is billed on ${invoice.documentNumber} but is not on ${po.documentNumber}.`,
        recommendedAction: "Ask the supplier to remove the item or provide an authorised PO amendment.",
        evidenceRefs: [invRefs("sku"), ref(po, "items")],
      });
      continue;
    }

    const poPrice = ordered.unitPricePaise;
    if (poPrice === null) throw new AiOutputError(`No unit price for ${inv.key} on ${po.documentNumber}`);
    const accepted = received?.quantity ?? 0;
    const billable = Math.min(ordered.quantity, accepted);
    const grnRef = received ? ref(grn, `items[${received.index}].quantity`) : ref(grn, "items");

    if (inv.quantity > billable) {
      const excess = inv.quantity - billable;
      const amount = excess * Math.min(invPrice, poPrice);
      out.push({
        issueType: "QUANTITY",
        lineRef: inv.key,
        orderedQty: ordered.quantity,
        invoicedQty: inv.quantity,
        receivedQty: accepted,
        amountUnderReviewPaise: amount,
        description:
          `${invoice.documentNumber} bills ${inv.quantity} units of ${inv.key}, but ${grn.documentNumber} records ` +
          `${accepted} accepted against ${ordered.quantity} ordered on ${po.documentNumber}. ` +
          `${excess} units (${formatInr(amount)} before GST) are under review.`,
        recommendedAction: `Request a revised invoice for ${billable} units, or proof of delivery for the remaining ${excess}.`,
        evidenceRefs: [ref(po, `items[${ordered.index}].quantity`), invRefs("quantity"), grnRef],
      });
    }

    if (invPrice > poPrice) {
      const amount = (invPrice - poPrice) * inv.quantity;
      out.push({
        issueType: "PRICE",
        lineRef: inv.key,
        orderedQty: ordered.quantity,
        invoicedQty: inv.quantity,
        receivedQty: accepted,
        amountUnderReviewPaise: amount,
        description:
          `${invoice.documentNumber} prices ${inv.key} at ${formatInr(invPrice)} per unit; ${po.documentNumber} agreed ` +
          `${formatInr(poPrice)}. Difference of ${formatInr(amount)} before GST is under review.`,
        recommendedAction: "Request a revised invoice at the PO price, or written authorisation for the new rate.",
        evidenceRefs: [ref(po, `items[${ordered.index}].unitPricePaise`), invRefs("unitPricePaise")],
      });
    }
  }

  return out;
}
