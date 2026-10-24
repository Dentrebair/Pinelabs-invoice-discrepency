import type { z } from "zod";
import type { CaseStatus } from "@/lib/contracts";

type Status = z.infer<typeof CaseStatus>;

/** Display only: integer paise -> "₹10,000" / "₹499.50". No financial arithmetic happens in the UI. */
export function formatRupees(paise: number): string {
  const whole = Math.trunc(paise / 100).toLocaleString("en-IN");
  const rem = paise % 100;
  return `₹${whole}${rem ? `.${String(rem).padStart(2, "0")}` : ""}`;
}

export type Resolution = "RESOLVED" | "NEEDS_CORRECTION" | "AWAITING_REVIEW";

export const RESOLUTION_LABEL: Record<Resolution, string> = {
  RESOLVED: "Resolved",
  NEEDS_CORRECTION: "Needs correction",
  AWAITING_REVIEW: "Awaiting review",
};

/** Maps the backend CaseStatus to the three resolution states shown to the merchant. */
export function resolutionFor(status: Status): Resolution {
  switch (status) {
    case "READY_FOR_PAYMENT_APPROVAL":
    case "NO_DISCREPANCY":
      return "RESOLVED";
    case "DISCREPANCY_FOUND":
    case "AWAITING_APPROVAL":
    case "AWAITING_SUPPLIER":
      return "NEEDS_CORRECTION";
    default:
      return "AWAITING_REVIEW"; // DRAFT, ANALYZING, REVALIDATING, NEEDS_REVIEW, ERROR
  }
}

/** Statuses for which POST /api/revalidate is accepted by the backend. */
export const CAN_REVALIDATE: Status[] = ["DISCREPANCY_FOUND", "AWAITING_APPROVAL", "AWAITING_SUPPLIER", "NEEDS_REVIEW", "ERROR"];

/** "items[0].quantity" -> "Line 1 · quantity" (raw path stays available as a tooltip). */
export function humanField(field: string): string {
  const m = /^items\[(\d+)\]\.?(.*)$/.exec(field);
  if (!m) return field;
  return `Line ${Number(m[1]) + 1}${m[2] ? ` · ${m[2].replace(/Paise$/, "")}` : ""}`;
}

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}
