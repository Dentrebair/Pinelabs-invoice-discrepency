import { NextResponse } from "next/server";
import { ExtractedDocument, RevalidateResponse } from "@/lib/contracts";
import { aiMode, runRevalidation } from "@/lib/server/ai";
import { failCase, resolveCase, updateCase } from "@/lib/server/cases";
import {
  linkEvidence,
  replaceUnresolvedDiscrepancies,
  resolveOpenDiscrepancies,
  revalidationStatus,
  type CitableDocs,
} from "@/lib/server/discrepancies";
import { ApiError, assertUuid, errorResponse } from "@/lib/server/errors";
import { recordEvent } from "@/lib/server/events";
import { readForm, readPdfField } from "@/lib/server/pdf";
import { latestDocument, storeDocument, type DocumentRow } from "@/lib/server/storage";
import { db } from "@/lib/server/supabase";
import type { CaseStatus } from "@/lib/server/types";

export const runtime = "nodejs";

// Revalidation only makes sense once an analysis has produced findings.
// ERROR is included so a transient AI/network failure during revalidation can be retried with the same
// originals; loadParsedOriginals still requires a completed analysis.
const REVALIDATABLE: CaseStatus[] = ["DISCREPANCY_FOUND", "AWAITING_APPROVAL", "AWAITING_SUPPLIER", "NEEDS_REVIEW", "ERROR"];

export async function POST(req: Request) {
  let caseId: string | null = null;
  const documentIds: string[] = [];
  try {
    const form = await readForm(req);
    const rawId = form.get("caseId");
    if (rawId === null || rawId === "") throw new ApiError(400, "MISSING_CASE_ID", "caseId is required");
    const pdf = await readPdfField(form, "revisedInvoice");
    const kase = await resolveCase(assertUuid(rawId, "caseId"));

    if (!REVALIDATABLE.includes(kase.status)) {
      throw new ApiError(409, "CASE_NOT_READY", `Case status ${kase.status} cannot be revalidated`);
    }
    const originals = await loadParsedOriginals(kase.id);
    caseId = kase.id;

    await updateCase(kase.id, { status: "REVALIDATING" });
    // Stored as a new REVISED_INVOICE version; the original INVOICE is untouched.
    const revised = await storeDocument(kase.id, "REVISED_INVOICE", pdf);
    documentIds.push(revised.id);
    await recordEvent(kase.id, "UPLOADED", "SUPPLIER", "Revised invoice uploaded", {
      documents: [{ docType: "REVISED_INVOICE", documentId: revised.id, version: revised.version }],
    });

    const mode = aiMode();
    const ai = await runRevalidation({
      originalDocuments: {
        PO: originals.PO.extracted,
        INVOICE: originals.INVOICE.extracted,
        GRN: originals.GRN.extracted,
      },
      revisedInvoicePdf: pdf.bytes,
    });

    const citable: CitableDocs = {
      PO: { row: originals.PO.row, documentNumber: originals.PO.extracted.documentNumber },
      INVOICE: { row: originals.INVOICE.row, documentNumber: originals.INVOICE.extracted.documentNumber },
      GRN: { row: originals.GRN.row, documentNumber: originals.GRN.extracted.documentNumber },
      REVISED_INVOICE: { row: revised, documentNumber: ai.extractedRevisedInvoice.documentNumber },
    };
    const refs = linkEvidence(ai.discrepancies, citable);
    const status = revalidationStatus(ai.status, ai.discrepancies);

    const { error } = await db()
      .from("documents")
      .update({
        extraction_status: "PARSED",
        extracted_json: ai.extractedRevisedInvoice,
        document_number: ai.extractedRevisedInvoice.documentNumber,
      })
      .eq("id", revised.id);
    if (error) throw new Error(`document update failed: ${error.message}`);

    let resolvedCount = 0;
    if (status === "READY_FOR_PAYMENT_APPROVAL") {
      resolvedCount = await resolveOpenDiscrepancies(kase.id);
    } else if (ai.discrepancies.length > 0) {
      await replaceUnresolvedDiscrepancies(kase.id, ai.discrepancies, refs);
    }
    // else: not resolved but nothing concrete to report (e.g. the upload was not an invoice). Keep the
    // existing findings so the reviewer does not lose the evidence they were working from.
    await updateCase(kase.id, { status });

    await recordEvent(kase.id, "REVALIDATED", "AI", `Revalidation complete: ${status}`, {
      aiMode: mode,
      proposedStatus: ai.status,
      status,
      revisedDocumentId: revised.id,
      resolvedCount,
      outstandingCount: ai.discrepancies.length,
    });

    const body: RevalidateResponse = RevalidateResponse.parse({
      caseId: kase.id,
      caseCode: kase.case_code,
      status,
      discrepancies: ai.discrepancies,
      explanation: ai.explanation,
    });
    return NextResponse.json(body);
  } catch (err) {
    if (caseId) await failCase(caseId, "revalidate", err, documentIds);
    return errorResponse(err, "revalidate");
  }
}

type Parsed = { row: DocumentRow; extracted: ExtractedDocument };

async function loadParsedOriginals(caseId: string): Promise<Record<"PO" | "INVOICE" | "GRN", Parsed>> {
  const out = {} as Record<"PO" | "INVOICE" | "GRN", Parsed>;
  for (const docType of ["PO", "INVOICE", "GRN"] as const) {
    const row = await latestDocument(caseId, docType);
    const extracted = row?.extraction_status === "PARSED" ? ExtractedDocument.safeParse(row.extracted_json) : null;
    if (!row || !extracted?.success) {
      throw new ApiError(409, "CASE_NOT_READY", `No analysed ${docType} on this case; run /api/analyze first`);
    }
    out[docType] = { row, extracted: extracted.data };
  }
  return out;
}
