import { expect, it } from "vitest";
import type { ComposerPredictionSnapshot, Event } from "./protocol";
import {
  beginPredictionSend,
  MAX_PREDICTION_PENDING_IDENTITIES,
  capturePredictionAttempt,
  consumePredictionSnapshot,
  observePredictionSource,
  predictionAfterSend,
  retirePredictionSend,
} from "./predictionSource";

const frontier = { requestId: "B", seq: 30 };
const ready = (
  requestId: string | null,
  seq: number | null,
): ComposerPredictionSnapshot => ({
  status: "ready",
  source_request_id: requestId,
  source_user_seq: seq,
  generation_id: "generation",
  suggestion: "next step",
});
const user = (requestId: string, seq: number, sessionId = "s"): Event => ({
  session_id: sessionId,
  seq,
  at: 1,
  event: { kind: "user", request_id: requestId, text: requestId },
});

it("accepts a bounded-window source without a transcript User", () => {
  const snapshot = ready("B", 30);
  expect(consumePredictionSnapshot(null, snapshot)).toEqual({
    frontier,
    snapshot,
  });
});
it("advances by source seq rather than request ID or array order", () => {
  expect(
    observePredictionSource(
      frontier,
      [user("D", 50), user("C", 40), user("A", 10)],
      "s",
    ),
  ).toEqual({ requestId: "D", seq: 50 });
});
it.each([ready("A", 10), ready("A", 30)])(
  "rejects stale/conflicting snapshots without lowering the frontier",
  (snapshot) => {
    expect(consumePredictionSnapshot(frontier, snapshot)).toEqual({
      frontier,
      snapshot: undefined,
    });
  },
);
it.each([
  null,
  undefined,
  ready(null, 30),
  ready("", 30),
  ready("  ", 30),
  ready("B", null),
  ready("B", 0),
  ready("B", -1),
  ready("B", 1.5),
  ready("B", Infinity),
  ready("B", Number.MAX_SAFE_INTEGER + 1),
])(
  "clears invalid/unavailable snapshots while preserving the frontier %#",
  (snapshot) => {
    expect(consumePredictionSnapshot(frontier, snapshot)).toEqual({
      frontier,
      snapshot: null,
    });
  },
);
it.each(["none", "failed", "unsupported"] as const)(
  "clears %s and still advances its valid source",
  (status) => {
    expect(
      consumePredictionSnapshot(frontier, { ...ready("C", 40), status }),
    ).toEqual({ frontier: { requestId: "C", seq: 40 }, snapshot: null });
  },
);
it("keeps pending cache snapshots refreshable", () => {
  const snapshot = {
    ...ready("B", 30),
    status: "pending" as const,
    suggestion: null,
  };
  expect(consumePredictionSnapshot(frontier, snapshot)).toEqual({
    frontier,
    snapshot,
  });
});
it("ignores invalid Users, foreign sessions and same-seq request conflicts", () => {
  const events = [
    user("", 90),
    user("  ", 100),
    user("foreign", 110, "other"),
    user("C", 30),
    user("fraction", 120.5),
  ];
  expect(observePredictionSource(frontier, events, "s")).toBe(frontier);
});
it("accepts snapshots normally when no local Send needs reconciliation", () => {
  expect(predictionAfterSend(undefined, [], ready("B", 30), "s")).toEqual({
    send: undefined,
    allowed: true,
  });
});
it("does not mistake a larger cache seq for evidence of the new local Send", () => {
  const send = { requestId: "C", seq: null };
  expect(predictionAfterSend(send, [], ready("B", 30), "s")).toEqual({
    send,
    allowed: false,
  });
});
it("binds the new send seq from a matching cached snapshot without requiring its User history", () => {
  expect(
    predictionAfterSend({ requestId: "C", seq: null }, [], ready("C", 40), "s"),
  ).toEqual({ send: { requestId: "C", seq: 40 }, allowed: true });
});
it("retains a local send's anchor even when a later external User is in the same frame", () => {
  expect(
    predictionAfterSend(
      { requestId: "C", seq: null },
      [user("C", 40), user("D", 50)],
      ready("D", 50),
      "s",
    ),
  ).toEqual({ send: { requestId: "C", seq: 40 }, allowed: true });
});
it.each([ready("B", 30), ready("B", 40), ready(null, null)])(
  "rejects older, conflicting and unavailable snapshots after a known Send",
  (snapshot) => {
    const send = { requestId: "C", seq: 40 };
    expect(predictionAfterSend(send, [], snapshot, "s")).toEqual({
      send,
      allowed: false,
    });
  },
);
const handoff = (requestId: string, seq: number, sessionId = "s"): Event => ({
  session_id: sessionId,
  seq,
  at: 1,
  event: {
    kind: "queued_message_sent",
    request_id: requestId,
    text: requestId,
  },
});
it("uses matching handoff as a strict fence, never a User source", () => {
  const events = [handoff("C", 40)];
  const observed = predictionAfterSend(
    { requestId: "C", seq: null },
    events,
    ready("D", 50),
    "s",
  );
  expect(observed.allowed).toBe(true);
  expect(observed.send?.seq).toBeNull();
  expect(observePredictionSource(frontier, events, "s")).toBe(frontier);
  expect(
    predictionAfterSend(observed.send, [], ready("D", 40), "s").allowed,
  ).toBe(false);
  expect(
    predictionAfterSend(observed.send, [], ready("C", 40), "s").allowed,
  ).toBe(false);
  expect(
    predictionAfterSend(observed.send, [], ready("D", 50), "s").allowed,
  ).toBe(true);
});
it.each([handoff("other", 40), handoff("C", 40, "foreign"), handoff("C", 1.5)])(
  "does not unlock from unrelated, foreign or invalid handoff %#",
  (event) => {
    expect(
      predictionAfterSend(
        { requestId: "C", seq: null },
        [event],
        ready("D", 50),
        "s",
      ).allowed,
    ).toBe(false);
  },
);
it("fails closed on contradictory matching User anchors across frames", () => {
  const first = predictionAfterSend(
    { requestId: "C", seq: null },
    [user("C", 40)],
    null,
    "s",
  );
  const conflict = predictionAfterSend(
    first.send,
    [user("C", 45)],
    ready("D", 50),
    "s",
  );
  expect(conflict.allowed).toBe(false);
  expect(
    predictionAfterSend(conflict.send, [], ready("D", 60), "s").allowed,
  ).toBe(false);
});
it("does not let a conflicting User anchor or snapshot rewrite an observed send", () => {
  const known = { requestId: "C", seq: 40 };
  expect(
    predictionAfterSend(known, [user("C", 45)], ready("D", 50), "s").allowed,
  ).toBe(false);
  expect(predictionAfterSend(known, [], ready("C", 45), "s").allowed).toBe(
    false,
  );
});
it("retires only the captured request/token and preserves durable facts", () => {
  const captured = Object.freeze({ requestId: "C", seq: null, token: 1 });
  expect(retirePredictionSend(captured, captured, "C")).toBeUndefined();
  for (const current of [
    { ...captured, requestId: "D" },
    { ...captured, token: 2 },
    { ...captured, seq: 40 },
    { ...captured, handoffSeq: 40 },
    { ...captured, conflicted: true as const },
  ])
    expect(retirePredictionSend(captured, current, "C")).toBe(current);
  expect(retirePredictionSend(undefined, captured, "C")).toBe(captured);
  expect(retirePredictionSend(captured, captured, "D")).toBe(captured);
});
it("matching repeated receipts are idempotent, including mixed User/handoff facts", () => {
  const events = [user("C", 35), handoff("C", 40), handoff("C", 40)];
  const first = predictionAfterSend(
    { requestId: "C", seq: null },
    events,
    ready("D", 50),
    "s",
  );
  expect(first.allowed).toBe(true);
  expect(first.send?.seq).toBe(35);
  expect(predictionAfterSend(first.send, events, ready("D", 50), "s")).toEqual(
    first,
  );
  expect(predictionAfterSend(first.send, [], ready("C", 35), "s").allowed).toBe(
    false,
  );
});
it("keeps constant-size ordering facts across many retired attempts", () => {
  let send = predictionAfterSend(
    beginPredictionSend(undefined, "C", 1),
    [user("C", 35), handoff("C", 40)],
    null,
    "s",
  ).send;
  for (let token = 2; token < 1002; token++) {
    const attempt = beginPredictionSend(send, `E-${token}`, token);
    send = retirePredictionSend(attempt, attempt, attempt.requestId);
    expect(predictionAfterSend(send, [], ready("A", 10), "s").allowed).toBe(
      false,
    );
    expect(predictionAfterSend(send, [], ready("D", 50), "s").allowed).toBe(
      true,
    );
    expect(JSON.stringify(send).length).toBeLessThan(300);
  }
  const conflict = predictionAfterSend(
    send,
    [user("C", 45)],
    ready("D", 50),
    "s",
  );
  expect(conflict.allowed).toBe(false);
  const next = beginPredictionSend(conflict.send, "F", 1002);
  const retired = retirePredictionSend(next, next, "F");
  expect(predictionAfterSend(retired, [], ready("G", 100), "s").allowed).toBe(
    false,
  );
});
it("retains the newest durable User bound and rejects stale token retirement after a new attempt", () => {
  const first = predictionAfterSend(
    beginPredictionSend(undefined, "C", 1),
    [user("C", 40)],
    null,
    "s",
  ).send;
  const second = beginPredictionSend(first, "E", 2);
  expect(retirePredictionSend(first, second, "C")).toBe(second);
  const retired = retirePredictionSend(second, second, "E");
  expect(predictionAfterSend(retired, [], ready("C", 40), "s").allowed).toBe(
    true,
  );
  expect(predictionAfterSend(retired, [], ready("D", 40), "s").allowed).toBe(
    false,
  );
  expect(predictionAfterSend(retired, [], ready("A", 10), "s").allowed).toBe(
    false,
  );
});
it("uses the max fence for legitimate same-request redispatch, without inventing a User", () => {
  const first = predictionAfterSend(
    beginPredictionSend(undefined, "C", 1),
    [handoff("C", 40)],
    ready("D", 50),
    "s",
  );
  const again = predictionAfterSend(
    first.send,
    [handoff("C", 45)],
    ready("D", 50),
    "s",
  );
  expect(again.allowed).toBe(true);
  expect(again.send?.seq).toBeNull();
  const later = predictionAfterSend(
    again.send,
    [handoff("C", 55)],
    ready("D", 50),
    "s",
  );
  expect(later.allowed).toBe(false);
  expect(
    predictionAfterSend(later.send, [handoff("C", 40)], ready("D", 50), "s")
      .allowed,
  ).toBe(false);
  expect(predictionAfterSend(later.send, [], ready("E", 60), "s").allowed).toBe(
    true,
  );
  const next = beginPredictionSend(later.send, "F", 2);
  const retired = retirePredictionSend(next, next, "F");
  const inherited = predictionAfterSend(
    retired,
    [handoff("C", 65)],
    ready("E", 60),
    "s",
  );
  expect(inherited.allowed).toBe(false);
  expect(
    predictionAfterSend(inherited.send, [], ready("G", 70), "s").allowed,
  ).toBe(true);
});
it("reuses retained same-ID facts even after an intervening rejected attempt", () => {
  const first = predictionAfterSend(
    beginPredictionSend(undefined, "C", 1),
    [user("C", 35), handoff("C", 40)],
    null,
    "s",
  ).send;
  const second = beginPredictionSend(first, "E", 2);
  const retired = retirePredictionSend(second, second, "E");
  const retry = beginPredictionSend(retired, "C", 3);
  expect(predictionAfterSend(retry, [], ready("D", 50), "s").allowed).toBe(
    true,
  );
  expect(predictionAfterSend(retry, [], ready("A", 10), "s").allowed).toBe(
    false,
  );
});
it("fails closed on a contradictory cached User identity retained across newer Send retirement", () => {
  const first = predictionAfterSend(
    beginPredictionSend(undefined, "C", 1),
    [user("C", 40)],
    null,
    "s",
  ).send;
  const second = beginPredictionSend(first, "E", 2);
  const retired = retirePredictionSend(second, second, "E");
  const conflict = predictionAfterSend(retired, [], ready("C", 45), "s");
  expect(conflict.allowed).toBe(false);
  expect(
    predictionAfterSend(conflict.send, [], ready("D", 50), "s").allowed,
  ).toBe(false);
});
it("bounds multiple unresolved Send identities and fails closed instead of losing unknown work", () => {
  let send = beginPredictionSend(undefined, "C", 1);
  for (let token = 2; token < 1002; token++) {
    send = beginPredictionSend(send, `Unknown-${token}`, token);
    expect((send.pending?.length ?? 0) + 1).toBeLessThanOrEqual(
      MAX_PREDICTION_PENDING_IDENTITIES,
    );
    expect(JSON.stringify(send).length).toBeLessThan(20000);
    expect(predictionAfterSend(send, [], ready("A", 10), "s").allowed).toBe(
      false,
    );
  }
  const retired = retirePredictionSend(send, send, send.requestId);
  expect(
    predictionAfterSend(retired, [handoff("C", 40)], ready("D", 50), "s")
      .allowed,
  ).toBe(false);
});
it("recovers every tracked identity at the cap only after exact facts, including reverse ordering", () => {
  let send = beginPredictionSend(undefined, "Request-0", 0);
  for (let index = 1; index < MAX_PREDICTION_PENDING_IDENTITIES; index++)
    send = beginPredictionSend(send, `Request-${index}`, index);
  expect(send.correlationLimited).toBeUndefined();
  expect(send.pending).toHaveLength(MAX_PREDICTION_PENDING_IDENTITIES - 1);
  const events = Array.from(
    { length: MAX_PREDICTION_PENDING_IDENTITIES },
    (_, index) => handoff(`Request-${index}`, index + 1),
  ).reverse();
  const partial = predictionAfterSend(
    send,
    events.slice(1),
    ready("Later", 1000),
    "s",
  );
  expect(partial.allowed).toBe(false);
  const complete = predictionAfterSend(
    partial.send,
    events.slice(0, 1),
    ready("Later", 1000),
    "s",
  );
  expect(complete.allowed).toBe(true);
  expect(complete.send?.pending).toBeUndefined();
});
it("authoritative retirement captures a non-current identity but cannot clear a newer same-ID token", () => {
  const first = beginPredictionSend(undefined, "C", 1);
  const second = beginPredictionSend(first, "E", 2);
  const captured = capturePredictionAttempt(second, "C");
  expect(captured?.token).toBe(1);
  const third = beginPredictionSend(second, "C", 3);
  expect(retirePredictionSend(captured, third, "C", true)).toBe(third);
  const authority = capturePredictionAttempt(third, "C");
  const retiredC = retirePredictionSend(authority, third, "C", true);
  expect(predictionAfterSend(retiredC, [], ready("F", 70), "s").allowed).toBe(
    false,
  );
  const retiredE = retirePredictionSend(
    capturePredictionAttempt(retiredC, "E"),
    retiredC,
    "E",
    true,
  );
  expect(predictionAfterSend(retiredE, [], ready("F", 70), "s").allowed).toBe(
    true,
  );
});
it("starts a fresh provisional barrier when retrying a previously rejected identity", () => {
  const first = predictionAfterSend(
    beginPredictionSend(undefined, "C", 1),
    [user("C", 40)],
    null,
    "s",
  ).send;
  const second = beginPredictionSend(first, "E", 2);
  const retired = retirePredictionSend(second, second, "E");
  const retry = beginPredictionSend(retired, "E", 3);
  expect(predictionAfterSend(retry, [], ready("D", 50), "s").allowed).toBe(
    false,
  );
});
it("keeps a same-ID retry inside the identity cap and preserves the older attempt on rejection", () => {
  let send = beginPredictionSend(undefined, "Request-0", 0);
  for (let index = 1; index < MAX_PREDICTION_PENDING_IDENTITIES; index++)
    send = beginPredictionSend(send, `Request-${index}`, index);
  const retry = beginPredictionSend(send, send.requestId, 999);
  expect(retry.correlationLimited).toBeUndefined();
  const retired = retirePredictionSend(retry, retry, retry.requestId);
  expect(
    predictionAfterSend(retired, [], ready("Later", 1000), "s").allowed,
  ).toBe(false);
  const receipts = Array.from(
    { length: MAX_PREDICTION_PENDING_IDENTITIES },
    (_, index) => handoff(`Request-${index}`, index + 1),
  );
  expect(
    predictionAfterSend(retired, receipts, ready("Later", 1000), "s").allowed,
  ).toBe(true);
});
it("never mutates prior source identity or the server snapshot", () => {
  const previous = Object.freeze({ requestId: "A", seq: 10 });
  const snapshot = Object.freeze(ready("B", 30));
  expect(consumePredictionSnapshot(previous, snapshot)).toEqual({
    frontier,
    snapshot,
  });
  expect(previous).toEqual({ requestId: "A", seq: 10 });
});
