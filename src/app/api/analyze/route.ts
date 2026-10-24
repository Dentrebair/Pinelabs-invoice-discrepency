import { NextResponse } from "next/server";
import { AnalyzeResponse } from "@/lib/contracts";
import { aiMode, runAnalysis } from "@/lib/server/ai";
import { failCase, resolveCase, updateCase } from "@/lib/server/cases";
import { analysisStatus, linkEvidence, replaceDiscrepancies, type CitableDocs } from "@/lib/server/discrepancies";
import { ApiError, errorResponse } from "@/lib/server/errors";
import { recordEvent } from "@/lib/server/events";
import { readForm, readPdfField } from "@/lib/server/pdf";
import { storeDocument, type DocumentRow } from "@/lib/server/storage";
import { db } from "@/lib/server/supabase";

export const runtime = "nodejs";

const FIELDS = [
  ["po", "PO"],
  ["invoice", "INVOICE"],
  ["grn", "GRN"],
] as const;

export async function POST(req: Request) {
  let caseId: string | null = null;
  const documentIds: string[] = [];
  try {
    // 1. Validate everything before touching storage.
    const form = await readForm(req);
    const pdfs = await Promise.all(FIELDS.map(([field]) => readPdfField(form, field)));
    const kase = await resolveCase(form.get("caseId"));
    caseId = kase.id;

    // 2. Persist originals privately.
    await updateCase(kase.id, { status: "ANALYZING" });
    const rows = {} as Record<"PO" | "INVOICE" | "GRN", DocumentRow>;
    for (const [i, [, docType]] of FIELDS.entries()) {
      rows[docType] = await storeDocument(kase.id, docType, pdfs[i]);
      documentIds.push(rows[docType].id);
    }
    await recordEvent(kase.id, "UPLOADED", "USER", "PO, invoice and GRN uploaded", {
      documents: FIELDS.map(([, t]) => ({ docType: t, documentId: rows[t].id, version: rows[t].version })),
    });

    // 3. Dev 2 analysis (validated against shared schemas inside runAnalysis).
    const mode = aiMode();
    const ai = await runAnalysis({ poPdf: pdfs[0].bytes, invoicePdf: pdfs[1].bytes, grnPdf: pdfs[2].bytes });

    const citable: CitableDocs = {};
    for (const [field, docType] of FIELDS) {
      const extracted = ai.extractedDocuments[docType];
      if (extracted.docType !== docType) {
        throw new ApiError(422, "AI_INVALID_OUTPUT", `File in "${field}" was read as ${extracted.docType}, expected ${docType}`);
      }
      citable[docType] = { row: rows[docType], documentNumber: extracted.documentNumber };
    }
    const refs = linkEvidence(ai.discrepancies, citable);
    const status = analysisStatus(ai.discrepancies);

    // 4. Persist results. Discrepancies before status so a partial failure
    // never leaves the case in a success state.
    for (const [, docType] of FIELDS) {
      const extracted = ai.extractedDocuments[docType];
      const { error } = await db()
        .from("documents")
        .update({ extraction_status: "PARSED", extracted_json: extracted, document_number: extracted.documentNumber })
        .eq("id", rows[docType].id);
      if (error) throw new Error(`document update failed: ${error.message}`);
    }
    const discrepancyIds = await replaceDiscrepancies(kase.id, ai.discrepancies, refs);
    await updateCase(kase.id, {
      status,
      investigation_summary: ai.investigationSummary,
      supplier_message_draft: ai.supplierMessageDraft,
      po_number: ai.extractedDocuments.PO.documentNumber,
      invoice_number: ai.extractedDocuments.INVOICE.documentNumber,
    });
    await recordEvent(kase.id, "ANALYSIS_COMPLETED", "AI", `Analysis complete: ${status}`, {
      aiMode: mode,
      status,
      discrepancyCount: discrepancyIds.length,
      amountUnderReviewPaise: ai.discrepancies.reduce((sum, d) => sum + d.amountUnderReviewPaise, 0),
      discrepancyIds,
    });

    const body: AnalyzeResponse = AnalyzeResponse.parse({
      caseId: kase.id,
      caseCode: kase.case_code,
      status,
      discrepancies: ai.discrepancies,
      investigationSummary: ai.investigationSummary,
      supplierMessageDraft: ai.supplierMessageDraft,
    });
    return NextResponse.json(body);
  } catch (err) {
    if (caseId) await failCase(caseId, "analyze", err, documentIds);
    return errorResponse(err, "analyze");
  }
}
