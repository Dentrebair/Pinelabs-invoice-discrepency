import { NextResponse } from "next/server";
import { AnalyzeResponse } from "@/lib/contracts";
import { resolveCase } from "@/lib/server/cases";
import { listDiscrepancies } from "@/lib/server/discrepancies";
import { assertUuid, errorResponse } from "@/lib/server/errors";
import { db } from "@/lib/server/supabase";

export const runtime = "nodejs";

// Contract: saved AnalyzeResponse + document metadata + events.
// The AnalyzeResponse fields sit at the top level (so AnalyzeResponse.parse
// works on this body); `discrepancies` holds outstanding issues only, and
// resolved ones are listed separately. Storage paths and bytes are never returned.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const kase = await resolveCase(assertUuid(id, "id"));

    const [docs, events, discrepancies] = await Promise.all([
      db()
        .from("documents")
        .select("id, doc_type, version, document_number, original_filename, extraction_status, extraction_error, uploaded_at, extracted_json")
        .eq("case_id", kase.id)
        .order("uploaded_at", { ascending: true }),
      db()
        .from("case_events")
        .select("id, event_type, actor_type, note, payload, created_at")
        .eq("case_id", kase.id)
        .order("created_at", { ascending: true }),
      listDiscrepancies(kase.id),
    ]);
    if (docs.error) throw new Error(`documents lookup failed: ${docs.error.message}`);
    if (events.error) throw new Error(`events lookup failed: ${events.error.message}`);

    const analysis = AnalyzeResponse.parse({
      caseId: kase.id,
      caseCode: kase.case_code,
      status: kase.status,
      discrepancies: discrepancies.outstanding,
      investigationSummary: kase.investigation_summary ?? "",
      supplierMessageDraft: kase.supplier_message_draft,
    });

    return NextResponse.json({
      ...analysis,
      resolvedDiscrepancies: discrepancies.resolved,
      poNumber: kase.po_number,
      invoiceNumber: kase.invoice_number,
      currency: kase.currency,
      createdAt: kase.created_at,
      updatedAt: kase.updated_at,
      documents: docs.data.map((d) => ({
        documentId: d.id,
        docType: d.doc_type,
        version: d.version,
        documentNumber: d.document_number,
        originalFilename: d.original_filename,
        extractionStatus: d.extraction_status,
        extractionError: d.extraction_error,
        uploadedAt: d.uploaded_at,
        extractedJson: d.extracted_json,
      })),
      events: events.data.map((e) => ({
        eventId: e.id,
        eventType: e.event_type,
        actorType: e.actor_type,
        note: e.note,
        payload: e.payload,
        createdAt: e.created_at,
      })),
    });
  } catch (err) {
    return errorResponse(err, "cases/get");
  }
}
