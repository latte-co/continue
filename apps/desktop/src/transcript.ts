import type { Event, TurnChanges, QuestionAnswer } from "./protocol";

/** Match the change card's visibility before creating transcript boundaries. */
export function hasTurnChangeFiles(changes: TurnChanges): boolean {
  return changes.summary.entries.length > 0;
}
/** Undo/status events for older turns must not replace the latest turn. */
export function latestTurnChanges(events: Event[]): TurnChanges | undefined {
  type RecordedTurn = { changes: TurnChanges; at: number; seq: number };
  const turns = new Map<string, RecordedTurn>();
  for (const { event, at, seq } of events) {
    if (event.kind !== "turn_changes") continue;
    const changes = event.changes;
    const previous = turns.get(changes.request_id);
    turns.set(changes.request_id, {
      changes,
      at: changes.summary.baseline_at ?? previous?.at ?? at,
      seq: previous?.seq ?? seq,
    });
  }
  return [...turns.values()].reduce<RecordedTurn | undefined>(
    (latest, turn) =>
      !latest ||
      turn.at > latest.at ||
      (turn.at === latest.at && turn.seq > latest.seq)
        ? turn
        : latest,
    undefined,
  )?.changes;
}
export type Item =
  | {
      key: number;
      type: "user";
      text: string;
      at: number;
      handoff?: true;
      hidden?: true;
    }
  | { key: number; type: "assistant"; text: string }
  | {
      key: number;
      type: "event";
      value: Event["event"];
      resolved?: boolean;
      answers?: QuestionAnswer[] | null;
      decision?: "allowed" | "denied" | "expired";
    };
export function appendEvents(existing: Event[], incoming: Event[]): Event[] {
  // Overlapping poll and history windows can repeat inside either side of a
  // merge, so the seq key is applied across both sides at once. seq is only
  // unique within one session, hence the compound key.
  const seen = new Set<string>();
  return [...existing, ...incoming]
    .filter((e) => {
      const key = `${e.session_id}\u0000${e.seq}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.seq - b.seq);
}
const inputKey = (sessionId: string, requestId: string) =>
  JSON.stringify([sessionId, requestId]);

/** Correlate delivery and execution without matching unrelated repeated text. */
export function queuedInputReceipts(events: Event[]) {
  const receipts = new Map<string, { text: string; seq: number }>();
  for (const { event, session_id, seq } of events) {
    if (event.kind !== "queued_message_sent") continue;
    const key = inputKey(session_id, event.request_id);
    if (!receipts.has(key)) receipts.set(key, { text: event.text, seq });
  }
  return receipts;
}

function isDuplicateTerminalErrorText(events: Event[], index: number): boolean {
  const current = events[index];
  if (current?.event.kind !== "text") return false;
  const trimmed = current.event.text.trim();
  if (!trimmed) return false;
  for (let j = index + 1; j < events.length; j++) {
    const next = events[j];
    if (next.session_id !== current.session_id) continue;
    const kind = next.event.kind;
    if (
      kind === "usage" ||
      kind === "progress" ||
      kind === "subagent" ||
      kind === "turn_changes" ||
      kind === "approval_resolved" ||
      kind === "question_resolved"
    )
      continue;
    if (kind === "state") {
      if (next.event.status === "running" || next.event.status === "waiting")
        continue;
      return (
        next.event.status === "failed" &&
        !!next.event.message &&
        next.event.message.trim() === trimmed
      );
    }
    return false;
  }
  return false;
}

export function transcript(
  events: Event[],
  receipts = queuedInputReceipts(events),
): Item[] {
  const items: Item[] = [];
  const resolved = new Map(
    events.flatMap((e) =>
      e.event.kind === "approval_resolved"
        ? [[e.event.request_id, e.event.allow] as const]
        : [],
    ),
  );
  const answered = new Map(
    events.flatMap(({ event }) =>
      event.kind === "question_resolved"
        ? [[event.request_id, event.answers] as const]
        : [],
    ),
  );
  const terminal = events
    .filter(
      (e) =>
        e.event.kind === "state" &&
        !["running", "waiting"].includes(e.event.status),
    )
    .map((e) => e.seq);
  const turnChanges = new Map(
    events.flatMap(({ event }) =>
      event.kind === "turn_changes"
        ? [[event.changes.request_id, event] as const]
        : [],
    ),
  );
  const renderedChanges = new Set<string>();
  for (let index = 0; index < events.length; index++) {
    const { seq, event, at, session_id } = events[index];
    if (event.kind === "turn_changes") {
      if (!renderedChanges.has(event.changes.request_id)) {
        items.push({
          key: seq,
          type: "event",
          value: turnChanges.get(event.changes.request_id)!,
        });
        renderedChanges.add(event.changes.request_id);
      }
      continue;
    }
    if (
      event.kind === "usage" ||
      event.kind === "progress" ||
      event.kind === "subagent"
    )
      continue;
    if (event.kind === "queued_message_sent") {
      if (receipts.get(inputKey(session_id, event.request_id))?.seq === seq)
        items.push({
          key: seq,
          type: "user",
          text: event.text,
          at,
          handoff: true,
        });
    } else if (event.kind === "user") {
      const receipt = receipts.get(inputKey(session_id, event.request_id));
      items.push({
        key: seq,
        type: "user",
        text: event.text,
        at,
        ...(receipt?.text === event.text && receipt.seq < seq
          ? { hidden: true as const }
          : {}),
      });
    } else if (event.kind === "text") {
      if (isDuplicateTerminalErrorText(events, index)) continue;
      const last = items.at(-1);
      if (last?.type === "assistant") last.text += event.text;
      else items.push({ key: seq, type: "assistant", text: event.text });
    } else if (event.kind === "question") {
      items.push({
        key: seq,
        type: "event",
        value: event,
        resolved:
          answered.has(event.request_id) || terminal.some((end) => end > seq),
        answers: answered.get(event.request_id),
      });
    } else if (event.kind === "approval") {
      const inactive = terminal.some((end) => end > seq);
      items.push({
        key: seq,
        type: "event",
        value: event,
        resolved: inactive || resolved.has(event.request_id),
        decision: resolved.has(event.request_id)
          ? resolved.get(event.request_id)
            ? "allowed"
            : "denied"
          : inactive
            ? "expired"
            : undefined,
      });
    } else if (
      event.kind === "state"
        ? !!event.message
        : event.kind !== "approval_resolved" &&
          event.kind !== "question_resolved"
    ) {
      if (
        event.kind === "state" &&
        event.status === "failed" &&
        event.message
      ) {
        for (let k = items.length - 1; k >= 0; k--) {
          const prev = items[k];
          if (prev.type === "event" && prev.value.kind === "turn_changes")
            continue;
          if (
            prev.type === "assistant" &&
            prev.text.trim() === event.message.trim()
          ) {
            items.splice(k, 1);
          }
          break;
        }
      }
      items.push({ key: seq, type: "event", value: event });
    }
  }
  // Keep the row breaks created during projection: removing invisible metadata
  // must not concatenate distinct assistant paragraphs or mutate saved events.
  return items.filter(
    (item) =>
      item.type !== "event" ||
      item.value.kind !== "turn_changes" ||
      hasTurnChangeFiles(item.value.changes),
  );
}
