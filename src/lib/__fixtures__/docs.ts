import { ExtractedDocument } from '../contracts';

type Over = Partial<ExtractedDocument> & { qty?: number; price?: number | null; sku?: string; unit?: string; desc?: string };

/** Build a one-line document: defaults model PO-1001 / INV-1001 / GRN-1001 for ₹500/carton. */
export function doc(docType: ExtractedDocument['docType'], documentNumber: string, o: Over = {}): ExtractedDocument {
  const { qty = 100, price = 50000, sku, unit = 'carton', desc = 'Corrugated shipping box', ...rest } = o;
  return ExtractedDocument.parse({
    docType, documentNumber,
    supplierCode: 'SUP-001',
    poNumber: docType === 'PO' ? documentNumber : 'PO-1001',
    currency: 'INR',
    items: [{ description: desc, unit, quantity: qty, unitPricePaise: price, ...(sku ? { sku } : {}) }],
    ...rest,
  });
}

export const po = (o?: Over) => doc('PO', 'PO-1001', o);
export const invoice = (o?: Over) => doc('INVOICE', 'INV-1001', o);
export const revised = (o?: Over) => doc('REVISED_INVOICE', 'INV-1001-R1', o);
export const grn = (o?: Over) => doc('GRN', 'GRN-1001', { price: null, ...o });
