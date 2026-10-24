import { describe, expect, it } from 'vitest';
import { matchDocuments } from './match-documents';
import { grn, invoice, po, revised } from '../__fixtures__/docs';

describe('matchDocuments', () => {
  it('100 ordered / 100 invoiced / 80 received at ₹500: 20 cartons, 1,000,000 paise', () => {
    const r = matchDocuments({ po: po(), invoice: invoice(), grn: grn({ qty: 80 }) });
    expect(r.status).toBe('DISCREPANCY_FOUND');
    expect(r.discrepancies).toHaveLength(1);
    const d = r.discrepancies[0];
    expect(d).toMatchObject({
      issueType: 'QUANTITY', orderedQty: 100, invoicedQty: 100, receivedQty: 80,
      amountUnderReviewPaise: 1_000_000,
    });
    expect(d.description).toContain('partial delivery');
    expect(d.description).not.toMatch(/fraud/i);
    expect(d.evidenceRefs).toEqual(expect.arrayContaining([
      { docType: 'INVOICE', documentNumber: 'INV-1001', field: 'items[0].quantity' },
      { docType: 'GRN', documentNumber: 'GRN-1001', field: 'items[0].quantity' },
      { docType: 'PO', documentNumber: 'PO-1001', field: 'items[0].quantity' },
    ]));
  });

  it('everything agrees: no discrepancy', () => {
    const r = matchDocuments({ po: po(), invoice: invoice(), grn: grn() });
    expect(r).toEqual({ discrepancies: [], status: 'NO_DISCREPANCY' });
  });

  it('revised 80 at same rate with GRN 80: no remaining discrepancy (under-invoicing vs PO is fine)', () => {
    const r = matchDocuments({ po: po(), invoice: revised({ qty: 80 }), grn: grn({ qty: 80 }) });
    expect(r.discrepancies).toEqual([]);
    expect(r.status).toBe('NO_DISCREPANCY');
  });

  it('invoiced above PO is not blamed on partial delivery', () => {
    const r = matchDocuments({ po: po({ qty: 80 }), invoice: invoice({ qty: 100 }), grn: grn({ qty: 100 }) });
    expect(r.discrepancies[0]).toMatchObject({ issueType: 'QUANTITY', amountUnderReviewPaise: 1_000_000 });
    expect(r.discrepancies[0].description).not.toContain('partial delivery');
  });

  it('wrong invoice price: PRICE discrepancy in integer paise, needs review', () => {
    const r = matchDocuments({ po: po(), invoice: invoice({ price: 55050 }), grn: grn() });
    expect(r.status).toBe('NEEDS_REVIEW');
    expect(r.discrepancies).toHaveLength(1);
    expect(r.discrepancies[0]).toMatchObject({ issueType: 'PRICE', amountUnderReviewPaise: 5050 * 100 });
    expect(r.discrepancies[0].evidenceRefs.map((e) => e.field)).toEqual(['items[0].unitPricePaise', 'items[0].unitPricePaise']);
  });

  it('revised invoice with a changed rate is not silently accepted', () => {
    const r = matchDocuments({ po: po(), invoice: revised({ qty: 80, price: 52000 }), grn: grn({ qty: 80 }) });
    expect(r.status).toBe('NEEDS_REVIEW');
    expect(r.discrepancies[0].issueType).toBe('PRICE');
    expect(r.discrepancies[0].amountUnderReviewPaise).toBe(2000 * 80);
  });

  it('PO reference mismatch: NEEDS_REVIEW and lines are not joined', () => {
    const r = matchDocuments({ po: po(), invoice: invoice({ poNumber: 'PO-9999' }), grn: grn({ qty: 80 }) });
    expect(r.status).toBe('NEEDS_REVIEW');
    expect(r.discrepancies[0].description).toContain('PO-9999');
  });

  it('missing PO reference on invoice: NEEDS_REVIEW', () => {
    const r = matchDocuments({ po: po(), invoice: invoice({ poNumber: null }), grn: grn() });
    expect(r.status).toBe('NEEDS_REVIEW');
  });

  it('supplier mismatch: NEEDS_REVIEW; supplier ignored when absent', () => {
    expect(matchDocuments({ po: po(), invoice: invoice({ supplierCode: 'SUP-002' }), grn: grn() }).status).toBe('NEEDS_REVIEW');
    expect(matchDocuments({ po: po(), invoice: invoice({ supplierCode: null }), grn: grn() }).status).toBe('NO_DISCREPANCY');
  });

  it('SKU mismatch: NEEDS_REVIEW, never matched by description', () => {
    const r = matchDocuments({ po: po({ sku: 'BOX-A' }), invoice: invoice({ sku: 'BOX-B' }), grn: grn({ sku: 'BOX-A' }) });
    expect(r.status).toBe('NEEDS_REVIEW');
    expect(r.discrepancies.every((d) => d.issueType === 'OTHER')).toBe(true);
  });

  it('different description and no SKU: ambiguous -> NEEDS_REVIEW', () => {
    const r = matchDocuments({ po: po(), invoice: invoice({ desc: 'Bubble wrap roll' }), grn: grn() });
    expect(r.status).toBe('NEEDS_REVIEW');
  });

  it('unit mismatch: NEEDS_REVIEW; carton aliases are compatible', () => {
    const bad = matchDocuments({ po: po(), invoice: invoice({ unit: 'pallet' }), grn: grn() });
    expect(bad.status).toBe('NEEDS_REVIEW');
    expect(bad.discrepancies[0].description).toContain('Units differ');
    expect(matchDocuments({ po: po(), invoice: invoice({ unit: 'Cartons' }), grn: grn({ unit: 'CTN' }) }).status).toBe('NO_DISCREPANCY');
  });

  it('missing price: NEEDS_REVIEW, never treated as zero', () => {
    const r = matchDocuments({ po: po(), invoice: invoice({ price: null }), grn: grn({ qty: 80 }) });
    expect(r.status).toBe('NEEDS_REVIEW');
    expect(r.discrepancies[0].description).toContain('price missing');
    expect(r.discrepancies.some((d) => d.issueType === 'QUANTITY')).toBe(false);
  });

  it('duplicate invoice lines: DUPLICATE, NEEDS_REVIEW', () => {
    const inv = invoice();
    inv.items.push({ ...inv.items[0] });
    const r = matchDocuments({ po: po(), invoice: inv, grn: grn() });
    expect(r.discrepancies[0].issueType).toBe('DUPLICATE');
    expect(r.status).toBe('NEEDS_REVIEW');
  });

  it('GST rate difference: TAX, NEEDS_REVIEW, integer paise', () => {
    const p = po(); p.items[0].gstRatePercent = 12;
    const i = invoice(); i.items[0].gstRatePercent = 18;
    const r = matchDocuments({ po: p, invoice: i, grn: grn() });
    expect(r.discrepancies[0]).toMatchObject({ issueType: 'TAX', amountUnderReviewPaise: 300_000 });
    expect(r.status).toBe('NEEDS_REVIEW');
  });

  it('invoice line absent from PO: NEEDS_REVIEW', () => {
    const inv = invoice();
    inv.items.push({ description: 'Tape', unit: 'carton', quantity: 5, unitPricePaise: 100 });
    expect(matchDocuments({ po: po(), invoice: inv, grn: grn() }).status).toBe('NEEDS_REVIEW');
  });
});

describe('matchDocuments: edge cases', () => {
  const two = (a: number, b: number, price = 50000) => ({
    items: [
      { sku: 'A', description: 'Box A', unit: 'carton', quantity: a, unitPricePaise: price },
      { sku: 'B', description: 'Box B', unit: 'carton', quantity: b, unitPricePaise: 20000 },
    ],
  });
  const grnTwo = (a: number, b: number) => ({
    items: [
      { sku: 'A', description: 'Box A', unit: 'carton', quantity: a, unitPricePaise: null },
      { sku: 'B', description: 'Box B', unit: 'carton', quantity: b, unitPricePaise: null },
    ],
  });

  it('multi-line: only the short line is flagged, with the right line index in evidence', () => {
    const r = matchDocuments({ po: { ...po(), ...two(10, 10) }, invoice: { ...invoice(), ...two(10, 10) }, grn: { ...grn(), ...grnTwo(10, 7) } });
    expect(r.discrepancies).toHaveLength(1);
    expect(r.discrepancies[0]).toMatchObject({ issueType: 'QUANTITY', lineRef: 'B', amountUnderReviewPaise: 3 * 20000 });
    expect(r.discrepancies[0].evidenceRefs.map((e) => e.field)).toEqual(['items[1].quantity', 'items[1].quantity', 'items[1].quantity']);
  });

  it('lines in a different order across documents still match by SKU', () => {
    const inv = { ...invoice(), items: [...two(10, 10).items].reverse() };
    const r = matchDocuments({ po: { ...po(), ...two(10, 10) }, invoice: inv, grn: { ...grn(), ...grnTwo(10, 10) } });
    expect(r).toEqual({ discrepancies: [], status: 'NO_DISCREPANCY' });
  });

  it('duplicate invoice lines produce exactly one DUPLICATE finding (no extra "unmatched line" noise)', () => {
    const inv = invoice();
    inv.items.push({ ...inv.items[0] });
    const r = matchDocuments({ po: po(), invoice: inv, grn: grn() });
    expect(r.discrepancies.map((d) => d.issueType)).toEqual(['DUPLICATE']);
  });

  it('duplicate GRN lines produce exactly one DUPLICATE finding', () => {
    const g = grn();
    g.items.push({ ...g.items[0] });
    expect(matchDocuments({ po: po(), invoice: invoice(), grn: g }).discrepancies.map((d) => d.issueType)).toEqual(['DUPLICATE']);
  });

  it('GRN without a PO reference cannot be tied to the PO: NEEDS_REVIEW', () => {
    const r = matchDocuments({ po: po(), invoice: invoice(), grn: grn({ poNumber: null }) });
    expect(r.status).toBe('NEEDS_REVIEW');
  });

  it('PO reference comparison ignores case and surrounding whitespace', () => {
    const r = matchDocuments({ po: po(), invoice: invoice({ poNumber: ' po-1001 ' }), grn: grn() });
    expect(r.status).toBe('NO_DISCREPANCY');
  });

  it('invoiced line missing from the GRN: NEEDS_REVIEW, not silently zero received', () => {
    const g = grn({ desc: 'Something else' });
    const r = matchDocuments({ po: po(), invoice: invoice(), grn: g });
    expect(r.status).toBe('NEEDS_REVIEW');
  });

  it('over-delivery (GRN > PO) with invoice at PO quantity is fine', () => {
    expect(matchDocuments({ po: po(), invoice: invoice(), grn: grn({ qty: 120 }) }).status).toBe('NO_DISCREPANCY');
  });

  it('nothing received: whole invoice is under review', () => {
    const r = matchDocuments({ po: po(), invoice: invoice(), grn: grn({ qty: 0 }) });
    expect(r.discrepancies[0]).toMatchObject({ issueType: 'QUANTITY', receivedQty: 0, amountUnderReviewPaise: 100 * 50000 });
  });

  it('large amounts stay exact integers', () => {
    const r = matchDocuments({ po: po({ qty: 1_000_000, price: 999_999_99 }), invoice: invoice({ qty: 1_000_000, price: 999_999_99 }), grn: grn({ qty: 999_999 }) });
    expect(r.discrepancies[0].amountUnderReviewPaise).toBe(99_999_999);
    expect(Number.isInteger(r.discrepancies[0].amountUnderReviewPaise)).toBe(true);
  });

  it('every finding carries evidence and integer paise', () => {
    const cases = [
      matchDocuments({ po: po(), invoice: invoice(), grn: grn({ qty: 80 }) }),
      matchDocuments({ po: po(), invoice: invoice({ price: 51000 }), grn: grn() }),
      matchDocuments({ po: po(), invoice: invoice({ poNumber: 'PO-2' }), grn: grn() }),
      matchDocuments({ po: po(), invoice: invoice({ unit: 'pallet' }), grn: grn() }),
    ];
    for (const d of cases.flatMap((c) => c.discrepancies)) {
      expect(d.evidenceRefs.length).toBeGreaterThan(0);
      expect(Number.isInteger(d.amountUnderReviewPaise)).toBe(true);
    }
  });
});
