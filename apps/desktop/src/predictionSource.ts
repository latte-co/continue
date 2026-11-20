import type { ComposerPredictionSnapshot, Event } from "./protocol";

export const MAX_PREDICTION_PENDING_IDENTITIES = 128;
export type PredictionSource = Readonly<{ requestId: string; seq: number }>;
type PredictionOrdering = Readonly<{
  user?: PredictionSource;
  /** Pure blocking fence, never User/admission evidence for another identity. */
  handoff?: PredictionSource;
  conflicted?: true;
}>;
type PredictionAttempt = Readonly<{
  requestId: string;
  seq: number | null;
  token?: number;
  handoffSeq?: number;
  conflicted?: true;
  provisional?: false;
}>;
export type PredictionSend = PredictionAttempt &
  Readonly<{
    ordering?: PredictionOrdering;
    pending?: readonly PredictionAttempt[];
    /** Correlation budget overflow: never guess that an untracked attempt resolved. */
    correlationLimited?: true;
  }>;

function waiting(attempt: PredictionAttempt | undefined): boolean {
  return (
    !!attempt &&
    attempt.provisional !== false &&
    attempt.seq === null &&
    attempt.handoffSeq === undefined
  );
}
function attemptFacts(send: PredictionSend): PredictionAttempt {
  const {
    ordering: _,
    pending: __,
    correlationLimited: ___,
    ...attempt
  } = send;
  return attempt;
}
function newerSource(
  previous: PredictionSource | undefined,
  next: PredictionSource | null,
): PredictionSource | undefined {
  return next && (!previous || next.seq > previous.seq) ? next : previous;
}
function foldOrdering(
  ordering: PredictionOrdering | undefined,
  attempt: PredictionAttempt | undefined,
): PredictionOrdering {
  const user = source(attempt?.requestId, attempt?.seq);
  const conflict =
    ordering?.user &&
    user &&
    ordering.user.seq === user.seq &&
    ordering.user.requestId !== user.requestId;
  return {
    user: newerSource(ordering?.user, user),
    handoff: newerSource(
      ordering?.handoff,
      source(attempt?.requestId, attempt?.handoffSeq),
    ),
    ...(ordering?.conflicted || attempt?.conflicted || conflict
      ? { conflicted: true }
      : {}),
  };
}
function compact(send: PredictionSend): PredictionSend {
  const known = (send.pending ?? []).filter((attempt) => !waiting(attempt));
  const pending = (send.pending ?? []).filter(waiting);
  const ordering = known.reduce(foldOrdering, send.ordering);
  const { pending: _, ordering: __, ...current } = send;
  return {
    ...current,
    ...(pending.length ? { pending } : {}),
    ...(ordering && (ordering.user || ordering.handoff || ordering.conflicted)
      ? { ordering }
      : {}),
  };
}

export function beginPredictionSend(
  previous: PredictionSend | undefined,
  requestId: string,
  token: number,
): PredictionSend {
  const ordering = foldOrdering(previous?.ordering, previous);
  const candidates = [
    ...(previous?.pending ?? []),
    ...(waiting(previous) && previous ? [attemptFacts(previous)] : []),
  ];
  // One correlated entry per identity. A newer token invalidates older operation callbacks.
  const identities = candidates.reduce<readonly PredictionAttempt[]>(
    (items, attempt) => [
      ...items.filter((item) => item.requestId !== attempt.requestId),
      attempt,
    ],
    [],
  );
  // A retry's active token and previous token share one identity budget slot.
  const maxPrevious =
    MAX_PREDICTION_PENDING_IDENTITIES -
    (identities.some((attempt) => attempt.requestId === requestId) ? 0 : 1);
  const previousFacts =
    previous?.requestId === requestId && !waiting(previous)
      ? attemptFacts(previous)
      : undefined;
  const { provisional: _, ...liveFacts } = previousFacts ?? {};
  return compact({
    ...liveFacts,
    requestId,
    token,
    seq:
      previousFacts?.seq ??
      (ordering.user?.requestId === requestId ? ordering.user.seq : null),
    ...(previousFacts?.handoffSeq !== undefined
      ? { handoffSeq: previousFacts.handoffSeq }
      : ordering.handoff?.requestId === requestId
        ? { handoffSeq: ordering.handoff.seq }
        : {}),
    ...(ordering.user || ordering.handoff || ordering.conflicted
      ? { ordering }
      : {}),
    ...(identities.length ? { pending: identities.slice(0, maxPrevious) } : {}),
    ...(previous?.correlationLimited || identities.length > maxPrevious
      ? { correlationLimited: true }
      : {}),
  });
}

function orderingAllows(
  ordering: PredictionOrdering | undefined,
  candidate: PredictionSource | null,
): boolean {
  return (
    !ordering ||
    (!ordering.conflicted &&
      candidate !== null &&
      (!ordering.handoff || candidate.seq > ordering.handoff.seq) &&
      (!ordering.user ||
        candidate.seq > ordering.user.seq ||
        (candidate.seq === ordering.user.seq &&
          candidate.requestId === ordering.user.requestId)))
  );
}
function attemptAllows(
  attempt: PredictionAttempt,
  candidate: PredictionSource | null,
): boolean {
  return (
    !attempt.conflicted &&
    candidate !== null &&
    (attempt.handoffSeq === undefined || candidate.seq > attempt.handoffSeq) &&
    (attempt.provisional === false ||
      (attempt.seq !== null
        ? candidate.seq > attempt.seq ||
          (candidate.seq === attempt.seq &&
            candidate.requestId === attempt.requestId)
        : attempt.handoffSeq !== undefined))
  );
}
function bindAttempt(
  attempt: PredictionAttempt,
  kind: "user" | "queued_message_sent",
  seq: number,
): PredictionAttempt {
  if (kind === "queued_message_sent")
    return { ...attempt, handoffSeq: Math.max(attempt.handoffSeq ?? 0, seq) };
  return attempt.seq !== null && attempt.seq !== seq
    ? { ...attempt, conflicted: true }
    : { ...attempt, seq };
}
function bindIdentity(
  send: PredictionSend,
  next: PredictionSource,
  kind: "user" | "queued_message_sent",
): PredictionSend {
  const current =
    send.requestId === next.requestId
      ? { ...send, ...bindAttempt(send, kind, next.seq) }
      : send;
  const pending = current.pending?.map((attempt) =>
    attempt.requestId === next.requestId
      ? bindAttempt(attempt, kind, next.seq)
      : attempt,
  );
  return { ...current, ...(pending ? { pending } : {}) };
}
function observeFact(
  send: PredictionSend,
  next: PredictionSource,
  kind: "user" | "queued_message_sent",
): PredictionSend {
  const observed = bindIdentity(send, next, kind);
  if (kind === "queued_message_sent")
    return {
      ...observed,
      ordering: {
        ...observed.ordering,
        handoff: newerSource(observed.ordering?.handoff, next),
      },
    };
  return observed.ordering?.user?.requestId === next.requestId &&
    observed.ordering.user.seq !== next.seq
    ? { ...observed, ordering: { ...observed.ordering, conflicted: true } }
    : observed;
}
function observeSendFacts(
  send: PredictionSend | undefined,
  events: Event[],
  sessionId: string,
): PredictionSend | undefined {
  return events.reduce((current, event) => {
    if (
      event.session_id !== sessionId ||
      (event.event.kind !== "user" &&
        event.event.kind !== "queued_message_sent")
    )
      return current;
    const next = source(event.event.request_id, event.seq);
    if (!next) return current;
    // Unrelated handoffs can only strengthen blocking; they never resolve pending IDs.
    if (!current && event.event.kind !== "queued_message_sent") return current;
    return compact(
      observeFact(
        current ?? { requestId: "", seq: null, provisional: false },
        next,
        event.event.kind,
      ),
    );
  }, send);
}
function observeSnapshot(
  send: PredictionSend,
  candidate: PredictionSource,
): PredictionSend {
  const mayBind = (attempt: PredictionAttempt) =>
    attempt.requestId === candidate.requestId &&
    (attempt.handoffSeq === undefined || candidate.seq > attempt.handoffSeq);
  const current = mayBind(send)
    ? { ...send, ...bindAttempt(send, "user", candidate.seq) }
    : send;
  const pending = current.pending?.map((attempt) =>
    mayBind(attempt) ? bindAttempt(attempt, "user", candidate.seq) : attempt,
  );
  const observed = { ...current, ...(pending ? { pending } : {}) };
  return compact(
    observed.ordering?.user?.requestId === candidate.requestId &&
      observed.ordering.user.seq !== candidate.seq
      ? { ...observed, ordering: { ...observed.ordering, conflicted: true } }
      : observed,
  );
}

/** A larger arbitrary source seq cannot resolve an unknown local Send identity. */
export function predictionAfterSend(
  send: PredictionSend | undefined,
  events: Event[],
  snapshot: ComposerPredictionSnapshot | null | undefined,
  sessionId: string,
): { send: PredictionSend | undefined; allowed: boolean } {
  let observed = observeSendFacts(send, events, sessionId);
  if (!observed) return { send: observed, allowed: true };
  const candidate = source(
    snapshot?.source_request_id,
    snapshot?.source_user_seq,
  );
  if (candidate) observed = observeSnapshot(observed, candidate);
  return {
    send: observed,
    allowed:
      !observed.correlationLimited &&
      !observed.pending?.length &&
      orderingAllows(observed.ordering, candidate) &&
      attemptAllows(observed, candidate),
  };
}

export function capturePredictionAttempt(
  send: PredictionSend | undefined,
  requestId: string,
): PredictionAttempt | undefined {
  return send?.requestId === requestId && send.provisional !== false
    ? attemptFacts(send)
    : send?.pending?.find((attempt) => attempt.requestId === requestId);
}
function retiredCurrent(send: PredictionSend): PredictionSend | undefined {
  const retired = compact({ ...send, provisional: false });
  return retired.ordering ||
    retired.pending?.length ||
    retired.correlationLimited
    ? retired
    : undefined;
}
/** Send rejection retires only its attempt. Queue retirement is authoritative for the captured request identity. */
export function retirePredictionSend(
  captured: PredictionAttempt | undefined,
  current: PredictionSend | undefined,
  requestId: string,
  authoritative = false,
): PredictionSend | undefined {
  if (!captured || captured.requestId !== requestId || !current) return current;
  if (authoritative) {
    const target = capturePredictionAttempt(current, requestId);
    if (!target || target.token !== captured.token) return current;
    if (
      current.requestId === requestId &&
      (current.seq !== null ||
        current.handoffSeq !== undefined ||
        current.conflicted)
    )
      return current;
    const pending = current.pending?.filter(
      (attempt) => attempt.requestId !== requestId,
    );
    const remaining = { ...current, ...(pending ? { pending } : {}) };
    return current.requestId === requestId
      ? retiredCurrent(remaining)
      : compact(remaining);
  }
  if (
    current.requestId !== requestId ||
    current.token !== captured.token ||
    current.seq !== null ||
    current.handoffSeq !== undefined ||
    current.conflicted ||
    current.provisional === false
  )
    return current;
  return retiredCurrent(current);
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
