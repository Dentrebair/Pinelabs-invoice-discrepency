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
