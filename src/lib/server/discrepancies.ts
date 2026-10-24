import "server-only";
import type { CaseStatus, Discrepancy, DocType } from "@/lib/contracts";
import { ApiError } from "./errors";
import type { DocumentRow } from "./storage";
import { db } from "./supabase";

type DiscrepancyRow = {
  id: string;
  case_id: string;
  issue_type: Discrepancy["issueType"];
  line_ref: string | null;
  ordered_qty: string | number | null;
  invoiced_qty: string | number | null;
  received_qty: string | number | null;
  po_unit_price_paise: string | number | null;
  invoice_unit_price_paise: string | number | null;
  amount_under_review_paise: string | number;
  description: string;
  recommended_action: string | null;
  evidence_refs: Discrepancy["evidenceRefs"];
  status: Discrepancy["status"];
  created_at: string;
};

// Every evidence ref must point at a document stored for this case; the
// backend fills in documentId so refs match documents rows exactly.
export function attachEvidence(
  discrepancies: Discrepancy[],
  docs: Partial<Record<DocType, DocumentRow>>,
): Discrepancy[] {
  return discrepancies.map((d) => ({
    ...d,
    evidenceRefs: d.evidenceRefs.map((ref) => {
      const doc = docs[ref.docType];
      if (!doc) {
        throw new ApiError(422, "AI_INVALID_OUTPUT", `AI cited evidence from a ${ref.docType} that is not on this case`);
      }
      return { ...ref, documentId: doc.id };
    }),
  }));
}

// Initial analysis status. Anything lacking evidence, or flagged by the AI,
// goes to NEEDS_REVIEW rather than a success status.
export function analysisStatus(discrepancies: Discrepancy[]): CaseStatus {
  if (discrepancies.some((d) => d.status === "NEEDS_REVIEW" || d.evidenceRefs.length === 0)) return "NEEDS_REVIEW";
  if (discrepancies.some((d) => d.status === "OPEN")) return "DISCREPANCY_FOUND";
  return "NO_DISCREPANCY";
}

const REVALIDATION_STATUSES: CaseStatus[] = [
  "READY_FOR_PAYMENT_APPROVAL",
  "DISCREPANCY_FOUND",
  "AWAITING_SUPPLIER",
  "NEEDS_REVIEW",
];

// Guards the AI's proposed status: READY_FOR_PAYMENT_APPROVAL only when no
// discrepancy is left unresolved. It is a case status, never a payout.
export function revalidationStatus(proposed: CaseStatus, discrepancies: Discrepancy[]): CaseStatus {
  if (!REVALIDATION_STATUSES.includes(proposed)) return "NEEDS_REVIEW";
  const unresolved = discrepancies.some((d) => d.status !== "RESOLVED");
  if (proposed === "READY_FOR_PAYMENT_APPROVAL" && unresolved) return "NEEDS_REVIEW";
  return proposed;
}

function toRow(caseId: string, d: Discrepancy) {
  return {
    case_id: caseId,
    issue_type: d.issueType,
    line_ref: d.lineRef ?? null,
    ordered_qty: d.orderedQty ?? null,
    invoiced_qty: d.invoicedQty ?? null,
    received_qty: d.receivedQty ?? null,
    po_unit_price_paise: d.poUnitPricePaise ?? null,
    invoice_unit_price_paise: d.invoiceUnitPricePaise ?? null,
    amount_under_review_paise: d.amountUnderReviewPaise,
    description: d.description,
    recommended_action: d.recommendedAction ?? null,
    evidence_refs: d.evidenceRefs,
    status: d.status,
  };
}

const num = (v: string | number | null) => (v === null ? null : Number(v));

export function fromRow(r: DiscrepancyRow): Discrepancy {
  return {
    id: r.id,
    issueType: r.issue_type,
    lineRef: r.line_ref,
    orderedQty: num(r.ordered_qty),
    invoicedQty: num(r.invoiced_qty),
    receivedQty: num(r.received_qty),
    poUnitPricePaise: num(r.po_unit_price_paise),
    invoiceUnitPricePaise: num(r.invoice_unit_price_paise),
    amountUnderReviewPaise: Number(r.amount_under_review_paise),
    description: r.description,
    recommendedAction: r.recommended_action,
    evidenceRefs: r.evidence_refs,
    status: r.status,
  };
}

export async function insertDiscrepancies(caseId: string, discrepancies: Discrepancy[]): Promise<Discrepancy[]> {
  if (discrepancies.length === 0) return [];
  const { data, error } = await db()
    .from("discrepancies")
    .insert(discrepancies.map((d) => toRow(caseId, d)))
    .select();
  if (error) throw new Error(`discrepancy insert failed: ${error.message}`);
  return (data as DiscrepancyRow[]).map(fromRow);
}

// A fresh analysis supersedes previous findings; history stays in case_events.
export async function replaceDiscrepancies(caseId: string, discrepancies: Discrepancy[]): Promise<Discrepancy[]> {
  const { error } = await db().from("discrepancies").delete().eq("case_id", caseId);
  if (error) throw new Error(`discrepancy reset failed: ${error.message}`);
  return insertDiscrepancies(caseId, discrepancies);
}

// Revalidation that does not clear the case: unresolved findings are replaced
// by the latest ones; RESOLVED history is kept.
export async function replaceUnresolvedDiscrepancies(caseId: string, discrepancies: Discrepancy[]): Promise<void> {
  const { error } = await db().from("discrepancies").delete().eq("case_id", caseId).neq("status", "RESOLVED");
  if (error) throw new Error(`discrepancy reset failed: ${error.message}`);
  await insertDiscrepancies(
    caseId,
    discrepancies.filter((d) => d.status !== "RESOLVED"),
  );
}

export async function resolveOpenDiscrepancies(caseId: string): Promise<number> {
  const { data, error } = await db()
    .from("discrepancies")
    .update({ status: "RESOLVED" })
    .eq("case_id", caseId)
    .eq("status", "OPEN")
    .select("id");
  if (error) throw new Error(`discrepancy resolve failed: ${error.message}`);
  return data?.length ?? 0;
}

export async function listDiscrepancies(caseId: string): Promise<Discrepancy[]> {
  const { data, error } = await db()
    .from("discrepancies")
    .select("*")
    .eq("case_id", caseId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`discrepancy lookup failed: ${error.message}`);
  return (data as DiscrepancyRow[]).map(fromRow);
}
