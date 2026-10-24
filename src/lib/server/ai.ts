import "server-only";
import { z } from "zod";
import { AiOutputError, analyzeDocuments, revalidateInvoice } from "@/lib/ai";
import { CaseStatus, Discrepancy, ExtractedDocument } from "@/lib/contracts";
import { ApiError } from "./errors";

// Integration seam with the AI module (src/lib/ai/*). The backend only
// validates and persists these results; extraction, matching and calculations
// live in the AI module.

export const AnalyzeAiResult = z.object({
  extractedDocuments: z.object({
    PO: ExtractedDocument,
    INVOICE: ExtractedDocument,
    GRN: ExtractedDocument,
  }),
  discrepancies: z.array(Discrepancy),
  investigationSummary: z.string().min(1),
  supplierMessageDraft: z.string().min(1).nullable(),
});
export type AnalyzeAiResult = z.infer<typeof AnalyzeAiResult>;

// discrepancies = issues still outstanding after the revision (empty when resolved).
export const RevalidateAiResult = z.object({
  extractedRevisedInvoice: ExtractedDocument,
  discrepancies: z.array(Discrepancy),
  explanation: z.string().min(1),
  status: CaseStatus,
});
export type RevalidateAiResult = z.infer<typeof RevalidateAiResult>;

export type AnalyzeInput = { poPdf: Buffer; invoicePdf: Buffer; grnPdf: Buffer };
export type RevalidateInput = {
  originalDocuments: { PO: ExtractedDocument; INVOICE: ExtractedDocument; GRN: ExtractedDocument };
  revisedInvoicePdf: Buffer;
};

export type AiMode = "live" | "mock";

export function aiMode(): AiMode {
  return process.env.AI_MODE === "live" ? "live" : "mock";
}

const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS ?? 120_000);

export async function runAnalysis(input: AnalyzeInput): Promise<AnalyzeAiResult> {
  const raw = await withTimeout(aiMode() === "live" ? liveAnalyze(input) : mockAnalyze());
  return parseAi(AnalyzeAiResult, raw);
}

export async function runRevalidation(input: RevalidateInput): Promise<RevalidateAiResult> {
  const raw = await withTimeout(aiMode() === "live" ? liveRevalidate(input) : mockRevalidate());
  return parseAi(RevalidateAiResult, raw);
}

// --- live: AI module (src/lib/ai, Gemini) ------------------------------------

async function liveAnalyze(input: AnalyzeInput): Promise<unknown> {
  return analyzeDocuments(input).catch(mapAiError);
}

async function liveRevalidate(input: RevalidateInput): Promise<unknown> {
  return revalidateInvoice(input).catch(mapAiError);
}

// Untrustworthy model output → 422 (case NEEDS_REVIEW); provider/network
// failures → 502. Provider messages are logged briefly, never returned.
function mapAiError(err: unknown): never {
  if (err instanceof AiOutputError) {
    console.error("[ai] output rejected:", err.message);
    throw new ApiError(422, "AI_INVALID_OUTPUT", "AI could not reliably read the documents; case flagged for review");
  }
  console.error("[ai] provider error:", err instanceof Error ? err.message.slice(0, 200) : "unknown");
  throw new ApiError(502, "AI_UPSTREAM_ERROR", "AI service request failed");
}

// --- mock: TEMPORARY fixture for endpoint tests -----------------------------
// ⚠️ MOCK — not a live AI result. Returns the SR-001 fixture regardless of the
// uploaded files. Text fields are prefixed with [MOCK] so it can never be
// mistaken for a real finding.

const MOCK = "[MOCK AI RESULT — not a live analysis]";

// Test-only fault injection for the mock: AI_MOCK_FAULT=invalid | timeout.
function mockFault(): Promise<unknown> | null {
  if (process.env.AI_MOCK_FAULT === "invalid") return Promise.resolve({ discrepancies: "not-an-array" });
  if (process.env.AI_MOCK_FAULT === "timeout") return new Promise(() => {});
  return null;
}

const carton = (quantity: number, unitPricePaise: number | null) => ({
  lineRef: "1",
  sku: "CARTON-01",
  description: "Corrugated Carton",
  unit: "carton",
  quantity,
  unitPricePaise,
  gstRatePercent: 18,
});

const mockDoc = (docType: string, documentNumber: string, item: ReturnType<typeof carton>) => ({
  docType,
  documentNumber,
  supplierCode: "SUP-001",
  poNumber: "PO-1001",
  currency: "INR",
  items: [item],
  notes: MOCK,
});

async function mockAnalyze(): Promise<unknown> {
  const fault = mockFault();
  if (fault) return fault;
  return {
    extractedDocuments: {
      PO: mockDoc("PO", "PO-1001", carton(100, 50_000)),
      INVOICE: mockDoc("INVOICE", "INV-1001", carton(100, 50_000)),
      GRN: mockDoc("GRN", "GRN-1001", carton(80, null)),
    },
    discrepancies: [
      {
        issueType: "QUANTITY",
        lineRef: "1",
        orderedQty: 100,
        invoicedQty: 100,
        receivedQty: 80,
        amountUnderReviewPaise: 1_000_000,
        description: `${MOCK} Invoiced 100 cartons but GRN records 80 received; 20 cartons under review.`,
        recommendedAction: "Request a revised invoice for 80 cartons.",
        evidenceRefs: [
          { docType: "PO", documentNumber: "PO-1001", field: "items[0].quantity" },
          { docType: "INVOICE", documentNumber: "INV-1001", field: "items[0].quantity" },
          { docType: "GRN", documentNumber: "GRN-1001", field: "items[0].quantity" },
        ],
      },
    ],
    investigationSummary: `${MOCK} PO and invoice show 100 cartons at ₹500; GRN shows 80 received. ₹10,000 (pre-GST) is under review.`,
    supplierMessageDraft: `${MOCK} Dear ABC Packaging, invoice INV-1001 bills 100 cartons but GRN-1001 records 80 received against PO-1001. Please send a revised invoice for 80 cartons.`,
  };
}

async function mockRevalidate(): Promise<unknown> {
  const fault = mockFault();
  if (fault) return fault;
  return {
    extractedRevisedInvoice: mockDoc("REVISED_INVOICE", "INV-1001-R1", carton(80, 50_000)),
    discrepancies: [],
    explanation: `${MOCK} Revised invoice bills 80 cartons, matching GRN-1001. No outstanding discrepancies.`,
    status: "READY_FOR_PAYMENT_APPROVAL",
  };
}

// --- helpers ----------------------------------------------------------------

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ApiError(504, "AI_TIMEOUT", "AI processing timed out")), TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function parseAi<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    // Log field paths only, not values.
    console.error("[ai] invalid AI output at:", result.error.issues.map((i) => i.path.join(".")).join(", "));
    throw new ApiError(422, "AI_INVALID_OUTPUT", "AI returned an invalid result; case flagged for review");
  }
  return result.data;
}
