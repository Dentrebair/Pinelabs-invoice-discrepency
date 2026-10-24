// Browser-side client for Developer 3's routes. All shapes come from the shared contracts.
import { z } from "zod";
import { AnalyzeResponse, Discrepancy, DocumentType, RevalidateResponse } from "@/lib/contracts";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export const MAX_PDF_BYTES = 10 * 1024 * 1024; // backend limit per file

const CaseDocument = z.object({
  documentId: z.string(),
  docType: DocumentType,
  version: z.number(),
  documentNumber: z.string().nullish(),
  originalFilename: z.string().nullish(),
  extractionStatus: z.string(),
  extractionError: z.string().nullish(),
  uploadedAt: z.string(),
  extractedJson: z.unknown().nullish(),
});
const CaseEvent = z.object({
  eventId: z.string(),
  eventType: z.string(),
  actorType: z.string(),
  note: z.string().nullish(),
  createdAt: z.string(),
});
export const CaseDetail = AnalyzeResponse.extend({
  resolvedDiscrepancies: z.array(Discrepancy).default([]),
  poNumber: z.string().nullish(),
  invoiceNumber: z.string().nullish(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  documents: z.array(CaseDocument).default([]),
  events: z.array(CaseEvent).default([]),
});
export type CaseDetail = z.infer<typeof CaseDetail>;
export type CaseDocument = z.infer<typeof CaseDocument>;

const FRIENDLY: Record<string, string> = {
  INVALID_PDF: "One of the files is not a valid PDF.",
  INVALID_FILE_TYPE: "Only PDF files are accepted.",
  EMPTY_FILE: "One of the files is empty.",
  FILE_TOO_LARGE: "A file is larger than 10 MB.",
  PAYLOAD_TOO_LARGE: "The upload is too large.",
  MISSING_FILE: "Please attach every required PDF.",
  CASE_NOT_FOUND: "That case does not exist.",
  CASE_NOT_READY: "Analyse the three documents before uploading a revised invoice.",
  VERSION_CONFLICT: "Another update happened at the same time. Please try again.",
  AI_INVALID_OUTPUT: "The AI could not reliably read these documents. The case was flagged for review.",
  AI_TIMEOUT: "Analysis took too long. The case was flagged for review; please try again.",
  AI_UPSTREAM_ERROR: "The AI service is unavailable right now. Please try again shortly.",
};

async function request<T>(url: string, init: RequestInit | undefined, schema: z.ZodType<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    throw new ApiRequestError(
      aborted ? "The request timed out. Please try again." : "Could not reach the server. Check your connection and try again.",
      aborted ? "CLIENT_TIMEOUT" : "NETWORK_ERROR",
    );
  } finally {
    clearTimeout(timer);
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const code = typeof (body as { code?: unknown })?.code === "string" ? (body as { code: string }).code : "HTTP_ERROR";
    const fallback = typeof (body as { error?: unknown })?.error === "string" ? (body as { error: string }).error : `Request failed (${res.status}).`;
    throw new ApiRequestError(FRIENDLY[code] ?? fallback, code, res.status);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiRequestError("The server returned an unexpected response.", "BAD_RESPONSE", res.status);
  return parsed.data;
}

// Some browsers report "" for a genuine PDF; the backend requires application/pdf, so set it explicitly.
const asPdf = (f: File) => (f.type === "application/pdf" ? f : new File([f], f.name, { type: "application/pdf", lastModified: f.lastModified }));

export function analyze(files: { po: File; invoice: File; grn: File }, caseId?: string): Promise<AnalyzeResponse> {
  const form = new FormData();
  form.set("po", asPdf(files.po));
  form.set("invoice", asPdf(files.invoice));
  form.set("grn", asPdf(files.grn));
  if (caseId) form.set("caseId", caseId);
  return request("/api/analyze", { method: "POST", body: form }, AnalyzeResponse, 180_000);
}

export function revalidate(caseId: string, revisedInvoice: File): Promise<RevalidateResponse> {
  const form = new FormData();
  form.set("caseId", caseId);
  form.set("revisedInvoice", asPdf(revisedInvoice));
  return request("/api/revalidate", { method: "POST", body: form }, RevalidateResponse, 180_000);
}

export function getCase(caseId: string): Promise<CaseDetail> {
  return request(`/api/cases/${encodeURIComponent(caseId)}`, undefined, CaseDetail, 30_000);
}

export function validatePdf(file: File | null): string | null {
  if (!file) return null;
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) return "Only PDF files are accepted.";
  if (file.size === 0) return "This file is empty.";
  if (file.size > MAX_PDF_BYTES) return "File is larger than 10 MB.";
  return null;
}

/** Reads the first bytes: a renamed non-PDF is caught before upload. Returns an error message or null. */
export async function checkPdfHeader(file: File): Promise<string | null> {
  try {
    const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    const ok = [0x25, 0x50, 0x44, 0x46, 0x2d].every((b, i) => head[i] === b);
    return ok ? null : "This file is not a valid PDF.";
  } catch {
    return "This file could not be read.";
  }
}

export const sameFile = (a: File, b: File) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
