import "server-only";
import type { z } from "zod";
import type { Discrepancy as DiscrepancySchema, ExtractedDocument } from "@/lib/contracts";
import { matchDocuments } from "@/lib/validation/match-documents";

type Discrepancy = z.infer<typeof DiscrepancySchema>;

// Deterministic three-way match (PO / invoice / GRN): plain code, no model, integer paise.
// The rules live in src/lib/validation/match-documents.ts (unit-tested, no server-only import).
// Unresolvable cases (missing price, unit/SKU/PO/supplier mismatch, duplicates, tax) come back as
// discrepancies, never as exceptions, so the backend can mark the case NEEDS_REVIEW.
export function threeWayMatch(po: ExtractedDocument, invoice: ExtractedDocument, grn: ExtractedDocument): Discrepancy[] {
  return matchDocuments({ po, invoice, grn }).discrepancies;
}

export { statusFor } from "@/lib/validation/match-documents";

export const formatInr = (paise: number) =>
  `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
