import "server-only";
import { ApiError } from "./errors";

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

export type ValidPdf = {
  field: string;
  filename: string;
  bytes: Buffer;
};

// Validates one multipart field as a real PDF. MIME type and filename are
// checked but not trusted — the magic bytes are the deciding check.
export async function readPdfField(form: FormData, field: string): Promise<ValidPdf> {
  const value = form.get(field);
  if (value === null) {
    throw new ApiError(400, "MISSING_FILE", `Missing required file field "${field}"`);
  }
  if (typeof value === "string") {
    throw new ApiError(400, "INVALID_FILE", `Field "${field}" must be a file upload`);
  }
  if (value.size === 0) {
    throw new ApiError(400, "EMPTY_FILE", `File "${field}" is empty`);
  }
  if (value.size > MAX_PDF_BYTES) {
    throw new ApiError(413, "FILE_TOO_LARGE", `File "${field}" exceeds 10 MB`);
  }
  if (value.type !== "application/pdf") {
    throw new ApiError(400, "INVALID_FILE_TYPE", `File "${field}" must be application/pdf`);
  }

  const bytes = Buffer.from(await value.arrayBuffer());
  const hasMagic = PDF_MAGIC.every((b, i) => bytes[i] === b);
  // A complete PDF ends with %%EOF (allow trailing whitespace / bytes).
  const hasEof = bytes.subarray(Math.max(0, bytes.length - 1024)).includes("%%EOF");
  if (!hasMagic || !hasEof) {
    throw new ApiError(400, "INVALID_PDF", `File "${field}" is not a valid PDF`);
  }

  return { field, filename: sanitizeFilename(value.name), bytes };
}

function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "upload.pdf";
  return base.replace(/[^\w.\- ]/g, "_").slice(0, 200) || "upload.pdf";
}

export async function readForm(req: Request): Promise<FormData> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("multipart/form-data")) {
    throw new ApiError(400, "INVALID_CONTENT_TYPE", "Request must be multipart/form-data");
  }
  // Cheap early rejection; per-file limits are enforced in readPdfField.
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > 3 * MAX_PDF_BYTES + 1024 * 1024) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body too large");
  }
  try {
    return await req.formData();
  } catch {
    throw new ApiError(400, "INVALID_FORM", "Could not parse multipart form data");
  }
}
