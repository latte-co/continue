import { expect, it } from "vitest";
import type { ComposerPredictionSnapshot, Event } from "./protocol";
import {
  consumePredictionSnapshot,
  observePredictionSource,
  predictionAfterSend,
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
it("never mutates prior source identity or the server snapshot", () => {
  const previous = Object.freeze({ requestId: "A", seq: 10 });
  const snapshot = Object.freeze(ready("B", 30));
  expect(consumePredictionSnapshot(previous, snapshot)).toEqual({
    frontier,
    snapshot,
  });
  expect(previous).toEqual({ requestId: "A", seq: 10 });
});
