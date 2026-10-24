import "server-only";
import { NextResponse } from "next/server";
import type { ErrorResponse } from "@/lib/contracts";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function errorResponse(err: unknown, context: string): NextResponse<ErrorResponse> {
  if (err instanceof ApiError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  // Log only the message — never request bodies, PDFs or AI payloads.
  console.error(`[${context}] unexpected error:`, err instanceof Error ? err.message : "unknown");
  return NextResponse.json({ error: "Internal server error", code: "INTERNAL_ERROR" }, { status: 500 });
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new ApiError(400, "INVALID_CASE_ID", `${field} must be a UUID (not a case code like SR-001)`);
  }
  return value;
}
