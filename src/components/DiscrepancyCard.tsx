import type { z } from "zod";
import type { Discrepancy } from "@/lib/contracts";
import type { CaseDocument } from "@/lib/ui/api-client";
import { formatRupees, humanField } from "@/lib/ui/format";
import { unitPriceFor } from "@/lib/ui/prices";

type D = z.infer<typeof Discrepancy>;

const TYPE_LABEL: Record<D["issueType"], string> = {
  QUANTITY: "Quantity mismatch",
  PRICE: "Price mismatch",
  DUPLICATE: "Possible duplicate",
  MISSING_DOCUMENT: "Missing document",
  TAX: "Tax difference",
  OTHER: "Needs review",
};

const DOC_LABEL: Record<string, string> = { PO: "PO", INVOICE: "Invoice", GRN: "GRN", REVISED_INVOICE: "Revised invoice" };

function Tile({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-lg bg-slate-50 px-4 py-3 text-center ring-1 ring-slate-200">
      <div className="text-3xl font-semibold tabular-nums text-slate-900">{value ?? "—"}</div>
      <div className="mt-0.5 text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
    </div>
  );
}

export function DiscrepancyCard({ d, documents }: { d: D; documents: CaseDocument[] }) {
  const poRef = d.evidenceRefs.find((r) => r.docType === "PO" && /unitPrice|quantity/.test(r.field));
  const invRef = d.evidenceRefs.find((r) => r.docType === "INVOICE" || r.docType === "REVISED_INVOICE");
  const poPrice = unitPriceFor(documents, poRef);
  const invPrice = unitPriceFor(documents, invRef);
  const priceDiffers = poPrice !== null && invPrice !== null && poPrice !== invPrice;

  return (
    <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-slate-900">
          {TYPE_LABEL[d.issueType]}
          {d.lineRef && <span className="ml-2 font-normal text-slate-500">· {d.lineRef}</span>}
        </h3>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Tile label="Ordered" value={d.orderedQty} />
        <Tile label="Invoiced" value={d.invoicedQty} />
        <Tile label="Received" value={d.receivedQty} />
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg bg-amber-50 px-4 py-3 ring-1 ring-amber-200">
          <dt className="text-xs font-medium uppercase tracking-wide text-amber-900">Amount requiring review</dt>
          <dd className="mt-0.5 text-2xl font-semibold tabular-nums text-amber-950">{formatRupees(d.amountUnderReviewPaise)}</dd>
          <dd className="text-xs text-amber-900/80">before GST</dd>
        </div>
        <div className="rounded-lg bg-slate-50 px-4 py-3 ring-1 ring-slate-200">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Unit price</dt>
          <dd className="mt-0.5 text-2xl font-semibold tabular-nums text-slate-900">
            {poPrice !== null ? formatRupees(poPrice) : invPrice !== null ? formatRupees(invPrice) : "—"}
          </dd>
          <dd className="text-xs text-slate-500">
            {priceDiffers ? `PO ${formatRupees(poPrice!)} · invoice ${formatRupees(invPrice!)}` : poPrice !== null ? "per PO" : invPrice !== null ? "per invoice" : "not available"}
          </dd>
        </div>
      </dl>

      <p className="mt-4 text-sm leading-relaxed text-slate-700">{d.description}</p>

      <div className="mt-4 rounded-lg border-l-4 border-indigo-500 bg-indigo-50 px-4 py-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-indigo-900">Recommended action</div>
        <p className="mt-0.5 text-sm text-indigo-950">{d.recommendedAction}</p>
      </div>

      {d.evidenceRefs.length > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Supporting evidence</div>
          <ul className="flex flex-wrap gap-2">
            {d.evidenceRefs.map((r, i) => (
              <li
                key={`${r.docType}-${r.field}-${i}`}
                title={`${r.documentNumber} ${r.field}`}
                className="rounded-md bg-slate-100 px-2.5 py-1 text-xs text-slate-700 ring-1 ring-slate-200"
              >
                <span className="font-semibold">{DOC_LABEL[r.docType] ?? r.docType}</span> {r.documentNumber} · {humanField(r.field)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}
