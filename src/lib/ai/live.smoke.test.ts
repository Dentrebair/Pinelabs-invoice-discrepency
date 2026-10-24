// Optional live check against real Gemini on the SR-001 fixtures (no DB writes).
// Run: npm run test:smoke   (loads .env.local; needs GEMINI_API_KEY)
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeDocuments, revalidateInvoice } from "./index";

const f = (n: string) => readFileSync(`fixtures/sr-001/${n}.pdf`);
const live = process.env.SMOKE === "1" && !!process.env.GEMINI_API_KEY;

describe.skipIf(!live)("live Gemini on SR-001 fixtures", () => {
  it("analyze: 100/100/80 -> 20 cartons, 1,000,000 paise", async () => {
    const r = await analyzeDocuments({ poPdf: f("PO-1001"), invoicePdf: f("INV-1001"), grnPdf: f("GRN-1001") });
    console.log(JSON.stringify({ docs: Object.values(r.extractedDocuments).map((d) => [d.docType, d.documentNumber, d.supplierCode, d.poNumber, d.items.map((i) => [i.quantity, i.unit, i.unitPricePaise])]), discrepancies: r.discrepancies.map((d) => [d.issueType, d.orderedQty, d.invoicedQty, d.receivedQty, d.amountUnderReviewPaise]) }));
    expect(r.discrepancies).toHaveLength(1);
    expect(r.discrepancies[0]).toMatchObject({ issueType: "QUANTITY", amountUnderReviewPaise: 1_000_000 });
    console.log("SUMMARY:", r.investigationSummary);
  }, 180_000);

  it("revalidate: revised 80 -> READY_FOR_PAYMENT_APPROVAL", async () => {
    const a = await analyzeDocuments({ poPdf: f("PO-1001"), invoicePdf: f("INV-1001"), grnPdf: f("GRN-1001") });
    const r = await revalidateInvoice({ originalDocuments: a.extractedDocuments, revisedInvoicePdf: f("INV-1001-R1") });
    console.log("REVAL:", r.status, r.discrepancies.length, r.explanation);
    expect(r.status).toBe("READY_FOR_PAYMENT_APPROVAL");
  }, 180_000);
});
