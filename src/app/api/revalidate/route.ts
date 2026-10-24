import { NextResponse } from "next/server";
import { RevalidateResponse, type CaseStatus, type DocType } from "@/lib/contracts";
import { aiMode, ExtractedDocument, runRevalidation } from "@/lib/server/ai";
import { failCase, resolveCase, updateCase } from "@/lib/server/cases";
import {
  attachEvidence,
  listDiscrepancies,
  replaceUnresolvedDiscrepancies,
  resolveOpenDiscrepancies,
  revalidationStatus,
} from "@/lib/server/discrepancies";
import { ApiError, assertUuid, errorResponse } from "@/lib/server/errors";
import { recordEvent } from "@/lib/server/events";
import { readForm, readPdfField } from "@/lib/server/pdf";
import { latestDocument, storeDocument, type DocumentRow } from "@/lib/server/storage";
import { db } from "@/lib/server/supabase";

export const runtime = "nodejs";

// Revalidation only makes sense once an analysis has produced findings.
const REVALIDATABLE: CaseStatus[] = ["DISCREPANCY_FOUND", "AWAITING_APPROVAL", "AWAITING_SUPPLIER", "NEEDS_REVIEW"];

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
    const docs: Partial<Record<DocType, DocumentRow>> = {
      PO: originals.PO.row,
      INVOICE: originals.INVOICE.row,
      GRN: originals.GRN.row,
      REVISED_INVOICE: revised,
    };
    const findings = attachEvidence(ai.discrepancies, docs);
    const status = revalidationStatus(ai.status, findings);

    const { error } = await db()
      .from("documents")
      .update({
        extraction_status: "PARSED",
        extracted_json: ai.extractedRevisedInvoice,
        document_number: ai.extractedRevisedInvoice.documentNumber ?? null,
      })
      .eq("id", revised.id);
    if (error) throw new Error(`document update failed: ${error.message}`);

    let resolvedCount = 0;
    if (status === "READY_FOR_PAYMENT_APPROVAL") {
      resolvedCount = await resolveOpenDiscrepancies(kase.id);
    } else {
      await replaceUnresolvedDiscrepancies(kase.id, findings);
    }
    await updateCase(kase.id, { status });
    const discrepancies = await listDiscrepancies(kase.id);

    await recordEvent(kase.id, "REVALIDATED", "AI", `Revalidation complete: ${status}`, {
      aiMode: mode,
      proposedStatus: ai.status,
      status,
      revisedDocumentId: revised.id,
      resolvedCount,
      openCount: discrepancies.filter((d) => d.status !== "RESOLVED").length,
    });

    const body: RevalidateResponse = RevalidateResponse.parse({
      caseId: kase.id,
      caseCode: kase.case_code,
      status,
      discrepancies,
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
