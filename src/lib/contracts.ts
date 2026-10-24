// Shared TypeScript data/API contract. Copy into src/lib/contracts.ts.
// All currency amounts are INTEGER PAISE (not floating-point rupees).
import { z } from 'zod';
export const DocumentType = z.enum(['PO', 'INVOICE', 'GRN', 'REVISED_INVOICE']);
export const CaseStatus = z.enum([
  'DRAFT', 'ANALYZING', 'NO_DISCREPANCY', 'DISCREPANCY_FOUND',
  'AWAITING_APPROVAL', 'AWAITING_SUPPLIER', 'REVALIDATING',
  'READY_FOR_PAYMENT_APPROVAL', 'NEEDS_REVIEW', 'ERROR'
]);
export const LineItem = z.object({
  lineRef: z.string().optional(),
  sku: z.string().optional(),
  description: z.string(),
  unit: z.string().default('carton'),
  quantity: z.number().int().nonnegative(), // MVP test cases use whole cartons
  unitPricePaise: z.number().int().nonnegative().nullable(), // null for GRN
  gstRatePercent: z.number().nonnegative().max(100).optional()
});
export const ExtractedDocument = z.object({
  docType: DocumentType,
  documentNumber: z.string(),
  supplierCode: z.string().nullable(),
  poNumber: z.string().nullable(),
  currency: z.literal('INR'),
  items: z.array(LineItem).min(1),
  notes: z.string().optional()
});
export type ExtractedDocument = z.infer<typeof ExtractedDocument>;
export const Discrepancy = z.object({
  issueType: z.enum(['QUANTITY','PRICE','DUPLICATE','MISSING_DOCUMENT','TAX','OTHER']),
  lineRef: z.string().nullable(),
  orderedQty: z.number().nullable(),
  invoicedQty: z.number().nullable(),
  receivedQty: z.number().nullable(),
  amountUnderReviewPaise: z.number().int().nonnegative(),
  description: z.string(),
  recommendedAction: z.string(),
  evidenceRefs: z.array(z.object({
    docType: DocumentType,
    documentNumber: z.string(),
    field: z.string()
  }))
});
export const AnalyzeResponse = z.object({
  caseId: z.string(), // UUID; caseCode provides the human-readable ID
  caseCode: z.string(),
  status: CaseStatus,
  discrepancies: z.array(Discrepancy),
  investigationSummary: z.string(),
  supplierMessageDraft: z.string().nullable()
});
export type AnalyzeResponse = z.infer<typeof AnalyzeResponse>;
export const RevalidateResponse = z.object({
  caseId: z.string(),
  caseCode: z.string(),
  status: CaseStatus,
  discrepancies: z.array(Discrepancy),
  explanation: z.string()
});
export type RevalidateResponse = z.infer<typeof RevalidateResponse>;
// HTTP contracts:
// POST /api/analyze (multipart/form-data): { caseId?: UUID, po: PDF, invoice: PDF, grn: PDF }
//   -> AnalyzeResponse
// POST /api/revalidate (multipart/form-data): { caseId: UUID, revisedInvoice: PDF }
//   -> RevalidateResponse
// GET  /api/cases/[id] -> saved AnalyzeResponse + document metadata + events
// Security: these are SERVER routes. Do not call Supabase with service_role from client.
