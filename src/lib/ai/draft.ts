import "server-only";
import { z } from "zod";
import type { Discrepancy as DiscrepancySchema, ExtractedDocument } from "@/lib/contracts";
import { generateJson } from "./gemini";
import { isGrounded } from "./grounding";
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

  const fallback = deterministicText(docs, discrepancies);
  let draft: z.infer<typeof Draft>;
  try {
    draft = await generateJson(Draft, prompt);
  } catch {
    return fallback; // model unavailable/invalid: findings are still correct, only the wording is templated
  }
  // Prose is used only if every number in it comes from the verified facts (no invented figures).
  const factsText = JSON.stringify(facts);
  const docNumbers = [facts.purchaseOrder, facts.invoice, facts.goodsReceipt];
  const summaryOk = isGrounded(draft.investigationSummary, factsText, docNumbers);
  const messageOk = discrepancies.length === 0 || (!!draft.supplierMessageDraft && isGrounded(draft.supplierMessageDraft, factsText, docNumbers));
  return {
    investigationSummary: summaryOk ? draft.investigationSummary : fallback.investigationSummary,
    supplierMessageDraft: discrepancies.length === 0 ? null : messageOk ? draft.supplierMessageDraft : fallback.supplierMessageDraft,
  };
}

// Template wording built only from computed findings. Draft only: nothing is ever sent.
function deterministicText(
  docs: { PO: ExtractedDocument; INVOICE: ExtractedDocument; GRN: ExtractedDocument },
  discrepancies: Discrepancy[],
): { investigationSummary: string; supplierMessageDraft: string | null } {
  const { PO, INVOICE, GRN } = docs;
  if (discrepancies.length === 0) {
    return {
      investigationSummary: `${INVOICE.documentNumber} agrees with ${PO.documentNumber} and ${GRN.documentNumber} on quantity and unit price. This is not a payment approval.`,
      supplierMessageDraft: null,
    };
  }
  const refs = (d: Discrepancy) => d.evidenceRefs.map((r) => `${r.documentNumber} ${r.field}`).join(", ");
  const known = discrepancies.map((d) => `${d.description} (${refs(d)})`).join(" ");
  const uncertain = discrepancies.some((d) => d.issueType === "QUANTITY")
    ? "The cause is not established: a short GRN may be a partial delivery, a receipt-recording gap or an invoicing error."
    : "The documents do not explain the difference; the cause is unknown.";
  return {
    investigationSummary: `Known: ${known}\nUncertain: ${uncertain}\nNext evidence required: ${discrepancies.map((d) => d.recommendedAction).join(" ")}`,
    supplierMessageDraft: [
      "Dear supplier,",
      "",
      `While reconciling ${INVOICE.documentNumber} against ${PO.documentNumber} and ${GRN.documentNumber}, we found:`,
      ...discrepancies.map((d, i) => `${i + 1}. ${d.description} ${d.recommendedAction}`),
      "",
      "Could you please confirm, or send a corrected invoice or supporting proof? No payment decision has been made on this invoice yet.",
      "",
      "Thank you,",
      "Accounts Payable",
    ].join("\n"),
  };
}
