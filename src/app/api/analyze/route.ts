import { NextResponse } from "next/server";
import { AnalyzeResponse, type DocType } from "@/lib/contracts";
import { aiMode, runAnalysis } from "@/lib/server/ai";
import { failCase, resolveCase, updateCase } from "@/lib/server/cases";
import { analysisStatus, attachEvidence, replaceDiscrepancies } from "@/lib/server/discrepancies";
import { errorResponse } from "@/lib/server/errors";
import { recordEvent } from "@/lib/server/events";
import { readForm, readPdfField } from "@/lib/server/pdf";
import { storeDocument, type DocumentRow } from "@/lib/server/storage";
import { db } from "@/lib/server/supabase";

export const runtime = "nodejs";

const FIELDS: [field: string, docType: DocType][] = [
  ["po", "PO"],
  ["invoice", "INVOICE"],
  ["grn", "GRN"],
];

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
    const docs: Partial<Record<DocType, DocumentRow>> = {};
    for (const [i, [, docType]] of FIELDS.entries()) {
      const row = await storeDocument(kase.id, docType, pdfs[i]);
      docs[docType] = row;
      documentIds.push(row.id);
    }
    await recordEvent(kase.id, "UPLOADED", "USER", "PO, invoice and GRN uploaded", {
      documents: FIELDS.map(([, t]) => ({ docType: t, documentId: docs[t]!.id, version: docs[t]!.version })),
    });

    // 3. Dev 2 analysis (validated against shared schemas inside runAnalysis).
    const mode = aiMode();
    const ai = await runAnalysis({ poPdf: pdfs[0].bytes, invoicePdf: pdfs[1].bytes, grnPdf: pdfs[2].bytes });
    const discrepancies = attachEvidence(ai.discrepancies, docs);
    const status = analysisStatus(discrepancies);

    // 4. Persist results. Discrepancies before status so a partial failure
    // never leaves the case in a success state.
    for (const [, docType] of FIELDS) {
      const extracted = ai.extractedDocuments[docType as "PO" | "INVOICE" | "GRN"];
      const { error } = await db()
        .from("documents")
        .update({
          extraction_status: "PARSED",
          extracted_json: extracted,
          document_number: extracted.documentNumber ?? null,
        })
        .eq("id", docs[docType]!.id);
      if (error) throw new Error(`document update failed: ${error.message}`);
    }
    const saved = await replaceDiscrepancies(kase.id, discrepancies);
    await updateCase(kase.id, {
      status,
      investigation_summary: ai.investigationSummary,
      supplier_message_draft: ai.supplierMessageDraft,
      po_number: ai.extractedDocuments.PO.documentNumber ?? kase.po_number,
      invoice_number: ai.extractedDocuments.INVOICE.documentNumber ?? kase.invoice_number,
    });
    await recordEvent(kase.id, "ANALYSIS_COMPLETED", "AI", `Analysis complete: ${status}`, {
      aiMode: mode,
      status,
      discrepancyCount: saved.length,
      amountUnderReviewPaise: saved.reduce((sum, d) => sum + d.amountUnderReviewPaise, 0),
      discrepancyIds: saved.map((d) => d.id),
    });

    const body: AnalyzeResponse = AnalyzeResponse.parse({
      caseId: kase.id,
      caseCode: kase.case_code,
      status,
      discrepancies: saved,
      investigationSummary: ai.investigationSummary,
      supplierMessageDraft: ai.supplierMessageDraft,
    });
    return NextResponse.json(body);
  } catch (err) {
    if (caseId) await failCase(caseId, "analyze", err, documentIds);
    return errorResponse(err, "analyze");
  }
}
