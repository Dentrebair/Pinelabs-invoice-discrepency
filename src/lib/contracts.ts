// ⚠️ PLACEHOLDER — replace with the shared foundation file 03_contracts.ts.
// Written by Dev 3 from the build guide's field list because 03_contracts.ts
// was not available. Field names follow the guide; reconcile before merge.
import { z } from "zod";

// Mirrors the cases.status check constraint in 01_schema.sql.
export const CaseStatus = z.enum([
  "DRAFT",
  "ANALYZING",
  "NO_DISCREPANCY",
  "DISCREPANCY_FOUND",
  "AWAITING_APPROVAL",
  "AWAITING_SUPPLIER",
  "REVALIDATING",
  "READY_FOR_PAYMENT_APPROVAL",
  "NEEDS_REVIEW",
  "ERROR",
]);
export type CaseStatus = z.infer<typeof CaseStatus>;

export const DocType = z.enum(["PO", "INVOICE", "GRN", "REVISED_INVOICE", "OTHER"]);
export type DocType = z.infer<typeof DocType>;

export const IssueType = z.enum(["QUANTITY", "PRICE", "DUPLICATE", "MISSING_DOCUMENT", "TAX", "OTHER"]);
export type IssueType = z.infer<typeof IssueType>;

export const DiscrepancyStatus = z.enum(["OPEN", "RESOLVED", "NEEDS_REVIEW"]);
export type DiscrepancyStatus = z.infer<typeof DiscrepancyStatus>;

export const EvidenceRef = z.object({
  docType: DocType,
  documentId: z.string().uuid().optional(), // filled in by the backend
  documentNumber: z.string().optional(),
  field: z.string().optional(),
  value: z.string().optional(),
  page: z.number().int().positive().optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

// Monetary values are integer paise.
const Paise = z.number().int().nonnegative();
const Qty = z.number().nonnegative();

export const Discrepancy = z.object({
  id: z.string().uuid().optional(),
  issueType: IssueType,
  lineRef: z.string().nullable().optional(),
  orderedQty: Qty.nullable().optional(),
  invoicedQty: Qty.nullable().optional(),
  receivedQty: Qty.nullable().optional(),
  poUnitPricePaise: Paise.nullable().optional(),
  invoiceUnitPricePaise: Paise.nullable().optional(),
  amountUnderReviewPaise: Paise,
  description: z.string().min(1),
  recommendedAction: z.string().nullable().optional(),
  evidenceRefs: z.array(EvidenceRef),
  status: DiscrepancyStatus.default("OPEN"),
});
export type Discrepancy = z.infer<typeof Discrepancy>;

export const AnalyzeResponse = z.object({
  caseId: z.string().uuid(),
  caseCode: z.string(),
  status: CaseStatus,
  discrepancies: z.array(Discrepancy),
  investigationSummary: z.string(),
  supplierMessageDraft: z.string(),
});
export type AnalyzeResponse = z.infer<typeof AnalyzeResponse>;

export const RevalidateResponse = z.object({
  caseId: z.string().uuid(),
  caseCode: z.string(),
  status: CaseStatus,
  discrepancies: z.array(Discrepancy),
  explanation: z.string(),
});
export type RevalidateResponse = z.infer<typeof RevalidateResponse>;

export const ErrorResponse = z.object({
  error: z.string(),
  code: z.string(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
