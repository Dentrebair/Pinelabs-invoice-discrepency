import "server-only";
import { z } from "zod";
import type { Discrepancy as DiscrepancySchema, ExtractedDocument } from "@/lib/contracts";
import { generateJson } from "./gemini";
import { formatInr } from "./match";

type Discrepancy = z.infer<typeof DiscrepancySchema>;

const Draft = z.object({
  investigationSummary: z.string().min(1),
  supplierMessageDraft: z.string().nullable(),
});

// The model only writes prose around findings computed in code. Figures are
// passed pre-formatted so it has nothing to calculate.
export async function writeDraft(
  docs: { PO: ExtractedDocument; INVOICE: ExtractedDocument; GRN: ExtractedDocument },
  discrepancies: Discrepancy[],
): Promise<{ investigationSummary: string; supplierMessageDraft: string | null }> {
  const total = discrepancies.reduce((sum, d) => sum + d.amountUnderReviewPaise, 0);
  const facts = {
    purchaseOrder: docs.PO.documentNumber,
    invoice: docs.INVOICE.documentNumber,
    goodsReceipt: docs.GRN.documentNumber,
    supplierCode: docs.INVOICE.supplierCode,
    totalUnderReviewBeforeGst: formatInr(total),
    findings: discrepancies.map((d) => ({
      type: d.issueType,
      item: d.lineRef,
      ordered: d.orderedQty,
      invoiced: d.invoicedQty,
      acceptedPerGrn: d.receivedQty,
      underReviewBeforeGst: formatInr(d.amountUnderReviewPaise),
      finding: d.description,
      requestedAction: d.recommendedAction,
    })),
  };

  const prompt = `You are an accounts-payable analyst. Below are VERIFIED findings from a PO / invoice / GRN match.
Use only these facts and figures exactly as given; do not calculate, add or change any number.

FACTS:
${JSON.stringify(facts, null, 2)}

Return JSON:
- investigationSummary: 2-4 factual sentences for the internal AP team: what was compared, what was found, the amount under review (before GST), and the next step. If there are no findings, say all three documents agree.
- supplierMessageDraft: ${
    discrepancies.length === 0
      ? "null (no supplier message is needed)."
      : `a short, polite email body to the supplier citing the document numbers and the exact quantities/amounts, and requesting the action given. Do not threaten, promise payment, mention bank details or approve anything. Sign off as "Accounts Payable". The amount is "under review", not a proven overcharge.`
  }`;

  const draft = await generateJson(Draft, prompt);
  return {
    investigationSummary: draft.investigationSummary,
    supplierMessageDraft: discrepancies.length === 0 ? null : draft.supplierMessageDraft,
  };
}
