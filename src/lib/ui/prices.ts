import { ExtractedDocument, type Discrepancy } from "@/lib/contracts";
import type { z } from "zod";
import type { CaseDocument } from "./api-client";

type Ref = z.infer<typeof Discrepancy>["evidenceRefs"][number];

/** Unit price (paise) of the line a piece of evidence points at, read from the saved extraction. */
export function unitPriceFor(documents: CaseDocument[], ref: Ref | undefined): number | null {
  if (!ref) return null;
  const candidates = documents
    .filter((d) => d.docType === ref.docType && d.documentNumber === ref.documentNumber)
    .sort((a, b) => b.version - a.version);
  const parsed = candidates.length ? ExtractedDocument.safeParse(candidates[0].extractedJson) : null;
  const index = /^items\[(\d+)\]/.exec(ref.field)?.[1];
  if (!parsed?.success || index === undefined) return null;
  return parsed.data.items[Number(index)]?.unitPricePaise ?? null;
}
