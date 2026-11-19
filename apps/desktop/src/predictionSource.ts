import type { ComposerPredictionSnapshot, Event } from "./protocol";

export type PredictionSource = Readonly<{ requestId: string; seq: number }>;
export type PredictionSend = Readonly<{
  requestId: string;
  seq: number | null;
  token?: number;
}>;

/** A larger old cache seq alone does not prove it belongs after a local Send. */
export function predictionAfterSend(
  send: PredictionSend | undefined,
  events: Event[],
  snapshot: ComposerPredictionSnapshot | null | undefined,
  sessionId: string,
): { send: PredictionSend | undefined; allowed: boolean } {
  if (!send) return { send, allowed: true };
  const admitted = observePredictionSource(
    null,
    events.filter(
      (event) =>
        event.event.kind === "user" &&
        event.event.request_id === send.requestId,
    ),
    sessionId,
  );
  const candidate = source(
    snapshot?.source_request_id,
    snapshot?.source_user_seq,
  );
  const seq =
    send.seq ??
    admitted?.seq ??
    (candidate?.requestId === send.requestId ? candidate.seq : null);
  return {
    send: { ...send, seq },
    allowed:
      seq !== null &&
      candidate !== null &&
      (candidate.seq > seq ||
        (candidate.seq === seq && candidate.requestId === send.requestId)),
  };
}

function source(requestId: unknown, seq: unknown): PredictionSource | null {
  return typeof requestId === "string" &&
    !!requestId.trim() &&
    typeof seq === "number" &&
    Number.isSafeInteger(seq) &&
    seq > 0
    ? { requestId, seq }
    : null;
}

/** Older transcript pages must never be passed here; this is the live source frontier. */
export function observePredictionSource(
  frontier: PredictionSource | null,
  events: Event[],
  sessionId: string,
): PredictionSource | null {
  return events.reduce((current, event) => {
    const next =
      event.session_id === sessionId && event.event.kind === "user"
        ? source(event.event.request_id, event.seq)
        : null;
    return next && (!current || next.seq > current.seq) ? next : current;
  }, frontier);
}

/** undefined rejects a stale/conflicting snapshot; null clears an unavailable one. */
export function consumePredictionSnapshot(
  frontier: PredictionSource | null,
  snapshot: ComposerPredictionSnapshot | null | undefined,
): {
  frontier: PredictionSource | null;
  snapshot: ComposerPredictionSnapshot | null | undefined;
} {
  const next = source(snapshot?.source_request_id, snapshot?.source_user_seq);
  if (!next) return { frontier, snapshot: null };
  if (
    frontier &&
    (next.seq < frontier.seq ||
      (next.seq === frontier.seq && next.requestId !== frontier.requestId))
  )
    return { frontier, snapshot: undefined };
  return {
    frontier: !frontier || next.seq > frontier.seq ? next : frontier,
    snapshot:
      snapshot?.status === "ready" || snapshot?.status === "pending"
        ? snapshot
        : null,
  };
}
