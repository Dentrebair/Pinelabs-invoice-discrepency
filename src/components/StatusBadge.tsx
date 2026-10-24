import type { z } from "zod";
import type { CaseStatus } from "@/lib/contracts";
import { RESOLUTION_LABEL, resolutionFor, type Resolution } from "@/lib/ui/format";

const STYLES: Record<Resolution, string> = {
  RESOLVED: "bg-emerald-50 text-emerald-800 ring-emerald-600/20",
  NEEDS_CORRECTION: "bg-amber-50 text-amber-900 ring-amber-600/25",
  AWAITING_REVIEW: "bg-slate-100 text-slate-700 ring-slate-500/20",
};
const DOT: Record<Resolution, string> = {
  RESOLVED: "bg-emerald-500",
  NEEDS_CORRECTION: "bg-amber-500",
  AWAITING_REVIEW: "bg-slate-400",
};

export function StatusBadge({ status, large = false }: { status: z.infer<typeof CaseStatus>; large?: boolean }) {
  const r = resolutionFor(status);
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full font-medium ring-1 ring-inset ${STYLES[r]} ${large ? "px-4 py-1.5 text-base" : "px-3 py-1 text-sm"}`}
      title={status}
    >
      <span className={`h-2 w-2 rounded-full ${DOT[r]}`} aria-hidden />
      {RESOLUTION_LABEL[r]}
    </span>
  );
}
