import { describe, expect, it } from "vitest";
import { appendEvents, latestTurnChanges, transcript } from "./transcript";
import type { Event, EventKind, TurnChanges } from "./protocol";
const e = (seq: number, event: EventKind): Event => ({
  seq,
  event,
  at: 0,
  session_id: "s",
});
const emptyChanges: TurnChanges = {
  request_id: "r",
  undo: "ready",
  interrupted: false,
  background_pending: true,
  summary: {
    entries: [],
    added: 0,
    removed: 0,
    binary_files: 0,
    truncated: false,
    baseline_at: 1,
    unavailable: null,
  },
};
it("omits an invisible snapshot without concatenating distinct prose or discarding stored changes", () => {
  const rows = [
    e(1, { kind: "text", text: "第一段" }),
    e(2, { kind: "turn_changes", changes: emptyChanges }),
    e(3, { kind: "text", text: "第二段" }),
  ];
  expect(transcript(rows)).toMatchObject([
    { key: 1, type: "assistant", text: "第一段" },
    { key: 3, type: "assistant", text: "第二段" },
  ]);
  expect(transcript(rows)).toHaveLength(2);
  expect(latestTurnChanges(rows)).toBe(emptyChanges);
  expect(rows[1].event).toEqual({
    kind: "turn_changes",
    changes: emptyChanges,
  });
});
it("uses the latest snapshot visibility at its stable first-record position", () => {
  const visible: TurnChanges = {
    ...emptyChanges,
    summary: {
      ...emptyChanges.summary,
      entries: [{ path: "a.txt", status: "M", added: 1, removed: 0 }],
    },
  };
  const initial = e(1, { kind: "turn_changes", changes: emptyChanges });
  const update = e(2, { kind: "turn_changes", changes: visible });
  expect(transcript([initial, update])).toEqual([
    { key: 1, type: "event", value: update.event },
  ]);
  const hidden = e(3, { kind: "turn_changes", changes: emptyChanges });
  expect(transcript([initial, update, hidden])).toEqual([]);
  expect(latestTurnChanges([initial, update, hidden])).toBe(emptyChanges);
});
it("keeps the latest turn when an older turn's undo event arrives later", () => {
  const change = (id: string, baseline: number | null): TurnChanges => ({
    request_id: id,
    summary: {
      entries: [],
      added: 0,
      removed: 0,
      binary_files: 0,
      truncated: false,
      baseline_at: baseline,
      unavailable: null,
    },
    interrupted: false,
    background_pending: false,
    undo: "ready",
  });
  const first = change("r1", 1),
    second = change("r2", 2);
  expect(
    latestTurnChanges([
      e(1, { kind: "turn_changes", changes: first }),
      e(2, { kind: "turn_changes", changes: second }),
      e(3, { kind: "turn_changes", changes: { ...first, undo: "reverted" } }),
    ]),
  ).toEqual(second);
  expect(
    latestTurnChanges([
      e(1, { kind: "turn_changes", changes: change("r1", null) }),
      e(2, { kind: "turn_changes", changes: change("r2", null) }),
      e(3, {
        kind: "turn_changes",
        changes: { ...change("r1", null), undo: "unknown" },
      }),
    ])?.request_id,
  ).toBe("r2");
  expect(latestTurnChanges([])).toBeUndefined();
});
describe("durable transcript projection", () => {
  it("shows a handoff immediately and hides only its matching later execution bubble", () => {
    const receipt = {
      ...e(2, {
        kind: "queued_message_sent",
        request_id: "queued",
        text: "follow up",
      }),
      at: 2000,
    };
    const started = e(5, {
      kind: "user",
      request_id: "queued",
      text: "follow up",
    });
    const before = [
      e(1, { kind: "user", request_id: "head", text: "original" }),
      receipt,
    ];
    const after = appendEvents(before, [
      receipt,
      e(3, { kind: "text", text: "finishing original" }),
      started,
    ]);
    const visible = (rows: Event[]) =>
      transcript(rows).filter((item) => item.type === "user" && !item.hidden);
    expect(visible(before)).toHaveLength(2);
    expect(visible(after)).toEqual(visible(before));
    expect(visible(after)[1]).toMatchObject({
      key: 2,
      at: 2000,
      text: "follow up",
      handoff: true,
    });
    expect(visible([started])).toHaveLength(1);
    expect(
      visible([
        receipt,
        e(6, { kind: "user", request_id: "other", text: "follow up" }),
      ]),
    ).toHaveLength(2);
    expect(
      visible([receipt, { ...started, session_id: "other-session" }]),
    ).toHaveLength(2);
    expect(
      visible([
        receipt,
        e(6, { kind: "user", request_id: "queued", text: "different" }),
      ]),
    ).toHaveLength(2);
  });
  it("deduplicates replay while preserving token order", () => {
    const a = e(1, { kind: "text", text: "你" });
    const b = e(2, { kind: "text", text: "好" });
    expect(transcript(appendEvents([a], [a, b]))).toEqual([
      { key: 1, type: "assistant", text: "你好" },
    ]);
  });
  it("deduplicates repeats inside either side of a merge and keeps distinct sessions apart", () => {
    const other = (seq: number, event: EventKind): Event => ({
      seq,
      event,
      at: 0,
      session_id: "s2",
    });
    // Overlapping poll/history windows can repeat inside one batch; those
    // repeats used to survive and produced duplicate transcript turn keys
    // (two active markers in the turn navigator).
    expect(
      appendEvents(
        [],
        [e(1, { kind: "text", text: "a" }), e(1, { kind: "text", text: "a" })],
      ),
    ).toHaveLength(1);
    expect(
      appendEvents(
        [e(1, { kind: "text", text: "a" }), e(1, { kind: "text", text: "a" })],
        [e(2, { kind: "text", text: "b" }), e(2, { kind: "text", text: "b" })],
      ).map((row) => row.seq),
    ).toEqual([1, 2]);
    // The same seq in another session is a different event stream.
    expect(
      appendEvents(
        [],
        [
          e(1, { kind: "text", text: "a" }),
          other(1, { kind: "text", text: "b" }),
        ],
      ),
    ).toHaveLength(2);
  });
  it("does not merge across user turns", () => {
    expect(
      transcript([
        e(1, { kind: "text", text: "a" }),
        e(2, { kind: "user", text: "b", request_id: "r" }),
        e(3, { kind: "text", text: "c" }),
      ]),
    ).toHaveLength(3);
  });
  it("expires approval controls after interruption or resolution", () => {
    const approval = e(1, {
      kind: "approval",
      request_id: "r",
      tool: "Bash",
      input: {},
    });
    expect(
      transcript([
        approval,
        e(2, { kind: "state", status: "unknown", message: "interrupted" }),
      ])[0],
    ).toMatchObject({ resolved: true });
    expect(
      transcript([
        approval,
        e(2, { kind: "approval_resolved", request_id: "r", allow: false }),
      ])[0],
    ).toMatchObject({ resolved: true });
  });
});
it("does not reactivate an interrupted approval when a later turn starts", () => {
  expect(
    transcript([
      e(1, { kind: "approval", request_id: "old", tool: "Write", input: {} }),
      e(2, { kind: "state", status: "stopped", message: null }),
      e(3, { kind: "user", text: "new", request_id: "new" }),
      e(4, { kind: "state", status: "running", message: null }),
    ])[0],
  ).toMatchObject({ resolved: true, decision: "expired" });
});

it("preserves each user message's original send time through replay", () => {
  const at = 1790760900000;
  const event = {
    ...e(1, { kind: "user", text: "继续", request_id: "r" }),
    at,
  };
  expect(transcript(appendEvents([event], [event]))).toEqual([
    { key: 1, type: "user", text: "继续", at },
  ]);
});
it("deduplicates synthetic API error text right before a matching failed state while keeping genuine partial prose", () => {
  const raw429 =
    "API Error: Request rejected (429) · [1302][您的账户已达到速率限制，请您控制请求频率][20261125162645e418428b3b184a3a]";
  const visibleChanges: TurnChanges = {
    ...emptyChanges,
    summary: {
      ...emptyChanges.summary,
      entries: [{ path: "src/lib.rs", status: "M", added: 3, removed: 1 }],
    },
  };
  expect(
    transcript([
      e(1, { kind: "user", text: "review", request_id: "r1" }),
      e(2, { kind: "text", text: "已完成前 3 个模块核查。" }),
      e(3, { kind: "text", text: raw429 }),
      e(4, { kind: "turn_changes", changes: visibleChanges }),
      e(5, { kind: "state", status: "failed", message: raw429 }),
    ]),
  ).toEqual([
    { key: 1, type: "user", text: "review", at: 0 },
    { key: 2, type: "assistant", text: "已完成前 3 个模块核查。" },
    {
      key: 4,
      type: "event",
      value: { kind: "turn_changes", changes: visibleChanges },
    },
    {
      key: 5,
      type: "event",
      value: { kind: "state", status: "failed", message: raw429 },
    },
  ]);

  // Distinct partial diagnosis before a different failure message stays intact.
  expect(
    transcript([
      e(1, { kind: "text", text: "登录诊断的部分结果" }),
      e(2, { kind: "state", status: "failed", message: "登录失败" }),
    ]),
  ).toEqual([
    { key: 1, type: "assistant", text: "登录诊断的部分结果" },
    {
      key: 2,
      type: "event",
      value: { kind: "state", status: "failed", message: "登录失败" },
    },
  ]);
});
it("pairs saved question answers and marks unanswered terminal questions expired without manufacturing an answer", () => {
  const question: Event = {
    seq: 1,
    at: 0,
    session_id: "s",
    event: {
      kind: "question",
      request_id: "q",
      tool_use_id: null,
      questions: [],
    },
  };
  const answer: Event = {
    seq: 2,
    at: 1,
    session_id: "s",
    event: {
      kind: "question_resolved",
      request_id: "q",
      answers: [{ question_id: "q0", option_indices: [1], text: null }],
    },
  };
  const replied = transcript([question, answer]);
  expect(replied).toHaveLength(1);
  expect(replied[0]).toMatchObject({
    resolved: true,
    answers:
      answer.event.kind === "question_resolved" ? answer.event.answers : null,
  });
  const expired = transcript([
    question,
    {
      seq: 3,
      at: 2,
      session_id: "s",
      event: { kind: "state", status: "stopped", message: null },
    },
  ]);
  expect(expired[0]).toMatchObject({ resolved: true, answers: undefined });
});
