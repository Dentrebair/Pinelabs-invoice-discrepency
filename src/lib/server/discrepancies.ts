import "server-only";
import { ApiError } from "./errors";
import type { DocumentRow } from "./storage";
import { db } from "./supabase";
import type { CaseStatus, Discrepancy, DocumentType, EvidenceRef } from "./types";

type RowStatus = "OPEN" | "RESOLVED" | "NEEDS_REVIEW";
type StoredRef = EvidenceRef & { documentId: string };

type DiscrepancyRow = {
  id: string;
  case_id: string;
  issue_type: Discrepancy["issueType"];
  line_ref: string | null;
  ordered_qty: string | number | null;
  invoiced_qty: string | number | null;
  received_qty: string | number | null;
  amount_under_review_paise: string | number;
  description: string;
  recommended_action: string | null;
  evidence_refs: StoredRef[];
  status: RowStatus;
  created_at: string;
};

// Documents a finding may cite: the stored row plus the number the AI extracted.
export type CitableDocs = Partial<Record<DocumentType, { row: DocumentRow; documentNumber: string }>>;

const norm = (s: string) => s.trim().toUpperCase();

// Every evidence ref must cite a document stored on this case by its extracted
// document number. Returns the refs with the internal documentId attached for
// storage; anything else is treated as invalid AI output.
export function linkEvidence(discrepancies: Discrepancy[], docs: CitableDocs): StoredRef[][] {
  return discrepancies.map((d) =>
    d.evidenceRefs.map((ref) => {
      const doc = docs[ref.docType];
      if (!doc || norm(doc.documentNumber) !== norm(ref.documentNumber)) {
        throw new ApiError(422, "AI_INVALID_OUTPUT", `AI cited ${ref.docType} ${ref.documentNumber}, which is not on this case`);
      }
      return { ...ref, documentId: doc.row.id };
    }),
  );
}

// Initial analysis status. Findings without evidence go to NEEDS_REVIEW rather
// than being presented as a confirmed discrepancy.
export function analysisStatus(discrepancies: Discrepancy[]): CaseStatus {
  if (discrepancies.some((d) => d.evidenceRefs.length === 0)) return "NEEDS_REVIEW";
  return discrepancies.length > 0 ? "DISCREPANCY_FOUND" : "NO_DISCREPANCY";
}

const REVALIDATION_STATUSES: CaseStatus[] = [
  "READY_FOR_PAYMENT_APPROVAL",
  "DISCREPANCY_FOUND",
  "AWAITING_SUPPLIER",
  "NEEDS_REVIEW",
];

// Guards the AI's proposed status. Revalidation discrepancies are the issues
// still outstanding, so READY_FOR_PAYMENT_APPROVAL requires an empty list.
// It is a case status, never a payment approval or payout.
export function revalidationStatus(proposed: CaseStatus, outstanding: Discrepancy[]): CaseStatus {
  if (!REVALIDATION_STATUSES.includes(proposed)) return "NEEDS_REVIEW";
  if (proposed === "READY_FOR_PAYMENT_APPROVAL" && outstanding.length > 0) return "NEEDS_REVIEW";
  if (outstanding.some((d) => d.evidenceRefs.length === 0)) return "NEEDS_REVIEW";
  return proposed;
}

const num = (v: string | number | null) => (v === null ? null : Number(v));

// Contract shape: internal ids and statuses are not part of Discrepancy.
function fromRow(r: DiscrepancyRow): Discrepancy {
  return {
    issueType: r.issue_type,
    lineRef: r.line_ref,
    orderedQty: num(r.ordered_qty),
    invoicedQty: num(r.invoiced_qty),
    receivedQty: num(r.received_qty),
    amountUnderReviewPaise: Number(r.amount_under_review_paise),
    description: r.description,
    recommendedAction: r.recommended_action ?? "",
    evidenceRefs: r.evidence_refs.map(({ docType, documentNumber, field }) => ({ docType, documentNumber, field })),
  };
}

async function insertDiscrepancies(caseId: string, discrepancies: Discrepancy[], refs: StoredRef[][]): Promise<string[]> {
  if (discrepancies.length === 0) return [];
  const rows = discrepancies.map((d, i) => ({
    case_id: caseId,
    issue_type: d.issueType,
    line_ref: d.lineRef,
    ordered_qty: d.orderedQty,
    invoiced_qty: d.invoicedQty,
    received_qty: d.receivedQty,
    amount_under_review_paise: d.amountUnderReviewPaise,
    description: d.description,
    recommended_action: d.recommendedAction,
    evidence_refs: refs[i],
    status: (d.evidenceRefs.length === 0 ? "NEEDS_REVIEW" : "OPEN") satisfies RowStatus,
  }));
  const { data, error } = await db().from("discrepancies").insert(rows).select("id");
  if (error) throw new Error(`discrepancy insert failed: ${error.message}`);
  return data.map((r) => r.id as string);
}

// A fresh analysis supersedes previous findings; history stays in case_events.
export async function replaceDiscrepancies(caseId: string, discrepancies: Discrepancy[], refs: StoredRef[][]): Promise<string[]> {
  const { error } = await db().from("discrepancies").delete().eq("case_id", caseId);
  if (error) throw new Error(`discrepancy reset failed: ${error.message}`);
  return insertDiscrepancies(caseId, discrepancies, refs);
}

// Revalidation that does not clear the case: unresolved findings are replaced
// by the latest outstanding ones; RESOLVED history is kept.
export async function replaceUnresolvedDiscrepancies(caseId: string, outstanding: Discrepancy[], refs: StoredRef[][]): Promise<void> {
  const { error } = await db().from("discrepancies").delete().eq("case_id", caseId).neq("status", "RESOLVED");
  if (error) throw new Error(`discrepancy reset failed: ${error.message}`);
  await insertDiscrepancies(caseId, outstanding, refs);
}

export async function resolveOpenDiscrepancies(caseId: string): Promise<number> {
  const { data, error } = await db()
    .from("discrepancies")
    .update({ status: "RESOLVED" })
    .eq("case_id", caseId)
    .neq("status", "RESOLVED")
    .select("id");
  if (error) throw new Error(`discrepancy resolve failed: ${error.message}`);
  return data?.length ?? 0;
}

export async function listDiscrepancies(caseId: string): Promise<{ outstanding: Discrepancy[]; resolved: Discrepancy[] }> {
  const { data, error } = await db()
    .from("discrepancies")
    .select("*")
    .eq("case_id", caseId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`discrepancy lookup failed: ${error.message}`);
  const rows = data as DiscrepancyRow[];
  return {
    outstanding: rows.filter((r) => r.status !== "RESOLVED").map(fromRow),
    resolved: rows.filter((r) => r.status === "RESOLVED").map(fromRow),
  };
}
