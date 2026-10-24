"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiRequestError, analyze, checkPdfHeader, getCase, revalidate, sameFile, validatePdf, type CaseDetail } from "@/lib/ui/api-client";
import { CAN_REVALIDATE, resolutionFor } from "@/lib/ui/format";
import { CaseHistory } from "./CaseHistory";
import { DiscrepancyCard } from "./DiscrepancyCard";
import { StatusBadge } from "./StatusBadge";
import { SupplierMessage } from "./SupplierMessage";
import { UploadField } from "./UploadField";

type Busy = "analyze" | "revalidate" | "load" | null;
type UiError = { message: string; code: string; scope: "analyze" | "revalidate" | "load" };
type Files = { po: File | null; invoice: File | null; grn: File | null };
type Notice = { status: CaseDetail["status"]; explanation: string };

function Section({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <h2 className="mb-4 flex items-center gap-3 text-lg font-semibold text-slate-900">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-900 text-sm font-semibold text-white" aria-hidden>
          {n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Spinner() {
  return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden />;
}

function ErrorBox({ error }: { error: { message: string; code: string } }) {
  return (
    <div role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-900 ring-1 ring-red-200">
      <p className="font-medium">{error.message}</p>
      <p className="mt-0.5 text-xs text-red-800/80">Code: {error.code}</p>
    </div>
  );
}

const toError = (e: unknown, scope: UiError["scope"]): UiError =>
  e instanceof ApiRequestError
    ? { message: e.message, code: e.code, scope }
    : { message: "Something went wrong. Please try again.", code: "UNKNOWN", scope };

const PRIMARY =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:bg-slate-300";

export function Dashboard() {
  const [files, setFiles] = useState<Files>({ po: null, invoice: null, grn: null });
  const [revised, setRevised] = useState<File | null>(null);
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const scrollToResults = () => requestAnimationFrame(() => resultsRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }));

  const remember = (caseId: string) => {
    try {
      window.history.replaceState(null, "", `?case=${caseId}`);
    } catch {
      /* non-critical */
    }
  };

  const refresh = useCallback(async (caseId: string) => {
    const d = await getCase(caseId);
    setDetail(d);
    return d;
  }, []);

  // Re-open a case from ?case=<uuid> (set after each analysis, so a reload keeps your place).
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("case");
    if (!id) return;
    setBusy("load");
    refresh(id)
      .catch((e) => setError(toError(e, "load")))
      .finally(() => setBusy(null));
  }, [refresh]);

  const filesReady = files.po && files.invoice && files.grn && ![files.po, files.invoice, files.grn].some((f) => validatePdf(f));
  const working = busy !== null;

  // Failures after the case exists change its status server-side (NEEDS_REVIEW / ERROR): reflect that.
  async function syncAfterFailure() {
    if (!detail) return;
    try {
      await refresh(detail.caseId);
    } catch {
      /* keep what we have */
    }
  }

  async function onAnalyze() {
    if (!files.po || !files.invoice || !files.grn) return;
    const slots = [["Purchase Order", files.po], ["Invoice", files.invoice], ["Goods Receipt", files.grn]] as const;
    setError(null);
    setNotice(null);
    for (const [i, [nameA, a]] of slots.entries()) {
      const clash = slots.slice(i + 1).find(([, b]) => sameFile(a, b));
      if (clash) return setError({ message: `The same file is selected for ${nameA} and ${clash[0]}. Choose a different document for each.`, code: "DUPLICATE_FILE", scope: "analyze" });
    }
    for (const [name, f] of slots) {
      const bad = await checkPdfHeader(f);
      if (bad) return setError({ message: `${name}: ${bad}`, code: "INVALID_PDF", scope: "analyze" });
    }
    setBusy("analyze");
    try {
      const res = await analyze({ po: files.po, invoice: files.invoice, grn: files.grn }, detail?.caseId);
      remember(res.caseId);
      try {
        await refresh(res.caseId);
      } catch {
        // History/price lookups are secondary; show the analysis even if they fail.
        setDetail({ ...res, resolvedDiscrepancies: [], documents: [], events: [] });
      }
      setRevised(null);
      scrollToResults();
    } catch (e) {
      setError(toError(e, "analyze"));
      await syncAfterFailure();
    } finally {
      setBusy(null);
    }
  }

  async function onRevalidate() {
    if (!detail || !revised) return;
    setError(null);
    setNotice(null);
    if (files.invoice && sameFile(revised, files.invoice)) {
      return setError({ message: "This is the same file as the original invoice. Upload the supplier's corrected invoice.", code: "DUPLICATE_FILE", scope: "revalidate" });
    }
    const bad = await checkPdfHeader(revised);
    if (bad) return setError({ message: bad, code: "INVALID_PDF", scope: "revalidate" });
    setBusy("revalidate");
    try {
      const res = await revalidate(detail.caseId, revised);
      setNotice({ status: res.status, explanation: res.explanation });
      try {
        await refresh(detail.caseId);
      } catch {
        setDetail({ ...detail, status: res.status, discrepancies: res.discrepancies });
      }
      setRevised(null);
      scrollToResults();
    } catch (e) {
      setError(toError(e, "revalidate"));
      await syncAfterFailure();
    } finally {
      setBusy(null);
    }
  }

  const resolution = detail ? resolutionFor(detail.status) : null;
  // After an ERROR the originals must already be analysed (otherwise the backend answers CASE_NOT_READY).
  const hasAnalysedOriginals = (["PO", "INVOICE", "GRN"] as const).every((t) =>
    detail?.documents.some((d) => d.docType === t && d.extractionStatus === "PARSED"));
  const canRevalidate = !!detail && CAN_REVALIDATE.includes(detail.status) && (detail.status !== "ERROR" || hasAnalysedOriginals);
  const isMock = !!detail?.investigationSummary.startsWith("[MOCK AI RESULT");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">Supplier Resolution</h1>
          <p className="mt-1 text-sm text-slate-600">Compare the PO, invoice and goods receipt, review mismatches and verify a corrected invoice.</p>
        </div>
        {detail && (
          <div className="flex items-center gap-3" aria-live="polite">
            <span className="rounded-md bg-slate-900 px-2.5 py-1 text-sm font-semibold text-white">{detail.caseCode}</span>
            <StatusBadge status={detail.status} large />
          </div>
        )}
      </header>

      <div className="space-y-6">
        <Section n={1} title="Upload documents">
          <div className="grid gap-4 sm:grid-cols-3">
            <UploadField label="Purchase Order" file={files.po} onChange={(po) => setFiles((f) => ({ ...f, po }))} disabled={working} />
            <UploadField label="Invoice" file={files.invoice} onChange={(invoice) => setFiles((f) => ({ ...f, invoice }))} disabled={working} />
            <UploadField label="Goods Receipt (GRN)" file={files.grn} onChange={(grn) => setFiles((f) => ({ ...f, grn }))} disabled={working} />
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-4">
            <button type="button" onClick={onAnalyze} disabled={!filesReady || working} className={PRIMARY}>
              {busy === "analyze" && <Spinner />}
              {busy === "analyze" ? "Analysing…" : detail ? "Re-analyse documents" : "Analyse documents"}
            </button>
            <span className="text-sm text-slate-500" role="status">
              {busy === "analyze"
                ? "Reading the documents — this usually takes 20–40 seconds."
                : busy === "load"
                  ? "Loading case…"
                  : !filesReady
                    ? "Attach all three PDFs (max 10 MB each) to continue."
                    : ""}
            </span>
          </div>
          {error && error.scope !== "revalidate" && busy === null && <div className="mt-4"><ErrorBox error={error} /></div>}
        </Section>

        {detail && (
          <div ref={resultsRef} className="scroll-mt-4 space-y-6">
            {isMock && (
              <div role="status" className="rounded-2xl bg-amber-50 px-5 py-3 text-sm text-amber-950 ring-1 ring-amber-300">
                <span className="font-semibold">Demo mode:</span> these results are mock data, not a live analysis of your documents.
              </div>
            )}
            {resolution === "RESOLVED" && (
              <div role="status" className="rounded-2xl bg-emerald-50 px-5 py-4 text-emerald-950 ring-1 ring-emerald-200">
                <p className="font-semibold">Resolved</p>
                <p className="text-sm">
                  {detail.status === "READY_FOR_PAYMENT_APPROVAL"
                    ? "The corrected invoice is supported by the PO and goods receipt and is ready for payment approval. No payment has been made."
                    : "All three documents agree. No action needed."}
                </p>
              </div>
            )}

            <Section n={2} title={detail.discrepancies.length ? "Discrepancy detected" : "Discrepancy check"}>
              {detail.discrepancies.length > 0 ? (
                <div className="space-y-4">
                  {detail.discrepancies.map((d, i) => (
                    <DiscrepancyCard key={`${d.issueType}-${d.lineRef}-${i}`} d={d} documents={detail.documents} />
                  ))}
                </div>
              ) : resolution === "RESOLVED" ? (
                <p className="text-sm text-slate-700">No outstanding discrepancies.</p>
              ) : (
                <p className="text-sm text-slate-700">No itemised findings are available for this case. It needs a manual review.</p>
              )}
            </Section>

            <Section n={3} title="AI investigation">
              {notice && (
                <div className="mb-4 rounded-lg bg-indigo-50 px-4 py-3 text-sm text-indigo-950 ring-1 ring-indigo-200">
                  <p className="font-semibold">Latest revalidation</p>
                  <p className="mt-0.5 whitespace-pre-line">{notice.explanation}</p>
                </div>
              )}
              <p className="whitespace-pre-line text-sm leading-relaxed text-slate-800">
                {detail.investigationSummary || "No investigation summary is available for this case."}
              </p>
              <p className="mt-3 text-xs text-slate-500">AI-generated from the extracted documents; figures are calculated by the system, not the AI.</p>
            </Section>

            <Section n={4} title="Supplier correction message">
              {detail.supplierMessageDraft && resolution !== "RESOLVED" ? (
                <SupplierMessage message={detail.supplierMessageDraft} />
              ) : (
                <p className="text-sm text-slate-700">{resolution === "RESOLVED" ? "Resolved — no message to the supplier is needed." : "No supplier message is needed."}</p>
              )}
            </Section>

            <Section n={5} title="Revised invoice">
              {canRevalidate ? (
                <>
                  <p className="mb-4 text-sm text-slate-600">Upload the supplier&apos;s corrected invoice to check it against the PO and goods receipt.</p>
                  <div className="max-w-md">
                    <UploadField label="Corrected invoice" hint="PDF format" file={revised} onChange={setRevised} disabled={working} />
                  </div>
                  <div className="mt-5 flex flex-wrap items-center gap-4">
                    <button type="button" onClick={onRevalidate} disabled={!revised || !!validatePdf(revised) || working} className={PRIMARY}>
                      {busy === "revalidate" && <Spinner />}
                      {busy === "revalidate" ? "Verifying…" : "Verify revised invoice"}
                    </button>
                    {busy === "revalidate" && <span className="text-sm text-slate-500" role="status">Checking the revised invoice — about 20–40 seconds.</span>}
                  </div>
                  {error && error.scope === "revalidate" && busy === null && <div className="mt-4"><ErrorBox error={error} /></div>}
                </>
              ) : (
                <p className="text-sm text-slate-700">
                  {resolution === "RESOLVED" ? "No revised invoice is needed." : "A revised invoice can be uploaded once the case has been analysed successfully. If the last attempt failed, upload the three original documents again and re-analyse."}
                </p>
              )}
            </Section>

            <Section n={6} title="Case history">
              <CaseHistory detail={detail} />
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}
