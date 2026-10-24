// End-to-end API acceptance checks against a running dev server.
// Usage: npm run dev   (in another terminal), then
//        node scripts/smoke.mjs [baseUrl]
// Note: uploads to the real SR-001 case (adds new document versions).
import { readFile } from "node:fs/promises";

const BASE = process.argv[2] ?? "http://localhost:3000";
const FIX = new URL("../fixtures/sr-001/", import.meta.url);
const UUID_RE = /^[0-9a-f-]{36}$/i;

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

async function pdf(name) {
  return new Blob([await readFile(new URL(name, FIX))], { type: "application/pdf" });
}

async function post(path, fields) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof Blob) form.append(k, v, `${k}.pdf`);
    else form.append(k, v);
  }
  const res = await fetch(`${BASE}${path}`, { method: "POST", body: form });
  return { status: res.status, body: await res.json() };
}

const isError = (b) => typeof b?.error === "string" && typeof b?.code === "string";

// --- input validation ---------------------------------------------------
const po = await pdf("PO-1001.pdf");
const inv = await pdf("INV-1001.pdf");
const grn = await pdf("GRN-1001.pdf");
const revised = await pdf("INV-1001-R1.pdf");

let r = await post("/api/analyze", { po, invoice: inv });
check("analyze: missing grn → 400", r.status === 400 && isError(r.body) && r.body.code === "MISSING_FILE", JSON.stringify(r.body));

r = await post("/api/analyze", { po, invoice: inv, grn: new Blob(["not a pdf"], { type: "application/pdf" }) });
check("analyze: fake PDF → 400 INVALID_PDF", r.status === 400 && r.body.code === "INVALID_PDF", JSON.stringify(r.body));

const big = new Uint8Array(10 * 1024 * 1024 + 1);
big.set(new TextEncoder().encode("%PDF-1.4"));
r = await post("/api/analyze", { po, invoice: inv, grn: new Blob([big], { type: "application/pdf" }) });
check("analyze: >10 MB → 413", r.status === 413 && isError(r.body), JSON.stringify(r.body));

r = await post("/api/analyze", { po, invoice: inv, grn, caseId: "SR-001" });
check("analyze: case code instead of UUID → 400", r.status === 400 && r.body.code === "INVALID_CASE_ID", JSON.stringify(r.body));

// --- happy path: 100 / 100 / 80 at ₹500 --------------------------------
r = await post("/api/analyze", { po, invoice: inv, grn });
check("analyze: 200", r.status === 200, JSON.stringify(r.body));
const a = r.body;
const caseId = a.caseId;
check("analyze: caseId is UUID, caseCode SR-001", UUID_RE.test(caseId ?? "") && a.caseCode === "SR-001");
check("analyze: status DISCREPANCY_FOUND|AWAITING_APPROVAL", ["DISCREPANCY_FOUND", "AWAITING_APPROVAL"].includes(a.status), a.status);
const q = a.discrepancies?.find((d) => d.issueType === "QUANTITY");
check(
  "analyze: 20 cartons / 1,000,000 paise under review",
  q && q.invoicedQty - q.receivedQty === 20 && q.amountUnderReviewPaise === 1_000_000,
  JSON.stringify(q),
);
check("analyze: summary + draft present", Boolean(a.investigationSummary && a.supplierMessageDraft));
if (String(a.investigationSummary).includes("[MOCK")) console.log("  ⚠ AI_MODE=mock — result is a fixture, not a live analysis");

let g = await fetch(`${BASE}/api/cases/${caseId}`).then((res) => res.json());
const docIds = new Set(g.documents?.map((d) => d.documentId));
check(
  "analyze: every evidence ref matches a stored document",
  a.discrepancies.every((d) => d.evidenceRefs.length > 0 && d.evidenceRefs.every((e) => docIds.has(e.documentId))),
);
check("get: no storage paths leaked", !JSON.stringify(g).includes("storage_path") && !JSON.stringify(g).includes(`${caseId}/`));
check("get: UPLOADED + ANALYSIS_COMPLETED events", ["UPLOADED", "ANALYSIS_COMPLETED"].every((t) => g.events?.some((e) => e.eventType === t)));

// --- revalidation -------------------------------------------------------
r = await post("/api/revalidate", { caseId: "not-a-uuid", revisedInvoice: revised });
check("revalidate: bad caseId → 400", r.status === 400 && isError(r.body), JSON.stringify(r.body));

r = await post("/api/revalidate", { caseId });
check("revalidate: missing file → 400", r.status === 400 && r.body.code === "MISSING_FILE", JSON.stringify(r.body));

r = await post("/api/revalidate", { caseId, revisedInvoice: revised });
check("revalidate: 200 READY_FOR_PAYMENT_APPROVAL", r.status === 200 && r.body.status === "READY_FOR_PAYMENT_APPROVAL", JSON.stringify(r.body));
check("revalidate: explanation present", typeof r.body.explanation === "string" && r.body.explanation.length > 0);

g = await fetch(`${BASE}/api/cases/${caseId}`).then((res) => res.json());
check("get: original INVOICE preserved", g.documents.some((d) => d.docType === "INVOICE"));
check("get: REVISED_INVOICE stored", g.documents.some((d) => d.docType === "REVISED_INVOICE"));
check("get: REVALIDATED event", g.events.some((e) => e.eventType === "REVALIDATED"));

g = await fetch(`${BASE}/api/cases/00000000-0000-0000-0000-000000000000`);
check("get: unknown case → 404", g.status === 404);

console.log(failures === 0 ? "\nAll checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
