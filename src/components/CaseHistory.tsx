import type { z } from "zod";
import type { Discrepancy } from "@/lib/contracts";
import type { CaseDetail } from "@/lib/ui/api-client";
import { formatRupees, formatWhen } from "@/lib/ui/format";

const pretty = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function CaseHistory({ detail }: { detail: CaseDetail }) {
  const resolved: z.infer<typeof Discrepancy>[] = detail.resolvedDiscrepancies;
  const events = [...detail.events].reverse();
  return (
    <div className="space-y-6">
      {resolved.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-slate-800">Previously resolved findings</h3>
          <ul className="space-y-2">
            {resolved.map((d, i) => (
              <li key={i} className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-950 ring-1 ring-emerald-200">
                <span className="font-medium">{pretty(d.issueType)}</span> · {formatRupees(d.amountUnderReviewPaise)} — {d.description}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <h3 className="mb-2 text-sm font-semibold text-slate-800">Timeline</h3>
        {events.length === 0 ? (
          <p className="text-sm text-slate-500">No activity recorded yet.</p>
        ) : (
          <ol className="relative space-y-4 border-l border-slate-200 pl-5">
            {events.map((e) => (
              <li key={e.eventId} className="relative">
                <span className="absolute -left-[26px] top-1.5 h-2.5 w-2.5 rounded-full bg-slate-400 ring-4 ring-white" aria-hidden />
                <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
                  <span className="font-medium text-slate-900">{pretty(e.eventType)}</span>
                  <span className="text-xs text-slate-500">{pretty(e.actorType)} · {formatWhen(e.createdAt)}</span>
                </div>
                {e.note && <p className="text-sm text-slate-600">{e.note}</p>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
