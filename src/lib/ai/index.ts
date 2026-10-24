import "server-only";
import type { z } from "zod";
import type { CaseStatus, Discrepancy, ExtractedDocument } from "@/lib/contracts";
import { writeDraft } from "./draft";
import { extractDocument } from "./extract";
import { formatInr, threeWayMatch } from "./match";

export { AiOutputError } from "./gemini";

// Gemini reads the PDFs and writes prose; threeWayMatch (plain code) decides
// every discrepancy and amount.

export async function analyzeDocuments(input: { poPdf: Buffer; invoicePdf: Buffer; grnPdf: Buffer }) {
  const [PO, INVOICE, GRN] = await Promise.all([
    extractDocument(input.poPdf, "PO"),
    extractDocument(input.invoicePdf, "INVOICE"),
    extractDocument(input.grnPdf, "GRN"),
  ]);
  const extractedDocuments = { PO, INVOICE, GRN };
  // A swapped upload is reported via docType and rejected by the backend.
  if (PO.docType !== "PO" || INVOICE.docType !== "INVOICE" || GRN.docType !== "GRN") {
    return { extractedDocuments, discrepancies: [], investigationSummary: "Document types do not match upload fields.", supplierMessageDraft: null };
  }
  const discrepancies = threeWayMatch(PO, INVOICE, GRN);
  const { investigationSummary, supplierMessageDraft } = await writeDraft(extractedDocuments, discrepancies);
  return { extractedDocuments, discrepancies, investigationSummary, supplierMessageDraft };
}

export async function revalidateInvoice(input: {
  originalDocuments: { PO: ExtractedDocument; INVOICE: ExtractedDocument; GRN: ExtractedDocument };
  revisedInvoicePdf: Buffer;
}): Promise<{
  extractedRevisedInvoice: ExtractedDocument;
  discrepancies: z.infer<typeof Discrepancy>[];
  explanation: string;
  status: z.infer<typeof CaseStatus>;
}> {
  const { PO, INVOICE, GRN } = input.originalDocuments;
  const revised = await extractDocument(input.revisedInvoicePdf, "REVISED_INVOICE");

  if (revised.docType !== "REVISED_INVOICE") {
    return {
      extractedRevisedInvoice: revised,
      discrepancies: [],
      explanation: `The uploaded file was read as a ${revised.docType}, not an invoice. Manual review required.`,
      status: "NEEDS_REVIEW",
    };
  }

  const outstanding = threeWayMatch(PO, revised, GRN);
  const billed = revised.items.map((i) => `${i.quantity} ${i.unit} of ${i.sku ?? i.description}`).join(", ");

  if (outstanding.length === 0) {
    return {
      extractedRevisedInvoice: revised,
      discrepancies: [],
      explanation:
        `${revised.documentNumber} (revising ${INVOICE.documentNumber}) bills ${billed}, which matches ` +
        `${GRN.documentNumber} and ${PO.documentNumber}. No outstanding discrepancies; ready for payment approval.`,
      status: "READY_FOR_PAYMENT_APPROVAL",
    };
  }

  const total = outstanding.reduce((sum, d) => sum + d.amountUnderReviewPaise, 0);
  return {
    extractedRevisedInvoice: revised,
    discrepancies: outstanding,
    explanation:
      `${revised.documentNumber} bills ${billed}, but ${outstanding.length} discrepanc${outstanding.length === 1 ? "y remains" : "ies remain"} ` +
      `against ${PO.documentNumber} / ${GRN.documentNumber} (${formatInr(total)} before GST under review).`,
    status: "DISCREPANCY_FOUND",
  };
}
