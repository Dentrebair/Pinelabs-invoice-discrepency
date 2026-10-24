import "server-only";
import type { z } from "zod";
import type { CaseStatus as CaseStatusSchema, Discrepancy as DiscrepancySchema, DocumentType as DocumentTypeSchema } from "@/lib/contracts";

// Inferred types the shared contract does not export.
export type CaseStatus = z.infer<typeof CaseStatusSchema>;
export type Discrepancy = z.infer<typeof DiscrepancySchema>;
export type DocumentType = z.infer<typeof DocumentTypeSchema>;
export type EvidenceRef = Discrepancy["evidenceRefs"][number];

export type ErrorResponse = { error: string; code: string };
