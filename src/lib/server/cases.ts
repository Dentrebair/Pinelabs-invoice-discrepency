import "server-only";
import type { CaseStatus } from "@/lib/contracts";
import { ApiError, assertUuid } from "./errors";
import { recordEvent } from "./events";
import { db } from "./supabase";

export const DEMO_CASE_CODE = "SR-001";

export type CaseRow = {
  id: string;
  case_code: string;
  supplier_id: string;
  po_number: string | null;
  invoice_number: string | null;
  status: CaseStatus;
  currency: "INR";
  investigation_summary: string | null;
  supplier_message_draft: string | null;
  created_at: string;
  updated_at: string;
};

// Resolves an existing case by UUID, or the seeded SR-001 demo case when no
// id is given. Never creates cases.
export async function resolveCase(caseId: FormDataEntryValue | null): Promise<CaseRow> {
  const query = db().from("cases").select("*");
  const { data, error } =
    caseId === null || caseId === ""
      ? await query.eq("case_code", DEMO_CASE_CODE).maybeSingle()
      : await query.eq("id", assertUuid(caseId, "caseId")).maybeSingle();
  if (error) throw new Error(`case lookup failed: ${error.message}`);
  if (!data) throw new ApiError(404, "CASE_NOT_FOUND", "Case not found");
  return data as CaseRow;
}

export async function updateCase(
  caseId: string,
  fields: Partial<Pick<CaseRow, "status" | "investigation_summary" | "supplier_message_draft" | "po_number" | "invoice_number">>,
): Promise<void> {
  const { error } = await db().from("cases").update(fields).eq("id", caseId);
  if (error) throw new Error(`case update failed: ${error.message}`);
}

// Records a processing failure without ever reporting success: bad or late AI
// output → NEEDS_REVIEW, anything else → ERROR. Always leaves an audit event.
export async function failCase(caseId: string, stage: string, err: unknown, documentIds: string[] = []): Promise<void> {
  const code = err instanceof ApiError ? err.code : "INTERNAL_ERROR";
  const status: CaseStatus = code === "AI_INVALID_OUTPUT" || code === "AI_TIMEOUT" ? "NEEDS_REVIEW" : "ERROR";
  try {
    await updateCase(caseId, { status });
    if (documentIds.length > 0) {
      await db()
        .from("documents")
        .update({ extraction_status: "FAILED", extraction_error: code })
        .in("id", documentIds)
        .eq("extraction_status", "UPLOADED");
    }
  } catch {
    console.error(`[cases] could not mark case ${caseId} as ${status}`);
  }
  await recordEvent(caseId, "ERROR", "SYSTEM", `${stage} failed: ${code}`, { stage, code, status, documentIds });
}
