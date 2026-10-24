// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";

// jsdom's Blob lacks arrayBuffer(); real browsers have it.
if (!Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function (this: Blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as ArrayBuffer);
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(this);
    });
  };
}

const ID = "d7c7202a-537d-4b75-88cb-58d52753ac2e";
const pdf = (name: string, body = "x", type = "application/pdf") =>
  new File([`%PDF-1.4\n${body}\n%%EOF`], name, { type, lastModified: 1 });

const item = (quantity: number, unitPricePaise: number | null) => ({ description: "Corrugated Carton", unit: "carton", quantity, unitPricePaise });
const doc = (docType: string, documentNumber: string, version: number, i: ReturnType<typeof item>) => ({
  documentId: `${docType}${version}`, docType, version, documentNumber, originalFilename: `${documentNumber}.pdf`,
  extractionStatus: "PARSED", uploadedAt: "2026-10-24T10:00:00Z",
  extractedJson: { docType, documentNumber, supplierCode: "SUP-001", poNumber: "PO-1001", currency: "INR", items: [i] },
});
const finding = {
  issueType: "QUANTITY", lineRef: "CARTON-01", orderedQty: 100, invoicedQty: 100, receivedQty: 80, amountUnderReviewPaise: 1_000_000,
  description: "20 cartons are not supported by the GRN.", recommendedAction: "Request proof of delivery or a revised invoice for 80.",
  evidenceRefs: [
    { docType: "PO", documentNumber: "PO-1001", field: "items[0].quantity" },
    { docType: "INVOICE", documentNumber: "INV-1001", field: "items[0].quantity" },
    { docType: "GRN", documentNumber: "GRN-1001", field: "items[0].quantity" },
  ],
};
const analysis = {
  caseId: ID, caseCode: "SR-001", status: "DISCREPANCY_FOUND", discrepancies: [finding],
  investigationSummary: "Known: 100 invoiced, 80 received.", supplierMessageDraft: "Dear supplier, please send a revised invoice for 80 cartons.",
};
const detail = (over: object = {}) => ({
  ...analysis, resolvedDiscrepancies: [], poNumber: "PO-1001", invoiceNumber: "INV-1001",
  documents: [doc("PO", "PO-1001", 1, item(100, 50000)), doc("INVOICE", "INV-1001", 1, item(100, 50000)), doc("GRN", "GRN-1001", 1, item(80, null))],
  events: [{ eventId: "e1", eventType: "ANALYSIS_COMPLETED", actorType: "AI", note: "Analysis complete: DISCREPANCY_FOUND", createdAt: "2026-10-24T10:00:00Z" }],
  ...over,
});

type Reply = { status?: number; body: unknown };
let routes: Record<string, Reply[]>;
let calls: { url: string; method: string; body?: FormData }[];

beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${url.replace(/\/api\/cases\/.*/, "/api/cases/:id")}`;
    calls.push({ url, method, body: init?.body as FormData | undefined });
    const queue = routes[key];
    const reply = queue?.length > 1 ? queue.shift()! : queue?.[0];
    if (!reply) return new Response(JSON.stringify({ error: "no route", code: "NO_ROUTE" }), { status: 500 });
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  }));
    window.history.replaceState(null, "", "/");
});
afterEach(() => cleanup());

async function fillAndAnalyse(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(screen.getByLabelText("Purchase Order"), pdf("PO-1001.pdf", "po"));
  await user.upload(screen.getByLabelText("Invoice"), pdf("INV-1001.pdf", "inv"));
  await user.upload(screen.getByLabelText("Goods Receipt (GRN)"), pdf("GRN-1001.pdf", "grn"));
  await user.click(screen.getByRole("button", { name: /analyse documents/i }));
}

describe("Dashboard", () => {
  it("keeps Analyse disabled until all three valid PDFs are attached; rejects non-PDFs inline", async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<Dashboard />);
    const btn = screen.getByRole("button", { name: /analyse documents/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await user.upload(screen.getByLabelText("Purchase Order"), new File(["hello"], "notes.txt", { type: "text/plain" }));
    expect(screen.getByText("Only PDF files are accepted.")).toBeTruthy();
    await user.upload(screen.getByLabelText("Invoice"), pdf("INV.pdf"));
    await user.upload(screen.getByLabelText("Goods Receipt (GRN)"), pdf("GRN.pdf"));
    expect(btn.disabled).toBe(true); // PO is still invalid
  });

  it("blocks the same file in two slots and fake PDFs before any request", async () => {
    const user = userEvent.setup();
    render(<Dashboard />);
    await user.upload(screen.getByLabelText("Purchase Order"), pdf("same.pdf"));
    await user.upload(screen.getByLabelText("Invoice"), pdf("same.pdf"));
    await user.upload(screen.getByLabelText("Goods Receipt (GRN)"), pdf("GRN.pdf"));
    await user.click(screen.getByRole("button", { name: /analyse documents/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/same file is selected for Purchase Order and Invoice/);

    await user.click(screen.getAllByRole("button", { name: /remove invoice/i })[0]);
    await user.upload(screen.getByLabelText("Invoice"), new File(["not a pdf at all"], "fake.pdf", { type: "application/pdf", lastModified: 2 }));
    await user.click(screen.getByRole("button", { name: /analyse documents/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Invoice: This file is not a valid PDF/);
    expect(calls).toHaveLength(0);
  });

  it("full journey: analyse -> findings -> copy -> revised invoice -> resolved", async () => {
    routes["POST /api/analyze"] = [{ body: analysis }];
    routes["GET /api/cases/:id"] = [{ body: detail() }];
    const user = userEvent.setup();
    render(<Dashboard />);
    await fillAndAnalyse(user);

    expect(await screen.findByText("Discrepancy detected")).toBeTruthy();
    expect(screen.getAllByText("Needs correction").length).toBeGreaterThan(0);
    expect(screen.getByText("₹10,000")).toBeTruthy(); // amount under review (paise -> rupees)
    expect(screen.getByText("₹500")).toBeTruthy(); // unit price from the saved PO extraction
    for (const n of ["Ordered", "Invoiced", "Received"]) expect(screen.getByText(n)).toBeTruthy();
    expect(screen.getByText(/Request proof of delivery or a revised invoice/)).toBeTruthy();
    expect(screen.getByText(/INV-1001 · Line 1 · quantity/)).toBeTruthy();
    expect(window.location.search).toBe(`?case=${ID}`);

    await user.click(screen.getByRole("button", { name: /copy message/i }));
    expect(await navigator.clipboard.readText()).toBe(analysis.supplierMessageDraft);
    expect(await screen.findByText("Copied ✓")).toBeTruthy();

    // Revalidation: backend now reports resolved.
    routes["POST /api/revalidate"] = [{ body: { caseId: ID, caseCode: "SR-001", status: "READY_FOR_PAYMENT_APPROVAL", discrepancies: [], explanation: "INV-1001-R1 matches GRN-1001 and PO-1001. No payment has been made." } }];
    routes["GET /api/cases/:id"] = [{ body: detail({ status: "READY_FOR_PAYMENT_APPROVAL", discrepancies: [], resolvedDiscrepancies: [finding] }) }];
    await user.upload(screen.getByLabelText("Corrected invoice"), pdf("INV-1001-R1.pdf", "rev"));
    await user.click(screen.getByRole("button", { name: /verify revised invoice/i }));

    expect(await screen.findByText("Latest revalidation")).toBeTruthy();
    expect(screen.getAllByText("Resolved").length).toBeGreaterThan(0);
    expect(screen.getByText(/ready for payment approval\. No payment has been made/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /copy message/i })).toBeNull(); // stale draft hidden once resolved
    expect(screen.getByText("No revised invoice is needed.")).toBeTruthy();

    const rev = calls.find((c) => c.url === "/api/revalidate")!;
    expect(rev.body!.get("caseId")).toBe(ID);
    expect((rev.body!.get("revisedInvoice") as File).type).toBe("application/pdf");
  });

  it("sends application/pdf even when the browser reports an empty MIME type", async () => {
    routes["POST /api/analyze"] = [{ body: analysis }];
    routes["GET /api/cases/:id"] = [{ body: detail() }];
    const user = userEvent.setup({ applyAccept: false });
    render(<Dashboard />);
    await user.upload(screen.getByLabelText("Purchase Order"), pdf("PO.pdf", "a", ""));
    await user.upload(screen.getByLabelText("Invoice"), pdf("INV.pdf", "b", ""));
    await user.upload(screen.getByLabelText("Goods Receipt (GRN)"), pdf("GRN.pdf", "c", ""));
    await user.click(screen.getByRole("button", { name: /analyse documents/i }));
    await screen.findByText("Discrepancy detected");
    const body = calls.find((c) => c.url === "/api/analyze")!.body!;
    for (const f of ["po", "invoice", "grn"]) expect((body.get(f) as File).type).toBe("application/pdf");
  });

  it("shows a friendly error with its code for an API failure and keeps inputs", async () => {
    routes["POST /api/analyze"] = [{ status: 422, body: { error: "raw", code: "AI_INVALID_OUTPUT" } }];
    const user = userEvent.setup();
    render(<Dashboard />);
    await fillAndAnalyse(user);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not reliably read these documents/);
    expect(alert.textContent).toMatch(/AI_INVALID_OUTPUT/);
    expect(screen.getByText("PO-1001.pdf")).toBeTruthy();
    expect((screen.getByRole("button", { name: /analyse documents/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("after a failed re-analysis the screen reflects the case's new status (no stale 'Needs correction')", async () => {
    routes["POST /api/analyze"] = [{ body: analysis }, { status: 422, body: { error: "x", code: "AI_INVALID_OUTPUT" } }];
    routes["GET /api/cases/:id"] = [{ body: detail() }, { body: detail({ status: "NEEDS_REVIEW", discrepancies: [] }) }];
    const user = userEvent.setup();
    render(<Dashboard />);
    await fillAndAnalyse(user);
    await screen.findByText("Discrepancy detected");
    await user.click(screen.getByRole("button", { name: /re-analyse documents/i }));
    await waitFor(() => expect(screen.getAllByText("Awaiting review").length).toBeGreaterThan(0));
    expect(screen.getByRole("alert").textContent).toMatch(/AI_INVALID_OUTPUT/);
  });

  it("revalidation errors appear under the revised-invoice section only", async () => {
    routes["POST /api/analyze"] = [{ body: analysis }];
    routes["GET /api/cases/:id"] = [{ body: detail() }];
    routes["POST /api/revalidate"] = [{ status: 409, body: { error: "x", code: "CASE_NOT_READY" } }];
    const user = userEvent.setup();
    render(<Dashboard />);
    await fillAndAnalyse(user);
    await screen.findByText("Discrepancy detected");
    await user.upload(screen.getByLabelText("Corrected invoice"), pdf("R1.pdf", "rev"));
    await user.click(screen.getByRole("button", { name: /verify revised invoice/i }));
    const alerts = await screen.findAllByRole("alert");
    expect(alerts).toHaveLength(1);
    const section = screen.getByText("Revised invoice").closest("section")!;
    expect(within(section).getByRole("alert").textContent).toMatch(/Analyse the three documents/);
  });

  it("blocks re-uploading the original invoice as the revision", async () => {
    routes["POST /api/analyze"] = [{ body: analysis }];
    routes["GET /api/cases/:id"] = [{ body: detail() }];
    const user = userEvent.setup();
    render(<Dashboard />);
    await fillAndAnalyse(user);
    await screen.findByText("Discrepancy detected");
    await user.upload(screen.getByLabelText("Corrected invoice"), pdf("INV-1001.pdf", "inv"));
    await user.click(screen.getByRole("button", { name: /verify revised invoice/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/same file as the original invoice/);
    expect(calls.some((c) => c.url === "/api/revalidate")).toBe(false);
  });

  it("re-opens a case from ?case= and shows an error for an unknown id", async () => {
    window.history.replaceState(null, "", `/?case=${ID}`);
    routes["GET /api/cases/:id"] = [{ body: detail() }];
    render(<Dashboard />);
    expect(await screen.findByText("SR-001")).toBeTruthy();
    cleanup();
    routes["GET /api/cases/:id"] = [{ status: 404, body: { error: "Case not found", code: "CASE_NOT_FOUND" } }];
    render(<Dashboard />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/does not exist/);
  });

  it("shows a resolved NO_DISCREPANCY case without a supplier message or revision upload", async () => {
    routes["POST /api/analyze"] = [{ body: { ...analysis, status: "NO_DISCREPANCY", discrepancies: [], supplierMessageDraft: null } }];
    routes["GET /api/cases/:id"] = [{ body: detail({ status: "NO_DISCREPANCY", discrepancies: [], supplierMessageDraft: null }) }];
    const user = userEvent.setup();
    render(<Dashboard />);
    await fillAndAnalyse(user);
    expect(await screen.findByText("No outstanding discrepancies.")).toBeTruthy();
    expect(screen.getByText("No revised invoice is needed.")).toBeTruthy();
    expect(screen.queryByLabelText("Corrected invoice")).toBeNull();
  });

  it("offers a retry of the revised invoice after an ERROR when the originals were analysed, but not otherwise", async () => {
    window.history.replaceState(null, "", `/?case=${ID}`);
    routes["GET /api/cases/:id"] = [{ body: detail({ status: "ERROR" }) }];
    render(<Dashboard />);
    expect(await screen.findByLabelText("Corrected invoice")).toBeTruthy();
    cleanup();
    routes["GET /api/cases/:id"] = [{ body: detail({ status: "ERROR", documents: [] }) }];
    render(<Dashboard />);
    await screen.findByText("SR-001");
    expect(screen.queryByLabelText("Corrected invoice")).toBeNull();
    expect(screen.getByText(/upload the three original documents again/)).toBeTruthy();
  });

  it("warns when results are mock data", async () => {
    window.history.replaceState(null, "", `/?case=${ID}`);
    routes["GET /api/cases/:id"] = [{ body: detail({ investigationSummary: "[MOCK AI RESULT — not a live analysis] hi" }) }];
    render(<Dashboard />);
    expect(await screen.findByText(/these results are mock data/)).toBeTruthy();
  });
});
