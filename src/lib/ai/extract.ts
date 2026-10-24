import "server-only";
import { z } from "zod";
import { ExtractedDocument } from "@/lib/contracts";
import { AiOutputError, generateJson, pdfPart } from "./gemini";

type DocumentType = z.infer<typeof ExtractedDocument>["docType"];

// What the model returns. Prices stay as printed text and are converted to
// paise in code, so the model never does arithmetic.
const RawExtraction = z.object({
  detectedType: z.enum(["PO", "INVOICE", "GRN", "OTHER"]),
  documentNumber: z.string(),
  supplierCode: z.string().nullable(),
  poNumber: z.string().nullable(),
  currency: z.string(),
  items: z.array(
    z.object({
      lineRef: z.string().nullable(),
      sku: z.string().nullable(),
      description: z.string(),
      unit: z.string().nullable(),
      quantity: z.number().nullable(),
      receivedQuantity: z.number().nullable(),
      acceptedQuantity: z.number().nullable(),
      unitPrice: z.string().nullable(),
      gstRatePercent: z.number().nullable(),
    }),
  ),
  notes: z.string().nullable(),
});

const PROMPT = `You are extracting data from one Indian procurement document (PDF attached).
Return JSON only. Copy values exactly as printed; do not calculate, infer or correct anything.

- detectedType: what this document actually is: "PO" (purchase order), "INVOICE" (tax invoice, including a revised/corrected invoice), "GRN" (goods receipt note), or "OTHER".
- documentNumber: this document's own number (e.g. PO-1001, INV-1001, INV-1001-R1, GRN-1001).
- supplierCode: the supplier code/ID if printed (e.g. SUP-001), else null.
- poNumber: the purchase order this document refers to; for a PO, its own number. Null if absent.
- currency: currency code as printed (e.g. INR).
- items: one entry per line item row (not tax or total rows):
  - lineRef: line/serial number if printed, else null. sku: item code if printed, else null.
  - description, unit (e.g. carton) as printed.
  - quantity: ordered quantity (PO) or billed quantity (invoice). For a GRN use null here.
  - receivedQuantity / acceptedQuantity: GRN only, else null.
  - unitPrice: unit price exactly as printed (e.g. "500.00"), without currency symbols; null if not shown.
  - gstRatePercent: GST % for the line if printed, else null.
- notes: any remark about short delivery, damage, rejection or revision; else null.`;

// Converts a printed rupee amount ("1,000.50", "₹500") to integer paise
// without floating-point arithmetic.
export function toPaise(text: string): number {
  const cleaned = text.replace(/[₹,\s]|INR|Rs\.?/gi, "");
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) throw new AiOutputError(`Unparseable price "${text}"`);
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

function wholeQty(value: number | null, what: string): number {
  if (value === null || !Number.isInteger(value) || value < 0) {
    throw new AiOutputError(`Missing or non-integer ${what}`);
  }
  return value;
}

// Extracts one PDF into the shared ExtractedDocument contract. docType is the
// type the model detected, so a swapped upload is reported rather than hidden;
// an invoice uploaded as the revision is labelled REVISED_INVOICE.
export async function extractDocument(pdf: Buffer, expected: DocumentType): Promise<ExtractedDocument> {
  const raw = await generateJson(RawExtraction, PROMPT, [pdfPart(pdf)]);

  if (raw.detectedType === "OTHER") throw new AiOutputError(`Uploaded ${expected} is not a PO, invoice or GRN`);
  const docType: DocumentType =
    expected === "REVISED_INVOICE" && raw.detectedType === "INVOICE" ? "REVISED_INVOICE" : raw.detectedType;
  if (raw.currency.trim().toUpperCase() !== "INR") throw new AiOutputError(`Unsupported currency ${raw.currency}`);
  if (raw.items.length === 0) throw new AiOutputError(`No line items found in ${raw.documentNumber}`);

  const isGrn = raw.detectedType === "GRN";
  return ExtractedDocument.parse({
    docType,
    documentNumber: raw.documentNumber.trim(),
    supplierCode: raw.supplierCode?.trim() || null,
    poNumber: raw.poNumber?.trim() || null,
    currency: "INR",
    items: raw.items.map((item) => ({
      lineRef: item.lineRef ?? undefined,
      sku: item.sku ?? undefined,
      description: item.description,
      unit: item.unit ?? undefined,
      // For a GRN the billable quantity is what was accepted.
      quantity: isGrn
        ? wholeQty(item.acceptedQuantity ?? item.receivedQuantity, "GRN accepted quantity")
        : wholeQty(item.quantity, "quantity"),
      unitPricePaise: isGrn || item.unitPrice === null ? null : toPaise(item.unitPrice),
      gstRatePercent: item.gstRatePercent ?? undefined,
    })),
    notes: raw.notes ?? undefined,
  });
}
