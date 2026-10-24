import "server-only";
import { randomUUID } from "node:crypto";
import type { DocType } from "@/lib/contracts";
import { ApiError } from "./errors";
import type { ValidPdf } from "./pdf";
import { BUCKET, db } from "./supabase";

export type DocumentRow = {
  id: string;
  case_id: string;
  doc_type: DocType;
  version: number;
  document_number: string | null;
  original_filename: string;
  storage_path: string;
  extraction_status: "UPLOADED" | "PARSED" | "FAILED";
  extracted_json: Record<string, unknown>;
  extraction_error: string | null;
  uploaded_at: string;
};

const UNIQUE_VIOLATION = "23505";

async function nextVersion(caseId: string, docType: DocType): Promise<number> {
  const { data, error } = await db()
    .from("documents")
    .select("version")
    .eq("case_id", caseId)
    .eq("doc_type", docType)
    .order("version", { ascending: false })
    .limit(1);
  if (error) throw new Error(`version lookup failed: ${error.message}`);
  return (data?.[0]?.version ?? 0) + 1;
}

// Uploads the original bytes to the private bucket and inserts a documents row.
// Paths are unique (caseId/docType/vN-uuid.pdf) so originals are never
// overwritten; a concurrent version clash is retried once, and the orphaned
// object is removed if the row cannot be inserted.
export async function storeDocument(caseId: string, docType: DocType, pdf: ValidPdf): Promise<DocumentRow> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const version = await nextVersion(caseId, docType);
    const path = `${caseId}/${docType}/v${version}-${randomUUID()}.pdf`;

    const upload = await db().storage.from(BUCKET).upload(path, pdf.bytes, {
      contentType: "application/pdf",
      upsert: false,
    });
    if (upload.error) {
      throw new ApiError(500, "STORAGE_ERROR", `Failed to store ${docType} file`);
    }

    const { data, error } = await db()
      .from("documents")
      .insert({
        case_id: caseId,
        doc_type: docType,
        version,
        original_filename: pdf.filename,
        storage_path: path,
      })
      .select()
      .single();

    if (!error) return data as DocumentRow;

    await db().storage.from(BUCKET).remove([path]);
    if (error.code !== UNIQUE_VIOLATION) {
      throw new ApiError(500, "DB_ERROR", `Failed to record ${docType} document`);
    }
  }
  throw new ApiError(409, "VERSION_CONFLICT", `Concurrent upload conflict for ${docType}; retry`);
}

export async function latestDocument(caseId: string, docType: DocType): Promise<DocumentRow | null> {
  const { data, error } = await db()
    .from("documents")
    .select("*")
    .eq("case_id", caseId)
    .eq("doc_type", docType)
    .order("version", { ascending: false })
    .limit(1);
  if (error) throw new Error(`document lookup failed: ${error.message}`);
  return (data?.[0] as DocumentRow) ?? null;
}
