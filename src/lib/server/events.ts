import "server-only";
import { db } from "./supabase";

export type EventType = "UPLOADED" | "ANALYSIS_STARTED" | "ANALYSIS_COMPLETED" | "REVALIDATED" | "ERROR";
export type ActorType = "SYSTEM" | "AI" | "USER" | "SUPPLIER";

// Payloads must hold safe summaries and references only (ids, counts, codes),
// never document contents, prompts or credentials.
export async function recordEvent(
  caseId: string,
  eventType: EventType,
  actorType: ActorType,
  note: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db()
    .from("case_events")
    .insert({ case_id: caseId, event_type: eventType, actor_type: actorType, note, payload });
  if (error) {
    // Audit failure must not mask the original outcome; surface it in logs.
    console.error(`[events] failed to record ${eventType} for case ${caseId}: ${error.code ?? ""}`);
  }
}
