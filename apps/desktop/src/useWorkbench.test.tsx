// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  renderHook,
  screen,
} from "@testing-library/react";
import { MessageQueue } from "./MessageQueue";
import { renderWithStatus } from "./test/renderWithStatus";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  HOST_DISCONNECTED_EVENT,
  HostConnectionError,
} from "./connectionErrors";
import { updateWorkspace } from "./workspaceState";
import { useWorkbench } from "./useWorkbench";
import { ServerRequestError } from "./api";
import type {
  ComposerPredictionSnapshot as Snapshot,
  Event,
  Request,
  Session,
} from "./protocol";
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  connect: vi.fn(),
  loadHosts: vi.fn(),
}));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  native: true,
  localHost: { id: "local", name: "Local" },
  loadHosts: mocks.loadHosts,
  connect: mocks.connect,
  saveHosts: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  request: mocks.request,
  message: String,
}));
let unread: boolean;
let hasMore: boolean;
let focused: boolean;
let status: Session["status"];
const session = (): Session => ({
  id: "s",
  project_id: "p",
  title: "Task",
  agent: "claude",
  native_id: null,
  model: null,
  effort: null,
  permission_mode: null,
  status,
  created_at: 1,
  custom_title: false,
  title_requested: false,
  pinned_at: null,
  unread,
  archived: false,
  agent_session_open: true,
  agent_session_busy: false,
});
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.loadHosts.mockResolvedValue([{ id: "local", name: "Local" }]);
  mocks.connect.mockImplementation(async (host: { id: string }) => ({
    kind: "hello",
    server_id: `server-${host.id}`,
    agents: [
      {
        id: "claude",
        name: "Claude Code",
        available: true,
        detail: "fixture",
        provider_protocols: ["anthropic_messages"],
      },
    ],
  }));
  unread = true;
  hasMore = false;
  focused = false;
  status = "completed";
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  mocks.request.mockImplementation(async (_host: string, r: Request) => {
    if (r.method === "open_agent_session" || r.method === "close_agent_session")
      return { kind: "ok" };
    if (r.method === "projects")
      return {
        kind: "projects",
        projects: [{ id: "p", name: "P", path: "/p" }],
      };
    if (r.method === "sessions")
      return { kind: "sessions", sessions: [session()] };
    if (r.method === "pinned_sessions")
      return { kind: "sessions", sessions: [] };
    if (r.method === "poll")
      return {
        kind: "events",
        session: session(),
        events: [],
        has_more: hasMore,
      };
    if (r.method === "mark_session_unread") {
      unread = r.unread;
      return { kind: "session", session: session() };
    }
    throw new Error(r.method);
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const ready = (source = "A", seq = 10, text = "补充测试"): Snapshot => ({
  status: "ready",
  source_request_id: source,
  source_user_seq: seq,
  generation_id: `generation-${source}`,
  suggestion: text,
});
const userEvent = (source: string, seq: number): Event => ({
  seq,
  at: 1,
  session_id: "s",
  event: { kind: "user", request_id: source, text: source },
});
const standaloneReads = () =>
  mocks.request.mock.calls.filter(
    ([, r]) => r.method === "composer_prediction",
  );
function predictionFixture(windowed = false) {
  mocks.connect.mockResolvedValue({
    kind: "hello",
    server_id: "server-local",
    composer_predictions: true,
    history_window: windowed,
    agents: [{ id: "claude", available: true }],
  });
  const base = mocks.request.getMockImplementation()!;
  const frame: { snapshot: Snapshot | null | undefined; events: Event[] } = {
    snapshot: ready(),
    events: [userEvent("A", 10)],
  };
  mocks.request.mockImplementation(async (host, r) => {
    // A standalone optional read would never return (and used to block the live loop).
    if (r.method === "composer_prediction") return new Promise(() => {});
    if (r.method === "poll" || r.method === "history")
      return {
        kind: r.method === "history" ? "history" : "events",
        session: session(),
        events: frame.events,
        has_more: windowed && r.method === "history" && r.before === null,
        needs_earlier: false,
        before: 20,
        ...(frame.snapshot === undefined
          ? {}
          : { composer_prediction: frame.snapshot }),
      };
    return base(host, r);
  });
  return frame;
}
async function openPredictionFixture() {
  const view = renderHook(useWorkbench);
  await act(async () => {});
  await act(async () =>
    view.result.current.openSession({ ...session(), hostId: "local" }),
  );
  return view;
}
it("consumes piggyback predictions while a standalone read would hang, without blocking main polls or creating turns", async () => {
  const frame = predictionFixture();
  frame.snapshot = { ...ready(), status: "pending", suggestion: null };
  const view = await openPredictionFixture();
  expect(standaloneReads()).toHaveLength(0);
  frame.snapshot = ready();
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction).toMatchObject({
    suggestion: "补充测试",
    source_request_id: "A",
  });
  frame.events = [
    {
      seq: 11,
      at: 1,
      session_id: "s",
      event: { kind: "text", text: "Live output" },
    },
  ];
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(view.result.current.events.at(-1)?.seq).toBe(11);
  expect(
    mocks.request.mock.calls.filter(([, r]) => r.method === "poll").length,
  ).toBeGreaterThan(3);
  expect(standaloneReads()).toHaveLength(0);
  expect(
    mocks.request.mock.calls.some(([, r]) =>
      ["send", "send_queued", "create_session"].includes(r.method),
    ),
  ).toBe(false);
});
it.each(["pending", "failed", "mismatch"])(
  "clears the previous ready prediction when a fast external turn snapshot is %s",
  async (outcome) => {
    const frame = predictionFixture();
    const view = await openPredictionFixture();
    expect(view.result.current.composerPrediction?.suggestion).toBe("补充测试");
    frame.events = [userEvent("B", 30)];
    frame.snapshot =
      outcome === "mismatch"
        ? ready("A", 10)
        : {
            ...ready("B", 30),
            status: outcome as "pending" | "failed",
            suggestion: null,
          };
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(
      view.result.current.composerPrediction?.suggestion ?? null,
    ).toBeNull();
    expect(standaloneReads()).toHaveLength(0);
  },
);
it.each(["none", "unsupported", "failed", "missing", "null"])(
  "keeps main polling and the default composer for %s, never falling back despite Hello true",
  async (outcome) => {
    const frame = predictionFixture();
    const view = await openPredictionFixture();
    expect(view.result.current.composerPrediction?.suggestion).toBe("补充测试");
    frame.snapshot =
      outcome === "missing"
        ? undefined
        : outcome === "null"
          ? null
          : {
              ...ready(),
              status: outcome as "none" | "unsupported" | "failed",
              suggestion: null,
            };
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(
      view.result.current.composerPrediction?.suggestion ?? null,
    ).toBeNull();
    expect(standaloneReads()).toHaveLength(0);
    frame.snapshot = ready();
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction?.suggestion).toBe("补充测试");
  },
);
it("does not impose the old 35s pending deadline and suppresses hidden composer snapshots", async () => {
  const frame = predictionFixture();
  frame.snapshot = { ...ready(), status: "pending", suggestion: null };
  const view = await openPredictionFixture();
  act(() => view.result.current.setPredictionVisible(false));
  frame.snapshot = ready();
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(view.result.current.composerPrediction?.suggestion ?? null).toBeNull();
  act(() => view.result.current.setPredictionVisible(true));
  frame.snapshot = { ...ready(), status: "pending", suggestion: null };
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  frame.snapshot = ready();
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction?.suggestion).toBe("补充测试");
  expect(standaloneReads()).toHaveLength(0);
});
it("accepts the latest window snapshot without its source User event or loading older history", async () => {
  const frame = predictionFixture(true);
  frame.events = [
    {
      seq: 100,
      at: 1,
      session_id: "s",
      event: { kind: "text", text: "Truncated final reply" },
    },
  ];
  const view = await openPredictionFixture();
  expect(view.result.current.composerPrediction?.suggestion).toBe("补充测试");
  expect(view.result.current.hasEarlierHistory).toBe(true);
  expect(
    mocks.request.mock.calls.filter(([, r]) => r.method === "history"),
  ).toHaveLength(1);
});
it("advances known A10 to server B30 without User B and rejects a late A10 snapshot", async () => {
  const frame = predictionFixture();
  const view = await openPredictionFixture();
  frame.events = [];
  frame.snapshot = ready("B", 30, "New suggestion");
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction?.source_request_id).toBe("B");
  frame.snapshot = ready("A", 10, "Old suggestion");
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction?.source_request_id).toBe("B");
});
it("rejects same-seq different-source conflicts", async () => {
  const frame = predictionFixture();
  const view = await openPredictionFixture();
  frame.events = [];
  frame.snapshot = ready("B", 10, "Conflicting suggestion");
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction?.source_request_id).toBe("A");
});
it("does not let an invalid observed User request ID poison the source frontier", async () => {
  const frame = predictionFixture();
  const view = await openPredictionFixture();
  frame.events = [userEvent("", 90), userEvent("   ", 100)];
  frame.snapshot = ready("B", 30, "New suggestion");
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction?.source_request_id).toBe("B");
});
it.each(["A", "B"])(
  "earlier page %s only changes transcript, not the live source frontier or prediction",
  async (source) => {
    const frame = predictionFixture(true);
    frame.events = [userEvent("B", 30)];
    frame.snapshot = ready("B", 30, "Live suggestion");
    const view = await openPredictionFixture();
    frame.events = [userEvent(source, source === "A" ? 10 : 100)];
    frame.snapshot = ready(
      source,
      source === "A" ? 10 : 100,
      "Page suggestion",
    );
    await act(async () => view.result.current.loadEarlierHistory());
    expect(view.result.current.composerPrediction?.suggestion).toBe(
      "Live suggestion",
    );
    frame.events = [];
    frame.snapshot = ready("B", 30, "Refreshed live suggestion");
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction?.suggestion).toBe(
      "Refreshed live suggestion",
    );
  },
);
it("keeps a source frontier monotonic across same-connection navigation", async () => {
  const frame = predictionFixture();
  frame.snapshot = ready("B", 30);
  frame.events = [userEvent("B", 30)];
  const view = await openPredictionFixture();
  await act(async () => view.result.current.createSession());
  frame.snapshot = ready("A", 10, "Old suggestion");
  frame.events = [userEvent("A", 10)];
  await act(async () =>
    view.result.current.openSession({ ...session(), hostId: "local" }),
  );
  expect(view.result.current.composerPrediction?.suggestion ?? null).toBeNull();
});
it.each(["navigate", "reconnect", "send"])(
  "discards a delayed main frame after %s",
  async (action) => {
    const frame = predictionFixture();
    const view = await openPredictionFixture();
    const base = mocks.request.getMockImplementation()!;
    let finish!: (value: unknown) => void;
    let delayed = true;
    mocks.request.mockImplementation(async (host, r) => {
      if (r.method === "send_queued")
        return { kind: "accepted", duplicate: true };
      if (
        r.method === "poll" &&
        r.after !== Number.MAX_SAFE_INTEGER &&
        delayed
      ) {
        delayed = false;
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return base(host, r);
    });
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(finish).toBeTypeOf("function");
    if (action === "navigate")
      await act(async () => view.result.current.createSession());
    if (action === "reconnect") {
      frame.snapshot = { ...ready(), status: "none", suggestion: null };
      await act(async () =>
        view.result.current.refreshHost(view.result.current.host),
      );
    }
    if (action === "send")
      await act(async () => {
        await view.result.current.send("New turn", null, null, null);
      });
    await act(async () =>
      finish({
        kind: "events",
        session: session(),
        events: [userEvent("B", 30)],
        has_more: false,
        composer_prediction: ready("B", 30, "Late suggestion"),
      }),
    );
    expect(
      view.result.current.composerPrediction?.suggestion ?? null,
    ).toBeNull();
  },
);
const handoffEvent = (source: string, seq: number): Event => ({
  seq,
  at: 1,
  session_id: "s",
  event: { kind: "queued_message_sent", request_id: source, text: source },
});
it.each(["live", "staggered", "early", "reconnect"])(
  "recovers three unknown C/D/E sends after exact matching facts via %s",
  async (arrival) => {
    const frame = predictionFixture(arrival === "early");
    const view = await openPredictionFixture();
    const base = mocks.request.getMockImplementation()!;
    const ids: string[] = [];
    mocks.request.mockImplementation(async (host, r) => {
      if (r.method === "send_queued") {
        ids.push(r.request_id);
        throw new ServerRequestError("admission_unknown", "unknown");
      }
      return base(host, r);
    });
    for (const text of ["C", "D", "E"])
      await act(async () => {
        expect(await view.result.current.send(text, null, null, null)).toBe(
          false,
        );
      });
    frame.events = [];
    frame.snapshot = ready("F", 70, "Later known source");
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction).toBeNull();
    if (arrival === "reconnect")
      await act(async () =>
        view.result.current.refreshHost(view.result.current.host),
      );
    if (arrival === "staggered") {
      frame.events = [handoffEvent(ids[0], 40), userEvent(ids[2], 60)];
      await act(async () => vi.advanceTimersByTimeAsync(650));
      expect(view.result.current.composerPrediction).toBeNull();
      frame.events = [userEvent(ids[1], 50)];
    } else
      frame.events = [
        userEvent(ids[2], 60),
        handoffEvent(ids[0], 40),
        userEvent(ids[1], 50),
      ];
    if (arrival === "early") {
      await act(async () => {
        await view.result.current.loadEarlierHistory();
      });
      expect(view.result.current.composerPrediction).toBeNull();
      frame.events = [];
    }
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction?.suggestion).toBe(
      "Later known source",
    );
    expect(standaloneReads()).toHaveLength(0);
    expect(ids).toHaveLength(3);
  },
);
it("uses an earlier untracked handoff only as a blocking fence, not a User frontier or page snapshot", async () => {
  const frame = predictionFixture(true);
  frame.snapshot = ready("D", 50, "Displayed");
  const view = await openPredictionFixture();
  expect(view.result.current.composerPrediction?.suggestion).toBe("Displayed");
  frame.events = [
    handoffEvent("Older resolved C", 55),
    userEvent("Unrelated page User", 200),
  ];
  frame.snapshot = ready("Unrelated page User", 200, "Do not publish");
  await act(async () => {
    await view.result.current.loadEarlierHistory();
  });
  expect(view.result.current.composerPrediction).toBeNull();
  frame.events = [];
  frame.snapshot = ready("D", 50, "Before H55");
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction).toBeNull();
  frame.snapshot = ready("E", 60, "After H55 without page User frontier");
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction?.suggestion).toBe(
    "After H55 without page User frontier",
  );
});
it("updates the blocking fence when a resolved older C is legitimately handed off again", async () => {
  const frame = predictionFixture();
  const view = await openPredictionFixture();
  const base = mocks.request.getMockImplementation()!;
  const ids: string[] = [];
  mocks.request.mockImplementation(async (host, r) => {
    if (r.method === "send_queued") {
      ids.push(r.request_id);
      if (ids.length === 3)
        throw new ServerRequestError("send_not_admitted", "rejected");
      return { kind: "message_queued", duplicate: false };
    }
    return base(host, r);
  });
  await act(async () => {
    await view.result.current.send("C", null, null, null);
  });
  frame.events = [handoffEvent(ids[0], 40)];
  await act(async () => vi.advanceTimersByTimeAsync(650));
  await act(async () => {
    await view.result.current.send("D", null, null, null);
  });
  frame.events = [handoffEvent(ids[1], 45)];
  frame.snapshot = ready("F", 50, "Before redispatch");
  await act(async () => vi.advanceTimersByTimeAsync(650));
  await act(async () => {
    await view.result.current.send("E", null, null, null);
  });
  frame.events = [];
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction?.suggestion).toBe(
    "Before redispatch",
  );
  frame.events = [handoffEvent(ids[0], 55)];
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction).toBeNull();
  frame.events = [];
  frame.snapshot = ready("G", 60, "After redispatch");
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction?.suggestion).toBe(
    "After redispatch",
  );
});
it.each([
  ["cancel", "during"],
  ["take", "during"],
  ["cancel", "after"],
  ["take", "after"],
])(
  "retires authoritative %s for pending C %s E rejection",
  async (_action, timing) => {
    const frame = predictionFixture();
    const view = await openPredictionFixture();
    const base = mocks.request.getMockImplementation()!;
    let id = "";
    let rejectE!: (error: Error) => void;
    mocks.request.mockImplementation(async (host, r) => {
      if (r.method === "send_queued") {
        if (!id) {
          id = r.request_id;
          throw new ServerRequestError("admission_unknown", "unknown");
        }
        return new Promise((_, reject) => {
          rejectE = reject;
        });
      }
      return base(host, r);
    });
    await act(async () => {
      await view.result.current.send("C", null, null, null);
    });
    let submitted!: Promise<boolean>;
    await act(async () => {
      submitted = view.result.current.send("E", null, null, null);
    });
    if (timing === "during")
      act(() => view.result.current.captureQueuedPredictionRetirement(id)());
    await act(async () => {
      rejectE(new ServerRequestError("send_not_admitted", "rejected"));
      await submitted;
    });
    if (timing === "after")
      act(() => view.result.current.captureQueuedPredictionRetirement(id)());
    frame.events = [];
    frame.snapshot = ready("D", 50, "After authoritative retirement");
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction?.suggestion).toBe(
      "After authoritative retirement",
    );
  },
);
it.each(["different", "same"])(
  "retains an earlier unknown Send after a %s-ID attempt is not admitted",
  async (identity) => {
    const frame = predictionFixture();
    const view = await openPredictionFixture();
    const base = mocks.request.getMockImplementation()!;
    let count = 0;
    mocks.request.mockImplementation(async (host, r) => {
      if (r.method === "send_queued")
        throw new ServerRequestError(
          ++count === 1 ? "admission_unknown" : "send_not_admitted",
          "error",
        );
      return base(host, r);
    });
    await act(async () => {
      expect(await view.result.current.send("C", null, null, null)).toBe(false);
    });
    await act(async () => {
      expect(
        await view.result.current.send(
          identity === "same" ? "C" : "E",
          null,
          null,
          null,
        ),
      ).toBe(false);
    });
    frame.events = [];
    frame.snapshot = ready("A", 10, "Must not revive");
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction).toBeNull();
    const firstId = mocks.request.mock.calls.find(
      ([, r]) => r.method === "send_queued",
    )![1].request_id;
    frame.events = [handoffEvent(firstId, 40)];
    frame.snapshot = ready("D", 50, "After original handoff");
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction?.suggestion).toBe(
      "After original handoff",
    );
  },
);
it.each(["user", "handoff"])(
  "harvests fallback C %s facts while E is pending before E rejection",
  async (fact) => {
    const frame = predictionFixture();
    const view = await openPredictionFixture();
    const base = mocks.request.getMockImplementation()!;
    let original = "";
    let rejectE!: (error: Error) => void;
    mocks.request.mockImplementation(async (host, r) => {
      if (r.method === "send_queued") {
        if (!original) {
          original = r.request_id;
          throw new ServerRequestError("admission_unknown", "unknown");
        }
        return new Promise((_, reject) => {
          rejectE = reject;
        });
      }
      return base(host, r);
    });
    await act(async () => {
      await view.result.current.send("C", null, null, null);
    });
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = view.result.current.send("E", null, null, null);
    });
    frame.events = [
      fact === "user" ? userEvent(original, 40) : handoffEvent(original, 40),
    ];
    frame.snapshot = ready("A", 10);
    await act(async () => vi.advanceTimersByTimeAsync(650));
    await act(async () => {
      rejectE(new ServerRequestError("send_not_admitted", "rejected"));
      expect(await pending).toBe(false);
    });
    frame.events = [];
    frame.snapshot = ready("A", 10, "Before updated fallback");
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction).toBeNull();
    frame.snapshot = ready("D", 50, "After updated fallback");
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction?.suggestion).toBe(
      "After updated fallback",
    );
  },
);
it("withdraws D50 when a stale cached source contradicts known User C40", async () => {
  const frame = predictionFixture();
  const view = await openPredictionFixture();
  const base = mocks.request.getMockImplementation()!;
  let id = "";
  mocks.request.mockImplementation(async (host, r) =>
    r.method === "send_queued"
      ? ((id = r.request_id), { kind: "message_queued", duplicate: false })
      : base(host, r),
  );
  await act(async () => {
    await view.result.current.send("C", null, null, null);
  });
  frame.events = [userEvent(id, 40)];
  frame.snapshot = ready("D", 50, "Displayed");
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction?.suggestion).toBe("Displayed");
  frame.events = [];
  frame.snapshot = ready(id, 45, "Contradictory stale User cache");
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction).toBeNull();
});
it("preserves C handoff40 when a newer E send is explicitly rejected", async () => {
  const frame = predictionFixture();
  const view = await openPredictionFixture();
  const base = mocks.request.getMockImplementation()!;
  let source = "";
  let reject = false;
  mocks.request.mockImplementation(async (host, r) => {
    if (r.method === "send_queued") {
      if (reject) throw new ServerRequestError("send_not_admitted", "rejected");
      source = r.request_id;
      return { kind: "message_queued", duplicate: false };
    }
    return base(host, r);
  });
  await act(async () => {
    await view.result.current.send("C", null, null, null);
  });
  frame.events = [handoffEvent(source, 40)];
  frame.snapshot = ready("A", 10);
  await act(async () => vi.advanceTimersByTimeAsync(650));
  reject = true;
  await act(async () => {
    expect(await view.result.current.send("E", null, null, null)).toBe(false);
  });
  frame.events = [];
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction).toBeNull();
  frame.snapshot = ready("D", 50, "After retained C");
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction?.suggestion).toBe(
    "After retained C",
  );
});
it.each(["user", "handoff", "conflict"])(
  "preserves %s facts on same-ID duplicate retry without receipt replay",
  async (fact) => {
    const frame = predictionFixture();
    const view = await openPredictionFixture();
    const id = "00000000-0000-4000-8000-000000000000";
    vi.spyOn(crypto, "randomUUID").mockReturnValue(id);
    const base = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(async (host, r) =>
      r.method === "send_queued"
        ? { kind: "message_queued", duplicate: true }
        : base(host, r),
    );
    await act(async () => {
      await view.result.current.send("C", null, null, null);
    });
    frame.events =
      fact === "conflict"
        ? [userEvent(id, 40), userEvent(id, 45)]
        : fact === "user"
          ? [userEvent(id, 40)]
          : [handoffEvent(id, 40)];
    frame.snapshot = ready("A", 10);
    await act(async () => vi.advanceTimersByTimeAsync(650));
    frame.events = [];
    await act(async () => {
      await view.result.current.send("C", null, null, null);
    });
    frame.snapshot = ready("D", 50, "After retry");
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction?.suggestion ?? null).toBe(
      fact === "conflict" ? null : "After retry",
    );
    if (fact === "conflict") {
      // A newly observed User would unlock a reset record, but must not erase conflict.
      frame.events = [userEvent(id, 60)];
      frame.snapshot = ready("E", 70, "Must remain conflicted");
      await act(async () => vi.advanceTimersByTimeAsync(650));
      expect(view.result.current.composerPrediction).toBeNull();
    }
  },
);
it.each([
  ["live", "stale"],
  ["live", "missing"],
  ["early", "stale"],
  ["early", "missing"],
])(
  "withdraws displayed D50 when %s matching handoff advances to H55 with %s snapshot",
  async (arrival, snapshot) => {
    const frame = predictionFixture(arrival === "early");
    const view = await openPredictionFixture();
    const base = mocks.request.getMockImplementation()!;
    let id = "";
    mocks.request.mockImplementation(async (host, r) =>
      r.method === "send_queued"
        ? ((id = r.request_id), { kind: "message_queued", duplicate: false })
        : base(host, r),
    );
    await act(async () => {
      await view.result.current.send("C", null, null, null);
    });
    frame.events = [handoffEvent(id, 40)];
    frame.snapshot = ready("D", 50, "Displayed");
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction?.suggestion).toBe(
      "Displayed",
    );
    frame.events = [handoffEvent(id, 55)];
    frame.snapshot =
      snapshot === "stale" ? ready("A", 10, "Stale frame") : undefined;
    if (arrival === "early")
      await act(async () => {
        await view.result.current.loadEarlierHistory();
      });
    else await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction).toBeNull();
    frame.events = [];
    frame.snapshot = ready("D", 50, "Cannot revive before H55");
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction).toBeNull();
    frame.snapshot = ready("E", 60, "After H55");
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction?.suggestion).toBe(
      "After H55",
    );
  },
);
it.each(["live", "early"])(
  "preserves displayed D50 across legitimate H45 from %s without advancing frontier from an earlier page",
  async (arrival) => {
    const frame = predictionFixture(arrival === "early");
    const view = await openPredictionFixture();
    const base = mocks.request.getMockImplementation()!;
    let id = "";
    mocks.request.mockImplementation(async (host, r) =>
      r.method === "send_queued"
        ? ((id = r.request_id), { kind: "message_queued", duplicate: false })
        : base(host, r),
    );
    await act(async () => {
      await view.result.current.send("C", null, null, null);
    });
    frame.events = [handoffEvent(id, 40)];
    frame.snapshot = ready("D", 50, "Displayed");
    await act(async () => vi.advanceTimersByTimeAsync(650));
    frame.events = [
      handoffEvent(id, 45),
      ...(arrival === "early" ? [userEvent("Unrelated", 200)] : []),
    ];
    frame.snapshot = ready("A", 10, "Stale");
    if (arrival === "early")
      await act(async () => {
        await view.result.current.loadEarlierHistory();
      });
    else await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction?.suggestion).toBe(
      "Displayed",
    );
    frame.events = [];
    frame.snapshot = ready("D", 50, "D frontier still live");
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction?.suggestion).toBe(
      "D frontier still live",
    );
  },
);
it.each([
  [new ServerRequestError("send_not_admitted", "rejected"), true],
  [new ServerRequestError("request_failed", "rejected"), false],
  [new ServerRequestError("admission_unknown", "unknown"), false],
  [new HostConnectionError("local", "disconnected"), false],
  [new Error("send_not_admitted"), false],
])(
  "retires only explicitly unadmitted provisional sends (%#)",
  async (error, restores) => {
    const frame = predictionFixture();
    const view = await openPredictionFixture();
    const base = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(async (host, r) => {
      if (r.method === "send_queued") throw error;
      return base(host, r);
    });
    await act(async () => {
      expect(
        await view.result.current.send("Rejected turn", null, null, null),
      ).toBe(false);
    });
    frame.events = [];
    frame.snapshot = ready("B", 30, "Later source");
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction?.suggestion ?? null).toBe(
      restores ? "Later source" : null,
    );
    expect(
      mocks.request.mock.calls.filter(([, r]) => r.method === "send_queued"),
    ).toHaveLength(1);
    expect(standaloneReads()).toHaveLength(0);
  },
);
it("does not retire a User-observed send on a late unadmitted error", async () => {
  const frame = predictionFixture();
  const view = await openPredictionFixture();
  const base = mocks.request.getMockImplementation()!;
  let rejectSend!: (error: Error) => void;
  let source = "";
  mocks.request.mockImplementation(async (host, r) => {
    if (r.method === "send_queued") {
      source = r.request_id;
      return new Promise((_, reject) => {
        rejectSend = reject;
      });
    }
    return base(host, r);
  });
  let submitted!: Promise<boolean>;
  await act(async () => {
    submitted = view.result.current.send("Turn", null, null, null);
  });
  frame.events = [userEvent(source, 40)];
  await act(async () => vi.advanceTimersByTimeAsync(650));
  await act(async () => {
    rejectSend(new ServerRequestError("send_not_admitted", "rejected"));
    await submitted;
  });
  frame.events = [];
  frame.snapshot = ready("B", 30, "Old source");
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction).toBeNull();
  frame.snapshot = ready("D", 50, "Later source");
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction?.suggestion).toBe(
    "Later source",
  );
});
it.each(["none", "cancel", "take", "rejection"])(
  "retains a handoff fence without a User across %s",
  async (retirement) => {
    const frame = predictionFixture();
    const view = await openPredictionFixture();
    const base = mocks.request.getMockImplementation()!;
    let source = "";
    let rejectSend!: (error: Error) => void;
    mocks.request.mockImplementation(async (host, r) => {
      if (r.method === "send_queued") {
        source = r.request_id;
        if (retirement === "rejection")
          return new Promise((_, reject) => {
            rejectSend = reject;
          });
        return { kind: "message_queued", duplicate: false };
      }
      return base(host, r);
    });
    let submitted!: Promise<boolean>;
    await act(async () => {
      submitted = view.result.current.send("Steer", null, null, null);
    });
    const retire =
      view.result.current.captureQueuedPredictionRetirement(source);
    frame.events = [handoffEvent(source, 40)];
    frame.snapshot = ready("A", 10, "Old source");
    await act(async () => vi.advanceTimersByTimeAsync(650));
    if (retirement === "rejection")
      await act(async () => {
        rejectSend(new ServerRequestError("send_not_admitted", "rejected"));
        await submitted;
      });
    else {
      await submitted;
      if (retirement !== "none") act(() => retire());
    }
    frame.events = [];
    // A handoff must not become a User anchor or allow equal/older cache sources.
    frame.snapshot = ready(source, 40, "Not a User");
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction).toBeNull();
    frame.snapshot = ready("D", 50, "After steering");
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction?.suggestion).toBe(
      "After steering",
    );
    expect(standaloneReads()).toHaveLength(0);
  },
);
it.each(["request", "event-session", "frame-session", "frame-project"])(
  "rejects a foreign %s handoff as Send evidence",
  async (foreign) => {
    const frame = predictionFixture();
    const view = await openPredictionFixture();
    const base = mocks.request.getMockImplementation()!;
    let source = "";
    mocks.request.mockImplementation(async (host, r) => {
      if (r.method === "send_queued") {
        source = r.request_id;
        return { kind: "message_queued", duplicate: false };
      }
      if (r.method === "poll" && r.after !== Number.MAX_SAFE_INTEGER) {
        const event = handoffEvent(
          foreign === "request" ? "foreign" : source,
          40,
        );
        return {
          kind: "events",
          session: {
            ...session(),
            ...(foreign === "frame-session" ? { id: "foreign" } : {}),
            ...(foreign === "frame-project" ? { project_id: "foreign" } : {}),
          },
          events: [
            {
              ...event,
              session_id: foreign === "event-session" ? "foreign" : "s",
            },
          ],
          has_more: false,
          composer_prediction: ready("D", 50, "Foreign receipt"),
        };
      }
      return base(host, r);
    });
    await act(async () => {
      await view.result.current.send("Steer", null, null, null);
    });
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction).toBeNull();
    mocks.request.mockImplementation(base);
    frame.events = [];
    frame.snapshot = ready("D", 50, "Still unconfirmed");
    // A mismatched frame is discarded by terminating its poll owner; reconnect
    // explicitly starts a valid owner without retaining the foreign receipt.
    if (foreign === "frame-session" || foreign === "frame-project")
      await act(async () =>
        view.result.current.refreshHost(view.result.current.host),
      );
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction).toBeNull();
    frame.events = [handoffEvent(source, 40)];
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction?.suggestion).toBe(
      "Still unconfirmed",
    );
  },
);
it("retains handoff facts across same-server reconnect but rejects the old connection frame", async () => {
  const frame = predictionFixture();
  const view = await openPredictionFixture();
  const base = mocks.request.getMockImplementation()!;
  let source = "";
  let delayed = false;
  let finish!: (value: unknown) => void;
  mocks.request.mockImplementation(async (host, r) => {
    if (r.method === "send_queued") {
      source = r.request_id;
      return { kind: "message_queued", duplicate: false };
    }
    if (r.method === "poll" && r.after !== Number.MAX_SAFE_INTEGER && delayed) {
      delayed = false;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    return base(host, r);
  });
  await act(async () => {
    await view.result.current.send("Steer", null, null, null);
  });
  delayed = true;
  await act(async () => vi.advanceTimersByTimeAsync(650));
  frame.events = [];
  frame.snapshot = ready("D", 50, "No receipt yet");
  await act(async () =>
    view.result.current.refreshHost(view.result.current.host),
  );
  await act(async () =>
    finish({
      kind: "events",
      session: session(),
      events: [handoffEvent(source, 40)],
      has_more: false,
    }),
  );
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction).toBeNull();
  frame.events = [handoffEvent(source, 40)];
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction?.suggestion).toBe(
    "No receipt yet",
  );
  frame.events = [];
  frame.snapshot = ready("A", 10, "Before handoff");
  await act(async () =>
    view.result.current.refreshHost(view.result.current.host),
  );
  expect(view.result.current.composerPrediction).toBeNull();
  frame.snapshot = ready("E", 60, "After retained handoff");
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction?.suggestion).toBe(
    "After retained handoff",
  );
});
it("fails closed on contradictory User facts even after queue retirement", async () => {
  const frame = predictionFixture();
  const view = await openPredictionFixture();
  const base = mocks.request.getMockImplementation()!;
  let source = "";
  mocks.request.mockImplementation(async (host, r) => {
    if (r.method === "send_queued") {
      source = r.request_id;
      return { kind: "message_queued", duplicate: false };
    }
    return base(host, r);
  });
  await act(async () => {
    await view.result.current.send("Steer", null, null, null);
  });
  frame.events = [userEvent(source, 40), userEvent(source, 45)];
  frame.snapshot = ready("D", 50, "Conflicting");
  await act(async () => vi.advanceTimersByTimeAsync(650));
  act(() => view.result.current.captureQueuedPredictionRetirement(source)());
  frame.events = [];
  frame.snapshot = ready("E", 60, "Still conflicting");
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction).toBeNull();
});
it("does not restore pre-send snapshots on later polls and accepts the new send source", async () => {
  const frame = predictionFixture();
  const view = await openPredictionFixture();
  const base = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation(async (host, r) =>
    r.method === "send_queued"
      ? { kind: "accepted", duplicate: true }
      : base(host, r),
  );
  await act(async () => {
    await view.result.current.send("New turn", null, null, null);
  });
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction?.suggestion ?? null).toBeNull();
  const source = mocks.request.mock.calls.find(
    ([, r]) => r.method === "send_queued",
  )![1].request_id;
  frame.events = [userEvent(source, 30)];
  frame.snapshot = ready(source, 30, "Next turn suggestion");
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction?.suggestion).toBe(
    "Next turn suggestion",
  );
});
it("requires evidence of the new local send before accepting a different newer cached source", async () => {
  const frame = predictionFixture();
  const view = await openPredictionFixture();
  const base = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation(async (host, r) =>
    r.method === "send_queued"
      ? { kind: "accepted", duplicate: true }
      : base(host, r),
  );
  await act(async () => {
    await view.result.current.send("New turn", null, null, null);
  });
  frame.events = [];
  frame.snapshot = ready("B", 30, "Unobserved pre-send source");
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction?.suggestion ?? null).toBeNull();
  const source = mocks.request.mock.calls.find(
    ([, r]) => r.method === "send_queued",
  )![1].request_id;
  frame.events = [userEvent(source, 40)];
  frame.snapshot = {
    ...ready(source, 40),
    status: "pending",
    suggestion: null,
  };
  await act(async () => vi.advanceTimersByTimeAsync(650));
  frame.events = [];
  frame.snapshot = ready("D", 50, "Later external source");
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction?.suggestion).toBe(
    "Later external source",
  );
});
it.each([
  ["sending", "user"],
  ["old-epoch", "user"],
  ["sending", "handoff"],
  ["old-epoch", "handoff"],
])(
  "harvests the current Send fact during %s (%s), without publishing that frame's snapshot",
  async (phase, fact) => {
    const frame = predictionFixture();
    const view = await openPredictionFixture();
    const base = mocks.request.getMockImplementation()!;
    let finishSend!: (value: unknown) => void;
    let finishFrame!: (value: unknown) => void;
    let source = "";
    let delayed = phase === "old-epoch";
    mocks.request.mockImplementation(async (host, r) => {
      if (r.method === "send_queued") {
        source = r.request_id;
        return new Promise((resolve) => {
          finishSend = resolve;
        });
      }
      if (r.method === "poll" && r.after !== Number.MAX_SAFE_INTEGER) {
        if (delayed) {
          delayed = false;
          return new Promise((resolve) => {
            finishFrame = resolve;
          });
        }
        if (phase === "sending" && r.after === 10)
          return {
            kind: "events",
            session: session(),
            events: [
              fact === "user"
                ? userEvent(source, 30)
                : handoffEvent(source, 30),
            ],
            has_more: false,
            composer_prediction: ready(source, 30, "Unsafe frame suggestion"),
          };
      }
      return base(host, r);
    });
    if (phase === "old-epoch")
      await act(async () => vi.advanceTimersByTimeAsync(650));
    let submitted!: Promise<boolean>;
    await act(async () => {
      submitted = view.result.current.send("New turn", null, null, null);
    });
    if (phase === "sending")
      await act(async () => vi.advanceTimersByTimeAsync(650));
    await act(async () => {
      finishSend({ kind: "accepted", duplicate: true });
      await submitted;
    });
    if (phase === "old-epoch")
      await act(async () =>
        finishFrame({
          kind: "events",
          session: session(),
          events: [
            fact === "user" ? userEvent(source, 30) : handoffEvent(source, 30),
          ],
          has_more: false,
          composer_prediction: ready(source, 30, "Unsafe frame suggestion"),
        }),
      );
    expect(view.result.current.composerPrediction).toBeNull();
    expect(view.result.current.events.at(-1)?.seq).toBe(30);
    frame.events = [];
    frame.snapshot = ready("D", 50, "Later external suggestion");
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction?.suggestion).toBe(
      "Later external suggestion",
    );
    expect(
      mocks.request.mock.calls.some(
        ([, r]) => r.method === "poll" && r.after === 30,
      ),
    ).toBe(true);
    expect(standaloneReads()).toHaveLength(0);
  },
);
it("retains the current Send barrier across a same-server reconnect before its User anchor is observed", async () => {
  const frame = predictionFixture();
  const view = await openPredictionFixture();
  const base = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation(async (host, r) =>
    r.method === "send_queued"
      ? { kind: "accepted", duplicate: true }
      : base(host, r),
  );
  await act(async () => {
    await view.result.current.send("New turn", null, null, null);
  });
  frame.events = [];
  frame.snapshot = ready("A", 10, "Pre-send cache");
  await act(async () =>
    view.result.current.refreshHost(view.result.current.host),
  );
  expect(view.result.current.composerPrediction?.suggestion ?? null).toBeNull();
  const source = mocks.request.mock.calls.find(
    ([, r]) => r.method === "send_queued",
  )![1].request_id;
  frame.snapshot = ready(source, 30, "Current Send suggestion");
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction?.suggestion).toBe(
    "Current Send suggestion",
  );
});
it.each(["cancel", "take"])(
  "restores later predictions after authoritative queued Send %s without a User event",
  async (action) => {
    const frame = predictionFixture();
    const view = await openPredictionFixture();
    const base = mocks.request.getMockImplementation()!;
    let source = "";
    let pending = true;
    const entry = () => ({
      request_id: source,
      text: "Queued instruction",
      model: null,
      effort: null,
      permission_mode: null,
      revision: 0,
      created_at: 1,
    });
    mocks.request.mockImplementation(async (host, r) => {
      if (r.method === "send_queued") {
        source = r.request_id;
        return { kind: "message_queued", duplicate: false };
      }
      if (r.method === "message_queue")
        return {
          kind: "message_queue",
          entries: pending ? [entry()] : [],
          paused: false,
          reason: null,
        };
      if (r.method === "cancel_queued_message") {
        pending = false;
        return {
          kind: "message_queue",
          entries: [],
          paused: false,
          reason: null,
        };
      }
      if (r.method === "take_queued_message") {
        pending = false;
        return { kind: "queued_message_taken", entry: entry() };
      }
      return base(host, r);
    });
    await act(async () => {
      await view.result.current.send("Queued instruction", null, null, null);
    });
    renderWithStatus(
      <MessageQueue
        hostId="local"
        sessionId="s"
        connected
        active
        running
        revision="0"
        onEdit={vi.fn()}
        captureQueuedPredictionRetirement={
          view.result.current.captureQueuedPredictionRetirement
        }
      />,
    );
    await act(async () => {});
    if (action === "cancel")
      fireEvent.click(
        screen.getByRole("button", {
          name: "删除排队消息：Queued instruction",
        }),
      );
    else {
      fireEvent.click(
        screen.getByRole("button", {
          name: "排队消息更多操作：Queued instruction",
        }),
      );
      fireEvent.click(screen.getByRole("menuitem", { name: "编辑消息" }));
    }
    await act(async () => {});
    frame.events = [];
    frame.snapshot = ready("D", 50, "Later external suggestion");
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction?.suggestion).toBe(
      "Later external suggestion",
    );
    expect(standaloneReads()).toHaveLength(0);
  },
);
it("does not let a captured queue retirement clear a newer Send with the same request ID", async () => {
  const frame = predictionFixture();
  const view = await openPredictionFixture();
  vi.spyOn(crypto, "randomUUID").mockReturnValue(
    "00000000-0000-4000-8000-000000000000",
  );
  const base = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation(async (host, r) =>
    r.method === "send_queued"
      ? { kind: "message_queued", duplicate: true }
      : base(host, r),
  );
  await act(async () => {
    await view.result.current.send("Queued instruction", null, null, null);
  });
  const retireOld = view.result.current.captureQueuedPredictionRetirement(
    "00000000-0000-4000-8000-000000000000",
  );
  await act(async () => {
    await view.result.current.send("Queued instruction", null, null, null);
  });
  act(() => retireOld());
  frame.events = [];
  frame.snapshot = ready("D", 50, "Unconfirmed newer Send");
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction?.suggestion ?? null).toBeNull();
});
it("keeps an observed Send source frontier after a late queue retirement", async () => {
  const frame = predictionFixture();
  const view = await openPredictionFixture();
  const base = mocks.request.getMockImplementation()!;
  let source = "";
  mocks.request.mockImplementation(async (host, r) => {
    if (r.method === "send_queued") {
      source = r.request_id;
      return { kind: "message_queued", duplicate: false };
    }
    return base(host, r);
  });
  await act(async () => {
    await view.result.current.send("Queued instruction", null, null, null);
  });
  const retire = view.result.current.captureQueuedPredictionRetirement(source);
  frame.events = [userEvent(source, 40)];
  frame.snapshot = ready(source, 40, "Observed source");
  await act(async () => vi.advanceTimersByTimeAsync(650));
  act(() => retire());
  expect(view.result.current.composerPrediction?.suggestion).toBe(
    "Observed source",
  );
  frame.events = [];
  frame.snapshot = ready("A", 10, "Older source");
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction?.suggestion).toBe(
    "Observed source",
  );
});
it("does not let an old-server queue retirement clear a new-server Send barrier", async () => {
  const frame = predictionFixture();
  const view = await openPredictionFixture();
  vi.spyOn(crypto, "randomUUID").mockReturnValue(
    "00000000-0000-4000-8000-000000000000",
  );
  const base = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation(async (host, r) =>
    r.method === "send_queued"
      ? { kind: "message_queued", duplicate: true }
      : base(host, r),
  );
  await act(async () => {
    await view.result.current.send("Queued instruction", null, null, null);
  });
  const retireOld = view.result.current.captureQueuedPredictionRetirement(
    "00000000-0000-4000-8000-000000000000",
  );
  mocks.connect.mockResolvedValue({
    kind: "hello",
    server_id: "new-server",
    agents: [{ id: "claude", available: true }],
  });
  await act(async () =>
    view.result.current.refreshHost(view.result.current.host),
  );
  await act(async () => {
    await view.result.current.send("Queued instruction", null, null, null);
  });
  act(() => retireOld());
  frame.events = [];
  frame.snapshot = ready("D", 50, "Unconfirmed new-server source");
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.composerPrediction?.suggestion ?? null).toBeNull();
});
it.each(["sending", "old-epoch"])(
  "rejects an older C40 cache after a same-connection %s frame contains current Send C40 and later User D50",
  async (phase) => {
    const frame = predictionFixture();
    const view = await openPredictionFixture();
    const base = mocks.request.getMockImplementation()!;
    let source = "";
    let finishSend!: (value: unknown) => void;
    let finishFrame!: (value: unknown) => void;
    let hold = phase === "old-epoch";
    mocks.request.mockImplementation(async (host, r) => {
      if (r.method === "send_queued") {
        source = r.request_id;
        return new Promise((resolve) => {
          finishSend = resolve;
        });
      }
      if (r.method === "poll" && r.after !== Number.MAX_SAFE_INTEGER) {
        if (hold) {
          hold = false;
          return new Promise((resolve) => {
            finishFrame = resolve;
          });
        }
        if (phase === "sending" && r.after === 10)
          return {
            kind: "events",
            session: session(),
            events: [userEvent(source, 40), userEvent("D", 50)],
            has_more: false,
            composer_prediction: ready(source, 40, "Older C40 cache"),
          };
      }
      return base(host, r);
    });
    if (phase === "old-epoch")
      await act(async () => vi.advanceTimersByTimeAsync(650));
    let submitted!: Promise<boolean>;
    await act(async () => {
      submitted = view.result.current.send("New turn", null, null, null);
    });
    if (phase === "sending")
      await act(async () => vi.advanceTimersByTimeAsync(650));
    await act(async () => {
      finishSend({ kind: "accepted", duplicate: true });
      await submitted;
    });
    if (phase === "old-epoch")
      await act(async () =>
        finishFrame({
          kind: "events",
          session: session(),
          events: [userEvent(source, 40), userEvent("D", 50)],
          has_more: false,
          composer_prediction: ready(source, 40, "Older C40 cache"),
        }),
      );
    frame.events = [];
    frame.snapshot = ready(source, 40, "Older C40 cache");
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(
      view.result.current.composerPrediction?.suggestion ?? null,
    ).toBeNull();
    frame.snapshot = ready("D", 50, "Current D50 cache");
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction?.suggestion).toBe(
      "Current D50 cache",
    );
  },
);
it.each(["user", "handoff"])(
  "harvests only the matching Send %s fact from an automatic earlier history page",
  async (fact) => {
    predictionFixture(true);
    const base = mocks.request.getMockImplementation()!;
    let source = "";
    let finishWindow!: (value: unknown) => void;
    mocks.request.mockImplementation(async (host, r) => {
      if (r.method === "send_queued") {
        source = r.request_id;
        return { kind: "accepted", duplicate: true };
      }
      if (r.method === "history" && r.before === null)
        return new Promise((resolve) => {
          finishWindow = resolve;
        });
      if (r.method === "history")
        return {
          kind: "history",
          session: session(),
          events: [
            fact === "user" ? userEvent(source, 40) : handoffEvent(source, 40),
            userEvent("Unrelated earlier-page source", 200),
            handoffEvent("Unrelated earlier-page handoff", 20),
          ],
          has_more: true,
          needs_earlier: false,
          before: 20,
          composer_prediction: ready(
            "Unrelated earlier-page source",
            200,
            "Never publish the page snapshot",
          ),
        };
      if (r.method === "poll")
        return {
          kind: "events",
          session: session(),
          events: [],
          has_more: false,
          composer_prediction: ready("D", 50, "Later live source"),
        };
      return base(host, r);
    });
    const view = await openPredictionFixture();
    await act(async () => {
      await view.result.current.send("New turn", null, null, null);
    });
    await act(async () =>
      finishWindow({
        kind: "history",
        session: session(),
        events: [
          {
            seq: 300,
            at: 1,
            session_id: "s",
            event: { kind: "text", text: "Most recent reply without User C" },
          },
        ],
        has_more: true,
        needs_earlier: true,
        before: 250,
        composer_prediction: ready(source, 40, "Old window snapshot"),
      }),
    );
    expect(view.result.current.composerPrediction).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(view.result.current.historyLoading).toBe(false);
    expect(view.result.current.composerPrediction).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction?.suggestion).toBe(
      "Later live source",
    );
    expect(standaloneReads()).toHaveLength(0);
  },
);
it.each(["invisible", "settings", "skills", "hidden", "sending"])(
  "retains a live external User frontier across %s publication gating and a tail without that User",
  async (gate) => {
    const frame = predictionFixture();
    const view = await openPredictionFixture();
    let finishSend!: (value: unknown) => void;
    let submitted!: Promise<boolean>;
    if (gate === "sending") {
      const base = mocks.request.getMockImplementation()!;
      mocks.request.mockImplementation(async (host, r) =>
        r.method === "send_queued"
          ? new Promise((resolve) => {
              finishSend = resolve;
            })
          : base(host, r),
      );
      await act(async () => {
        submitted = view.result.current.send(
          "Queued instruction",
          null,
          null,
          null,
        );
      });
    }
    if (gate === "invisible")
      act(() => view.result.current.setPredictionVisible(false));
    if (gate === "settings" || gate === "skills")
      act(() => view.result.current.setModal(gate));
    const visibility = vi.spyOn(document, "visibilityState", "get");
    if (gate === "hidden") visibility.mockReturnValue("hidden");
    // Native handoff/another client supplies a newer durable User while cache is still A10.
    frame.events = [userEvent("B", 30)];
    frame.snapshot = ready("A", 10, "Old main source");
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(
      view.result.current.composerPrediction?.suggestion ?? null,
    ).toBeNull();
    frame.events = [];
    if (gate === "sending") {
      await act(async () => {
        finishSend({ kind: "message_queued", duplicate: false });
        await submitted;
      });
      const requestId = mocks.request.mock.calls.find(
        ([, r]) => r.method === "send_queued",
      )![1].request_id;
      // Model the already separately tested authoritative Cancel/Take callback.
      act(() =>
        view.result.current.captureQueuedPredictionRetirement(requestId)(),
      );
    }
    act(() => {
      view.result.current.setPredictionVisible(true);
      view.result.current.setModal(null);
    });
    visibility.mockReturnValue("visible");
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(
      view.result.current.composerPrediction?.suggestion ?? null,
    ).toBeNull();
    frame.snapshot = ready("B", 30, "Current external source");
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(view.result.current.composerPrediction?.suggestion).toBe(
      "Current external source",
    );
    expect(
      mocks.request.mock.calls.some(
        ([, r]) => r.method === "poll" && r.after === 30,
      ),
    ).toBe(true);
  },
);
it("does not query predictions on a legacy host", async () => {
  const view = await openPredictionFixture();
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(standaloneReads()).toHaveLength(0);
  expect(view.result.current.composerPrediction).toBeNull();
});
it("consumes only the initial live history snapshot while assembling earlier final-reply pages", async () => {
  predictionFixture(true);
  const base = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation(async (host, r) => {
    if (r.method !== "history") return base(host, r);
    return {
      kind: "history",
      session: session(),
      events: r.before === null ? [userEvent("B", 30)] : [userEvent("A", 10)],
      has_more: true,
      needs_earlier: r.before === null,
      before: r.before === null ? 20 : 5,
      composer_prediction:
        r.before === null
          ? ready("B", 30, "Live suggestion")
          : ready("A", 10, "Page suggestion"),
    };
  });
  const view = await openPredictionFixture();
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(view.result.current.historyLoading).toBe(false);
  expect(view.result.current.events.map((event) => event.seq)).toEqual([
    10, 30,
  ]);
  expect(view.result.current.composerPrediction?.suggestion).toBe(
    "Live suggestion",
  );
});
it("captures the Send epoch before an initial History request starts", async () => {
  predictionFixture(true);
  const base = mocks.request.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  mocks.request.mockImplementation(async (host, r) => {
    if (r.method === "history")
      return new Promise((resolve) => {
        finish = resolve;
      });
    if (r.method === "send_queued")
      return { kind: "accepted", duplicate: true };
    return base(host, r);
  });
  const view = await openPredictionFixture();
  await act(async () => {
    await view.result.current.send("new input", null, null, null);
  });
  await act(async () =>
    finish({
      kind: "history",
      session: session(),
      events: [],
      has_more: false,
      needs_earlier: false,
      before: null,
      composer_prediction: ready("A", 10, "Pre-send snapshot"),
    }),
  );
  expect(view.result.current.historyLoading).toBe(false);
  expect(view.result.current.composerPrediction).toBeNull();
});
it("allows a new connection's source frontier to restart without restoring an old frame", async () => {
  const frame = predictionFixture();
  frame.snapshot = ready("B", 30);
  frame.events = [userEvent("B", 30)];
  const view = await openPredictionFixture();
  frame.snapshot = ready("A", 10, "New connection snapshot");
  frame.events = [];
  await act(async () =>
    view.result.current.refreshHost(view.result.current.host),
  );
  expect(view.result.current.composerPrediction?.suggestion).toBe(
    "New connection snapshot",
  );
});
it("retains real main transport disconnect handling without replaying a prompt", async () => {
  predictionFixture();
  const view = await openPredictionFixture();
  const base = mocks.request.getMockImplementation()!;
  let fail = true;
  mocks.request.mockImplementation(async (host, r) => {
    if (r.method === "poll" && fail) {
      fail = false;
      const failure = new HostConnectionError(host, "Main transport failed");
      window.dispatchEvent(
        new CustomEvent(HOST_DISCONNECTED_EVENT, { detail: failure }),
      );
      throw failure;
    }
    return base(host, r);
  });
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.connected).toBe(false);
  expect(view.result.current.composerPrediction).toBeNull();
  expect(view.result.current.error).toContain("Main transport failed");
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(view.result.current.connected).toBe(true);
  expect(standaloneReads()).toHaveLength(0);
  expect(
    mocks.request.mock.calls.some(([, r]) => r.method === "send_queued"),
  ).toBe(false);
});
it("keeps ordinary main poll errors retryable instead of treating them as optional cache failures", async () => {
  predictionFixture();
  const view = await openPredictionFixture();
  const base = mocks.request.getMockImplementation()!;
  let fail = true;
  mocks.request.mockImplementation(async (host, r) => {
    if (r.method === "poll" && fail) {
      fail = false;
      throw new Error("Main read unavailable");
    }
    return base(host, r);
  });
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(view.result.current.connected).toBe(true);
  expect(view.result.current.error).toContain("Main read unavailable");
  const reads = mocks.request.mock.calls.filter(
    ([, r]) => r.method === "poll",
  ).length;
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(
    mocks.request.mock.calls.filter(([, r]) => r.method === "poll").length,
  ).toBeGreaterThan(reads);
  expect(standaloneReads()).toHaveLength(0);
});
const acknowledgements = () =>
  mocks.request.mock.calls.filter(
    ([, r]) => r.method === "mark_session_unread",
  );
it.each(["local", "remote"])(
  "starts in a new task after relaunch even when a %s conversation was previously selected",
  async (targetHost) => {
    mocks.loadHosts.mockResolvedValue([
      { id: "local", name: "Local" },
      { id: "remote", name: "Remote", ssh: "fixture-host" },
    ]);
    const first = renderHook(useWorkbench);
    await act(async () => {});
    expect(first.result.current.sessionId).toBe("");
    expect(first.result.current.sessions).toHaveLength(1);
    expect(first.result.current.session).toBeUndefined();
    expect(mocks.request.mock.calls.some(([, r]) => r.method === "poll")).toBe(
      false,
    );
    await act(async () =>
      first.result.current.openSession({ ...session(), hostId: targetHost }),
    );
    expect(first.result.current.sessionId).toBe("s");
    await act(async () =>
      first.result.current.refreshHost(first.result.current.host),
    );
    expect(first.result.current.sessionId).toBe("s");
    first.unmount();
    mocks.request.mockClear();
    const reopened = renderHook(useWorkbench);
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(reopened.result.current.connected).toBe(true);
    expect(reopened.result.current.sessionId).toBe("");
    expect(reopened.result.current.session).toBeUndefined();
    expect(reopened.result.current.events).toEqual([]);
    expect(reopened.result.current.historyLoading).toBe(false);
    expect(reopened.result.current.sessions).toHaveLength(1);
    expect(
      mocks.request.mock.calls.some(([, r]) =>
        [
          "poll",
          "history",
          "open_agent_session",
          "create_session",
          "send",
          "mark_session_unread",
        ].includes(r.method),
      ),
    ).toBe(false);
  },
);
it("creates a new conversation on the first startup submission instead of sending to an existing one", async () => {
  const base = mocks.request.getMockImplementation()!;
  const created = { ...session(), id: "new", unread: false };
  mocks.request.mockImplementation(async (host: string, r: Request) => {
    if (r.method === "create_session")
      return { kind: "session", session: created };
    if (r.method === "send_queued")
      return { kind: "accepted", duplicate: false };
    if (r.method === "poll" && r.session_id === created.id)
      return {
        kind: "events",
        session: created,
        events: [],
        has_more: false,
      };
    return base(host, r);
  });
  const { result } = renderHook(useWorkbench);
  await act(async () => {});
  expect(result.current.sessionId).toBe("");
  await act(async () => {
    expect(await result.current.send("new task", null, null, null)).toBe(true);
  });
  expect(result.current.sessionId).toBe(created.id);
  expect(
    mocks.request.mock.calls.filter(([, r]) => r.method === "create_session"),
  ).toHaveLength(1);
  const sends = mocks.request.mock.calls.filter(
    ([, r]) => r.method === "send_queued",
  );
  expect(sends).toHaveLength(1);
  expect(sends[0][1]).toMatchObject({
    session_id: created.id,
    text: "new task",
  });
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(result.current.sessionId).toBe(created.id);
});
it("initializes each host once and refreshes the selected host without a second connection", async () => {
  const remote = { id: "remote", name: "Remote", ssh: "fixture-host" };
  mocks.loadHosts.mockResolvedValue([{ id: "local", name: "Local" }, remote]);
  const hook = renderHook(useWorkbench);
  await act(async () => {});
  for (const host of ["local", "remote"]) {
    expect(hook.result.current.hostConnectionStatus(host)).toBe("connected");
    expect(hook.result.current.hostConnectionVersions[host]).toBe(1);
    expect(
      mocks.connect.mock.calls.filter(([h]) => h.id === host),
    ).toHaveLength(1);
    expect(
      mocks.request.mock.calls.filter(
        ([h, r]) => h === host && r.method === "projects",
      ),
    ).toHaveLength(1);
  }
  await act(async () =>
    hook.result.current.refreshHost(hook.result.current.host),
  );
  expect(
    mocks.connect.mock.calls.filter(([h]) => h.id === "local"),
  ).toHaveLength(2);
  expect(
    mocks.request.mock.calls.filter(
      ([h, r]) => h === "local" && r.method === "projects",
    ),
  ).toHaveLength(2);
  expect(hook.result.current.connected).toBe(true);
  expect(hook.result.current.hostConnectionVersions.local).toBe(2);
  expect(hook.result.current.hostConnectionVersions.remote).toBe(1);
});
it("waits for the handshake before reading cached pinned history and reporting connection state", async () => {
  let finish: (value: unknown) => void = () => {};
  mocks.connect.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const hook = renderHook(useWorkbench);
  await act(async () => {});
  expect(hook.result.current.hostConnectionStatus("local")).toBe("connecting");
  expect(mocks.request).not.toHaveBeenCalled();
  await act(async () =>
    finish({ kind: "hello", server_id: "server-local", agents: [] }),
  );
  expect(hook.result.current.hostConnectionStatus("local")).toBe("connected");
  expect(hook.result.current.hostErrors.local).toBe("");
  expect(
    mocks.request.mock.calls.some(([, r]) => r.method === "pinned_sessions"),
  ).toBe(true);
  expect(
    mocks.request.mock.calls.some(([, r]) => r.method === "send_queued"),
  ).toBe(false);
});
it("adding a host initializes it once and preserves other hosts' live connections", async () => {
  const hook = renderHook(useWorkbench);
  await act(async () => {});
  const remote = {
    id: "remote",
    name: "Remote",
    ssh: "fixture-host",
    server_path: null,
  };
  await act(async () => hook.result.current.saveSshHost(remote));
  for (const host of ["local", "remote"]) {
    expect(
      mocks.connect.mock.calls.filter(([h]) => h.id === host),
    ).toHaveLength(1);
    expect(
      mocks.request.mock.calls.filter(
        ([h, r]) => h === host && r.method === "projects",
      ),
    ).toHaveLength(1);
  }
  await act(async () => hook.result.current.removeSshHost(remote.id));
  await act(async () => hook.result.current.saveSshHost(remote));
  expect(
    mocks.connect.mock.calls.filter(([h]) => h.id === "remote"),
  ).toHaveLength(2);
  expect(
    mocks.connect.mock.calls.filter(([h]) => h.id === "local"),
  ).toHaveLength(1);
});
it.each(["completed", "failed"] as const)(
  "preserves %s unread in the background and acknowledges it when viewed",
  async (terminalStatus) => {
    status = terminalStatus;
    const hook = renderHook(useWorkbench);
    await act(async () => {});
    await act(async () =>
      hook.result.current.openSession({ ...session(), hostId: "local" }),
    );
    expect(hook.result.current.session?.unread).toBe(true);
    expect(acknowledgements()).toHaveLength(0);
    focused = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(650);
    });
    expect(acknowledgements()).toHaveLength(1);
    expect(hook.result.current.session?.unread).toBe(false);
    expect(hook.result.current.session?.status).toBe(terminalStatus);
  },
);
it("does not acknowledge running output, and marks the completed turn read only at the end of replay", async () => {
  focused = true;
  status = "running";
  const hook = renderHook(useWorkbench);
  await act(async () => {});
  await act(async () =>
    hook.result.current.openSession({ ...session(), hostId: "local" }),
  );
  expect(acknowledgements()).toHaveLength(0);
  status = "completed";
  hasMore = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(650);
  });
  expect(acknowledgements()).toHaveLength(0);
  hasMore = false;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(acknowledgements()).toHaveLength(1);
});

it("publishes initial history only after the last replay page arrives", async () => {
  const base = mocks.request.getMockImplementation()!;
  let finishLast!: (value: unknown) => void;
  let polls = 0;
  mocks.request.mockImplementation(async (host: string, r: Request) => {
    if (r.method !== "poll") return base(host, r);
    polls++;
    if (polls === 1)
      return {
        kind: "events",
        session: session(),
        events: [
          {
            seq: 1,
            at: 0,
            session_id: "s",
            event: { kind: "text", text: "First page" },
          },
        ],
        has_more: true,
      };
    return new Promise((resolve) => {
      finishLast = resolve;
    });
  });
  const hook = renderHook(useWorkbench);
  await act(async () => {});
  await act(async () =>
    hook.result.current.openSession({ ...session(), hostId: "local" }),
  );
  expect(hook.result.current.historyLoading).toBe(true);
  expect(hook.result.current.events).toEqual([]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    finishLast({
      kind: "events",
      session: session(),
      events: [
        {
          seq: 2,
          at: 0,
          session_id: "s",
          event: { kind: "text", text: "Last page" },
        },
      ],
      has_more: false,
    });
  });
  expect(hook.result.current.historyLoading).toBe(false);
  expect(hook.result.current.events.map((e) => e.seq)).toEqual([1, 2]);
});

it("marks a new unsaved task disconnected after metadata transport failure and reconnects without sending", async () => {
  const hook = renderHook(useWorkbench);
  await act(async () => {});
  await act(async () => {
    await hook.result.current.createSession();
  });
  expect(hook.result.current.sessionId).toBe("");
  act(() =>
    window.dispatchEvent(
      new CustomEvent(HOST_DISCONNECTED_EVENT, {
        detail: new HostConnectionError("local", "连接已失效"),
      }),
    ),
  );
  expect(hook.result.current.connected).toBe(false);
  expect(hook.result.current.connectionLost).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(hook.result.current.connected).toBe(true);
  expect(hook.result.current.sessionId).toBe("");
  expect(
    mocks.request.mock.calls.filter(([, r]) => r.method === "send_queued"),
  ).toHaveLength(0);
});
it("starts an unsaved creator task on a host without projects and opens its directory picker on that host", async () => {
  const remote = { id: "remote", name: "Remote", ssh: "fixture-host" };
  mocks.loadHosts.mockResolvedValue([{ id: "local", name: "Local" }, remote]);
  const base = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation(async (host: string, request: Request) =>
    host === "remote" && request.method === "projects"
      ? { kind: "projects", projects: [] }
      : base(host, request),
  );
  const hook = renderHook(useWorkbench);
  await act(async () => {});
  await act(async () => hook.result.current.createSession(undefined, "remote"));
  expect(hook.result.current.hostId).toBe("remote");
  expect(hook.result.current.projectId).toBe("");
  expect(hook.result.current.sessionId).toBe("");
  act(() => hook.result.current.openProject());
  expect(hook.result.current.modal).toBe("project");
  expect(hook.result.current.projectHostId).toBe("remote");
  expect(
    mocks.request.mock.calls.some(([, request]) =>
      ["create_session", "send_queued", "open_agent_session"].includes(
        request.method,
      ),
    ),
  ).toBe(false);
});
it("a background host's failure does not disconnect the selected host", async () => {
  const hook = renderHook(useWorkbench);
  await act(async () => {});
  act(() =>
    window.dispatchEvent(
      new CustomEvent(HOST_DISCONNECTED_EVENT, {
        detail: new HostConnectionError("other-host", "连接已关闭"),
      }),
    ),
  );
  expect(hook.result.current.connected).toBe(true);
  expect(hook.result.current.hostErrors["other-host"]).toBe("连接已关闭");
});
it("automatically recovers a background host without reconnecting the selected host or sending a prompt", async () => {
  mocks.loadHosts.mockResolvedValue([
    { id: "local", name: "Local" },
    { id: "remote", name: "Remote", ssh: "fixture-host", server_path: null },
  ]);
  const hook = renderHook(useWorkbench);
  await act(async () => {});
  act(() =>
    window.dispatchEvent(
      new CustomEvent(HOST_DISCONNECTED_EVENT, {
        detail: new HostConnectionError("remote", "连接已关闭"),
      }),
    ),
  );
  expect(hook.result.current.connected).toBe(true);
  expect(hook.result.current.isHostConnected("remote")).toBe(false);
  expect(hook.result.current.hostConnectionStatus("remote")).toBe("failed");
  expect(hook.result.current.hostConnectionStatus("local")).toBe("connected");
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(hook.result.current.isHostConnected("remote")).toBe(true);
  expect(hook.result.current.hostConnectionStatus("remote")).toBe("connected");
  expect(hook.result.current.hostConnectionVersions.remote).toBe(2);
  expect(
    mocks.connect.mock.calls.filter(([h]) => h.id === "remote"),
  ).toHaveLength(2);
  expect(
    mocks.connect.mock.calls.filter(([h]) => h.id === "local"),
  ).toHaveLength(1);
  expect(
    mocks.request.mock.calls.some(([, r]) => r.method === "send_queued"),
  ).toBe(false);
});
it("does not reuse a failed replacement and restores the connection indicator without replaying a prompt", async () => {
  const hook = renderHook(useWorkbench);
  await act(async () => {});
  mocks.connect.mockRejectedValueOnce(new Error("SSH 握手失败"));
  await act(async () =>
    hook.result.current.refreshHost(hook.result.current.host),
  );
  expect(hook.result.current.hostConnectionStatus("local")).toBe("failed");
  expect(hook.result.current.connected).toBe(false);
  expect(hook.result.current.hostConnectionVersions.local).toBe(1);
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(hook.result.current.hostConnectionStatus("local")).toBe("connected");
  expect(hook.result.current.connected).toBe(true);
  expect(hook.result.current.hostConnectionVersions.local).toBe(2);
  expect(mocks.connect).toHaveBeenCalledTimes(3);
  expect(
    mocks.request.mock.calls.some(([, r]) => r.method === "send_queued"),
  ).toBe(false);
});
it("retains history and an ambiguous send request ID without automatically replaying the message", async () => {
  const base = mocks.request.getMockImplementation()!;
  let failSend = true;
  mocks.request.mockImplementation(async (host: string, r: Request) => {
    if (r.method === "poll")
      return {
        ...(await base(host, r)),
        events: [
          {
            seq: 1,
            at: 1,
            session_id: "s",
            event: { kind: "text", text: "保留的历史回复" },
          },
        ],
      };
    if (r.method !== "send_queued") return base(host, r);
    if (failSend) {
      const failure = new HostConnectionError(host, "发送响应丢失");
      window.dispatchEvent(
        new CustomEvent(HOST_DISCONNECTED_EVENT, { detail: failure }),
      );
      throw failure;
    }
    return { kind: "message_queued", duplicate: true };
  });
  const hook = renderHook(useWorkbench);
  await act(async () => {});
  await act(async () =>
    hook.result.current.openSession({ ...session(), hostId: "local" }),
  );
  const history = hook.result.current.events;
  expect(history).toHaveLength(1);
  await act(async () => {
    expect(await hook.result.current.send("hello", null, null, null)).toBe(
      false,
    );
  });
  expect(hook.result.current.connected).toBe(false);
  expect(hook.result.current.events).toEqual(history);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  const sends = () =>
    mocks.request.mock.calls.filter(([, r]) => r.method === "send_queued");
  expect(sends()).toHaveLength(1);
  failSend = false;
  await act(async () => {
    expect(await hook.result.current.send("hello", null, null, null)).toBe(
      true,
    );
  });
  expect(sends()).toHaveLength(2);
  expect(sends()[1][1].request_id).toBe(sends()[0][1].request_id);
  expect(hook.result.current.admissionNotice).toContain("此前已被接收");
  act(() => hook.result.current.dismissAdmissionNotice());
  expect(hook.result.current.admissionNotice).toBeUndefined();
});

it("returns a side close acknowledgement without clearing the selected main conversation", async () => {
  const { result } = renderHook(() => useWorkbench());
  await act(async () => {});
  await act(async () =>
    result.current.openSession({ ...session(), hostId: "local" }),
  );
  mocks.request.mockResolvedValueOnce({ kind: "side_chat_closed" });
  await act(async () => {
    expect(
      await result.current.sessionAction("local", {
        method: "close_agent_session",
        session_id: "side",
        only_if_idle: false,
      }),
    ).toEqual({ kind: "side_chat_closed" });
  });
  expect(result.current.sessionId).toBe("s");
});

it("opens selected Agent sessions and closes explicitly without reopening on refresh", async () => {
  const { result } = renderHook(() => useWorkbench());
  await act(async () => {});
  await act(async () =>
    result.current.openSession({ ...session(), hostId: "local" }),
  );
  expect(
    mocks.request.mock.calls.some(
      ([, r]) => r.method === "open_agent_session" && r.session_id === "s",
    ),
  ).toBe(true);
  const previousScope = result.current.readingScope;
  await act(async () => {
    await result.current.sessionAction("local", {
      method: "close_agent_session",
      session_id: "s",
    });
  });
  expect(result.current.sessionId).toBe("");
  const opens = mocks.request.mock.calls.filter(
    ([, r]) => r.method === "open_agent_session",
  ).length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(result.current.sessionId).toBe("");
  expect(
    mocks.request.mock.calls.filter(
      ([, r]) => r.method === "open_agent_session",
    ),
  ).toHaveLength(opens);
  await act(async () => {
    result.current.openSession({ ...session(), hostId: "local" });
  });
  expect(result.current.readingScope).not.toBe(previousScope);
  expect(
    mocks.request.mock.calls.filter(
      ([, r]) => r.method === "open_agent_session",
    ),
  ).toHaveLength(opens + 1);
});

it("distinguishes first open, recovery, and switching to a live session", async () => {
  unread = false;
  const opened = new Set<string>();
  const rows = () =>
    ["s", "t"].map((id) => ({
      ...session(),
      id,
      agent_session_open: opened.has(id),
    }));
  const finish = new Map<string, () => void>();
  const base = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation(async (host: string, r: Request) => {
    if (r.method === "sessions") return { kind: "sessions", sessions: rows() };
    if (r.method === "poll")
      return {
        kind: "events",
        session: rows().find((s) => s.id === r.session_id),
        events: [],
        has_more: false,
      };
    if (r.method === "open_agent_session")
      return new Promise((resolve) => {
        finish.set(r.session_id, () => {
          opened.add(r.session_id);
          resolve({ kind: "ok" });
        });
      });
    return base(host, r);
  });
  const { result } = renderHook(useWorkbench);
  const state = (id: string) =>
    result.current.agentSessionState({
      ...rows().find((s) => s.id === id)!,
      hostId: "local",
    });
  await act(async () => {});
  await act(async () =>
    result.current.openSession({ ...rows()[0], hostId: "local" }),
  );
  expect(state("s")).toBe("opening");
  await act(async () => finish.get("s")!());
  expect(state("s")).toBe("open");
  opened.clear();
  act(() =>
    window.dispatchEvent(
      new CustomEvent(HOST_DISCONNECTED_EVENT, {
        detail: new HostConnectionError("local", "连接已失效"),
      }),
    ),
  );
  expect(state("s")).toBe("unknown");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(state("s")).toBe("restoring");
  await act(async () => finish.get("s")!());
  expect(state("s")).toBe("open");
  await act(async () =>
    result.current.openSession({ ...rows()[1], hostId: "local" }),
  );
  expect(state("t")).toBe("opening");
  await act(async () => finish.get("t")!());
  expect(state("t")).toBe("open");
  await act(async () =>
    result.current.openSession({ ...rows()[0], hostId: "local" }),
  );
  expect(state("s")).toBe("open");
  expect(
    mocks.request.mock.calls.filter(
      ([, r]) => r.method === "open_agent_session" && r.session_id === "s",
    ),
  ).toHaveLength(2);
  expect(
    mocks.request.mock.calls.some(([, r]) => r.method === "send_queued"),
  ).toBe(false);
});

it.each(["local", "remote"])(
  "returns to a live %s conversation without reconnecting, reopening or replaying history",
  async (targetHost) => {
    unread = false;
    mocks.loadHosts.mockResolvedValue([
      { id: "local", name: "Local" },
      { id: "remote", name: "Devbox", ssh: "devbox" },
    ]);
    const rows = (host: string) => [
      { ...session(), id: host === "remote" ? "remote-chat" : "s" },
    ];
    const base = mocks.request.getMockImplementation()!;
    let delayPoll = false;
    let finish!: (value: unknown) => void;
    mocks.request.mockImplementation(async (host: string, r: Request) => {
      if (r.method === "sessions")
        return { kind: "sessions", sessions: rows(host) };
      if (r.method === "poll") {
        if (host === targetHost && delayPoll && r.after === 1)
          return new Promise((resolve) => {
            finish = resolve;
          });
        return {
          kind: "events",
          session: rows(host)[0],
          has_more: false,
          events:
            r.after === 0
              ? [
                  {
                    seq: 1,
                    at: 1,
                    session_id: r.session_id,
                    event: { kind: "text", text: `${host} history` },
                  },
                ]
              : [],
        };
      }
      return base(host, r);
    });
    const { result } = renderHook(useWorkbench);
    await act(async () => {});
    const select = async (host: string) =>
      act(async () =>
        result.current.openSession({ ...rows(host)[0], hostId: host }),
      );
    await select("remote");
    expect(result.current.events[0].event).toEqual({
      kind: "text",
      text: "remote history",
    });
    await select("local");
    if (targetHost === "local") await select("remote");
    const connections = mocks.connect.mock.calls.length;
    const projects = mocks.request.mock.calls.filter(
      ([, r]) => r.method === "projects",
    ).length;
    const opens = mocks.request.mock.calls.filter(
      ([, r]) => r.method === "open_agent_session",
    ).length;
    const polls = mocks.request.mock.calls.filter(
      ([h, r]) => h === targetHost && r.method === "poll",
    ).length;
    delayPoll = true;
    await select(targetHost);
    expect(result.current.connected).toBe(true);
    expect(result.current.connecting).toBe(false);
    expect(result.current.historyLoading).toBe(false);
    expect(result.current.events[0].event).toEqual({
      kind: "text",
      text: `${targetHost} history`,
    });
    expect(mocks.connect).toHaveBeenCalledTimes(connections);
    expect(
      mocks.request.mock.calls.filter(([, r]) => r.method === "projects"),
    ).toHaveLength(projects);
    expect(
      mocks.request.mock.calls.filter(
        ([, r]) => r.method === "open_agent_session",
      ),
    ).toHaveLength(opens);
    expect(
      mocks.request.mock.calls
        .filter(([h, r]) => h === targetHost && r.method === "poll")
        .slice(polls),
    ).toEqual([
      [
        targetHost,
        { method: "poll", session_id: rows(targetHost)[0].id, after: 1 },
      ],
    ]);
    await act(async () =>
      finish({
        kind: "events",
        session: rows(targetHost)[0],
        events: [],
        has_more: false,
      }),
    );
    await act(async () => result.current.setRetry((value) => value + 1));
    expect(mocks.connect.mock.calls.length).toBeGreaterThan(connections);
    expect(
      mocks.request.mock.calls.some(([, r]) => r.method === "send_queued"),
    ).toBe(false);
  },
);

it("lets the workspace grow to the available window and preserves its preferred width through layout changes", async () => {
  vi.stubGlobal("innerWidth", 1920);
  const hook = renderHook(useWorkbench);
  await act(async () => {});
  act(() => hook.result.current.setPanel(true));
  const dragRight = () => {
    act(() => {
      hook.result.current.resize(
        {
          preventDefault: vi.fn(),
          clientX: window.innerWidth - hook.result.current.rightWidth - 1,
          pointerId: 1,
          currentTarget: { setPointerCapture: vi.fn(), dataset: {} },
        } as unknown as React.PointerEvent<HTMLElement>,
        "right",
      );
      const sidebar = hook.result.current.sidebarOpen
        ? hook.result.current.leftWidth
        : 0;
      window.dispatchEvent(
        new MouseEvent("pointermove", {
          clientX: sidebar + 240 + (sidebar ? 1 : 0),
        }),
      );
      window.dispatchEvent(new MouseEvent("pointerup"));
    });
  };
  const resizeWindow = (width: number) => {
    act(() => {
      vi.stubGlobal("innerWidth", width);
      window.dispatchEvent(new globalThis.Event("resize"));
    });
  };
  dragRight();
  const wide = hook.result.current.rightWidth;
  expect(wide).toBeGreaterThan(600);
  expect(wide + hook.result.current.leftWidth + 2).toBe(1920 - 240);
  resizeWindow(960);
  expect(hook.result.current.rightWidth).toBe(
    960 - hook.result.current.leftWidth - 240 - 2,
  );
  resizeWindow(1920);
  expect(hook.result.current.rightWidth).toBe(wide);
  act(() => hook.result.current.toggleSidebar());
  dragRight();
  const withoutSidebar = hook.result.current.rightWidth;
  expect(withoutSidebar).toBe(1920 - 240 - 1);
  act(() => hook.result.current.toggleSidebar());
  expect(hook.result.current.rightWidth).toBe(wide);
  act(() => hook.result.current.toggleSidebar());
  expect(hook.result.current.rightWidth).toBe(withoutSidebar);
  expect(document.body.style.userSelect).toBe("");
});

it("merges once per drag, leaves navigation resizing independent, and restores a narrow conversation from the button", async () => {
  vi.stubGlobal("innerWidth", 1440);
  const hook = renderHook(useWorkbench);
  await act(async () => {});
  await act(async () =>
    hook.result.current.openSession({ ...session(), hostId: "local" }),
  );
  act(() => hook.result.current.setPanel(true));
  const handle = document.createElement("div");
  handle.setPointerCapture = vi.fn();
  const startDrag = (side: "left" | "right", start: number) =>
    hook.result.current.resize(
      {
        preventDefault: vi.fn(),
        clientX: start,
        pointerId: 1,
        currentTarget: handle,
      } as unknown as React.PointerEvent<HTMLElement>,
      side,
    );
  const move = (x: number) =>
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: x }));
  const stop = () => window.dispatchEvent(new MouseEvent("pointerup"));
  const sidebar = hook.result.current.leftWidth;
  const preferred = hook.result.current.workspace.width;
  act(() => {
    startDrag("right", 1440 - hook.result.current.rightWidth - 1);
    expect(handle.dataset.resizing).toBe("true");
    move(sidebar + 8);
    move(sidebar + 400);
    stop();
  });
  expect(handle.dataset.resizing).toBeUndefined();
  expect(hook.result.current.workspace).toMatchObject({
    expanded: true,
    conversationActive: true,
    width: preferred,
  });
  act(() => hook.result.current.setSessionId("other"));
  expect(hook.result.current.workspace.expanded).toBe(false);
  act(() => hook.result.current.setSessionId("s"));
  expect(hook.result.current.workspace).toMatchObject({
    expanded: true,
    conversationActive: true,
  });
  act(() => {
    startDrag("left", sidebar);
    move(sidebar + 100);
    stop();
  });
  expect(hook.result.current.leftWidth).toBe(320);
  expect(hook.result.current.workspace).toMatchObject({
    expanded: true,
    width: preferred,
  });
  act(() => {
    startDrag("left", 320);
    move(100);
    stop();
  });
  expect(hook.result.current.leftWidth).toBe(200);
  expect(hook.result.current.workspace.expanded).toBe(true);
  act(() => {
    startDrag("right", 200);
    move(600);
    stop();
  });
  expect(hook.result.current.workspace.expanded).toBe(true);
  act(() => hook.result.current.restoreWorkspace());
  expect(hook.result.current.workspace).toMatchObject({
    visible: true,
    expanded: false,
    width: 1440 - 200 - 320 - 2,
  });
  expect(document.body.style.userSelect).toBe("");
});
it("restores a split without left navigation and cleans the drag highlight on cancellation", async () => {
  vi.stubGlobal("innerWidth", 960);
  const hook = renderHook(useWorkbench);
  await act(async () => {});
  act(() => {
    hook.result.current.setPanel(true);
    hook.result.current.toggleSidebar();
  });
  act(() => hook.result.current.restoreWorkspace());
  expect(hook.result.current.rightWidth).toBe(960 - 320 - 1);
  const handle = document.createElement("div");
  handle.setPointerCapture = vi.fn();
  act(() =>
    hook.result.current.resize(
      {
        preventDefault: vi.fn(),
        clientX: 320,
        pointerId: 1,
        currentTarget: handle,
      } as unknown as React.PointerEvent<HTMLElement>,
      "right",
    ),
  );
  expect(handle.dataset.resizing).toBe("true");
  act(() => window.dispatchEvent(new MouseEvent("pointercancel")));
  expect(handle.dataset.resizing).toBeUndefined();
  expect(document.body.style.userSelect).toBe("");
});

it.each(["local", "remote"])(
  "reveals a recent %s window without replaying old pages and retains its raw cursor across live polling and navigation",
  async (targetHost) => {
    unread = false;
    mocks.loadHosts.mockResolvedValue([
      { id: "local", name: "Local" },
      { id: "remote", name: "Remote", ssh: "fixture" },
    ]);
    mocks.connect.mockImplementation(async (host: { id: string }) => ({
      kind: "hello",
      server_id: `server-${host.id}`,
      agents: [],
      history_window: true,
    }));
    const base = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(async (host: string, r: Request) => {
      if (r.method === "history")
        return {
          kind: "history",
          session: session(),
          has_more: r.before === null,
          needs_earlier: false,
          before: r.before === null ? 3000 : null,
          events: [
            {
              seq: r.before === null ? 4000 : 2000,
              at: 1,
              session_id: "s",
              event: {
                kind: "text",
                text:
                  r.before === null ? "Complete latest reply" : "Earlier reply",
              },
            },
          ],
        };
      if (r.method === "poll")
        return {
          kind: "events",
          session: session(),
          has_more: false,
          events:
            r.after === 4000
              ? [
                  {
                    seq: 4001,
                    at: 2,
                    session_id: "s",
                    event: { kind: "notice", text: "Live update" },
                  },
                ]
              : [],
        };
      return base(host, r);
    });
    const { result } = renderHook(useWorkbench);
    await act(async () => {});
    await act(async () =>
      result.current.openSession({ ...session(), hostId: targetHost }),
    );
    expect(result.current.historyLoading).toBe(false);
    expect(result.current.hasEarlierHistory).toBe(true);
    expect(result.current.events[0].seq).toBe(4000);
    expect(
      mocks.request.mock.calls.filter(
        ([h, r]) =>
          h === targetHost && r.method === "history" && r.before === null,
      ),
    ).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(650);
    });
    expect(result.current.events.at(-1)?.seq).toBe(4001);
    await act(async () => result.current.loadEarlierHistory());
    expect(mocks.request).toHaveBeenCalledWith(targetHost, {
      method: "history",
      session_id: "s",
      before: 3000,
    });
    expect(result.current.events.map((e) => e.seq)).toEqual([2000, 4000, 4001]);
    expect(result.current.hasEarlierHistory).toBe(false);
    await act(async () => result.current.createSession());
    const reads = mocks.request.mock.calls.filter(
      ([h, r]) => h === targetHost && r.method === "history",
    ).length;
    await act(async () =>
      result.current.openSession({ ...session(), hostId: targetHost }),
    );
    expect(result.current.historyLoading).toBe(false);
    expect(result.current.events.map((e) => e.seq)).toEqual([2000, 4000, 4001]);
    expect(
      mocks.request.mock.calls.filter(
        ([h, r]) => h === targetHost && r.method === "history",
      ),
    ).toHaveLength(reads);
  },
);

it("assembles a split final reply before revealing history without reading unrelated old pages", async () => {
  mocks.connect.mockResolvedValue({
    kind: "hello",
    server_id: "server-local",
    agents: [],
    history_window: true,
  });
  const base = mocks.request.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  mocks.request.mockImplementation(async (host: string, r: Request) => {
    if (r.method !== "history") return base(host, r);
    if (r.before !== null)
      return new Promise((resolve) => {
        finish = resolve;
      });
    return {
      kind: "history",
      session: session(),
      has_more: true,
      needs_earlier: true,
      before: 100,
      events: [
        {
          seq: 200,
          at: 1,
          session_id: "s",
          event: { kind: "text", text: "end" },
        },
      ],
    };
  });
  const { result } = renderHook(useWorkbench);
  await act(async () => {});
  await act(async () =>
    result.current.openSession({ ...session(), hostId: "local" }),
  );
  expect(result.current.historyLoading).toBe(true);
  expect(result.current.events).toEqual([]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () =>
    finish({
      kind: "history",
      session: session(),
      has_more: true,
      needs_earlier: false,
      before: 50,
      events: [
        {
          seq: 99,
          at: 0,
          session_id: "s",
          event: { kind: "text", text: "begin" },
        },
      ],
    }),
  );
  expect(result.current.historyLoading).toBe(false);
  expect(result.current.events.map((e) => e.seq)).toEqual([99, 200]);
  expect(result.current.hasEarlierHistory).toBe(true);
  expect(
    mocks.request.mock.calls.filter(([, r]) => r.method === "history"),
  ).toHaveLength(2);
});

it.each([
  "/agents inspect",
  "/list-agents all",
  "/tasks 参数",
  "/agents\n请继续检查",
])(
  "opens local navigation for %s without admitting a turn or discarding arguments",
  async (text) => {
    const hook = renderHook(useWorkbench);
    await act(async () => {});
    const before = hook.result.current.workspaceId;
    mocks.request.mockClear();
    let accepted = true;
    await act(async () => {
      accepted = await hook.result.current.send(text, null, null, null);
    });
    expect(accepted).toBe(false);
    expect(hook.result.current.sessionId).toBe("");
    expect(hook.result.current.workspaceId).toBe(before);
    expect(hook.result.current.workspace).toMatchObject({
      visible: true,
      current: "subagents",
    });
    expect(hook.result.current.error).toContain("此命令不接受参数");
    expect(mocks.request).not.toHaveBeenCalled();
  },
);

it.each(["/list-agents", "/agents", "/tasks", "/subagents"])(
  "opens %s without creating a conversation or sending an agent request",
  async (command) => {
    const hook = renderHook(useWorkbench);
    await act(async () => {});
    const workspaceId = hook.result.current.workspaceId;
    mocks.request.mockClear();
    let accepted = false;
    await act(async () => {
      accepted = await hook.result.current.send(command, null, null, null);
    });
    expect(accepted).toBe(true);
    expect(hook.result.current.sessionId).toBe("");
    expect(hook.result.current.workspaceId).toBe(workspaceId);
    expect(hook.result.current.workspace).toMatchObject({
      visible: true,
      current: "subagents",
      conversationActive: false,
    });
    expect(mocks.request).not.toHaveBeenCalled();
  },
);

it("keeps the selected conversation and its status unchanged when opening the local agent list", async () => {
  const hook = renderHook(useWorkbench);
  await act(async () => {});
  await act(async () =>
    hook.result.current.openSession({ ...session(), hostId: "local" }),
  );
  const before = hook.result.current.session;
  mocks.request.mockClear();
  await act(async () =>
    hook.result.current.send("  /list-agents ", null, null, null),
  );
  expect(hook.result.current.session).toEqual(before);
  expect(hook.result.current.workspace.current).toBe("subagents");
  expect(mocks.request).not.toHaveBeenCalled();
});

it.each(["/model", "/effort high"])(
  "guards %s before session persistence even if a caller bypasses the composer",
  async (text) => {
    const hook = renderHook(useWorkbench);
    await act(async () => {});
    mocks.request.mockClear();
    await act(async () => {
      expect(await hook.result.current.send(text, null, null, null)).toBe(
        false,
      );
    });
    expect(hook.result.current.sessionId).toBe("");
    expect(hook.result.current.error).toContain("模型菜单");
    expect(mocks.request).not.toHaveBeenCalled();
  },
);

it("retains project ordering after host refresh and a new workbench mount", async () => {
  const projects = [
    { id: "p", name: "P", path: "/p" },
    { id: "second", name: "Second", path: "/second" },
  ];
  const original = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation((host, r) =>
    r.method === "projects"
      ? Promise.resolve({ kind: "projects", projects })
      : original(host, r),
  );
  const first = renderHook(useWorkbench);
  await act(async () => {});
  const ids = () => first.result.current.projects.map((p) => p.id);
  expect(ids()).toEqual(["p", "second"]);
  const selectedProject = first.result.current.projectId;
  act(() =>
    first.result.current.moveProject(
      JSON.stringify(["local", "second"]),
      JSON.stringify(["local", "p"]),
      false,
    ),
  );
  expect(ids()).toEqual(["second", "p"]);
  expect(first.result.current.projectId).toBe(selectedProject);
  await act(async () =>
    first.result.current.refreshHost(first.result.current.host),
  );
  expect(ids()).toEqual(["second", "p"]);
  first.unmount();
  const next = renderHook(useWorkbench);
  await act(async () => {});
  expect(next.result.current.projects.map((p) => p.id)).toEqual([
    "second",
    "p",
  ]);
});

it("keeps the known lifecycle when reconciling a previously accepted request", async () => {
  const base = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation(async (host, r) =>
    r.method === "send_queued"
      ? { kind: "accepted", duplicate: true }
      : base(host, r),
  );
  const hook = renderHook(useWorkbench);
  await act(async () => {});
  await act(async () =>
    hook.result.current.openSession({ ...session(), hostId: "local" }),
  );
  const before = hook.result.current.session?.status;
  await act(async () => {
    expect(await hook.result.current.send("reconcile", null, null, null)).toBe(
      true,
    );
  });
  expect(hook.result.current.session?.status).toBe(before);
  expect(hook.result.current.admissionNotice).toContain("没有重复发送");
});

it.each([false, true])(
  "cleans archived session state only after confirmed close (failure=%s)",
  async (fails) => {
    const base = mocks.request.getMockImplementation()!;
    let finish!: (value: unknown) => void;
    mocks.request.mockImplementation(async (host, r) => {
      if (r.method === "open_agent_session")
        return new Promise((resolve) => {
          finish = resolve;
        });
      if (r.method === "archive_session") {
        if (fails) throw new Error("native close failed");
        return {
          kind: "session",
          session: { ...session(), archived: true, agent_session_open: false },
        };
      }
      return base(host, r);
    });
    const hook = renderHook(useWorkbench);
    await act(async () => {});
    await act(async () =>
      hook.result.current.openSession({ ...session(), hostId: "local" }),
    );
    expect(finish).toBeTypeOf("function");
    await act(async () => {
      const archive = hook.result.current.sessionAction("local", {
        method: "archive_session",
        session_id: "s",
        archived: true,
      });
      if (fails) await expect(archive).rejects.toThrow("native close failed");
      else await archive;
    });
    expect(hook.result.current.sessionId).toBe(fails ? "s" : "");
    await act(async () => finish({ kind: "ok" }));
    expect(
      hook.result.current.sessions.find((s) => s.id === "s")?.archived,
    ).toBe(!fails);
    if (!fails) {
      expect(
        hook.result.current.agentSessionTransitions[
          JSON.stringify(["local", "s"])
        ],
      ).toBeUndefined();
      expect(
        mocks.request.mock.calls.some(
          ([, r]) => r.method === "poll" && r.after === Number.MAX_SAFE_INTEGER,
        ),
      ).toBe(false);
      expect(
        mocks.request.mock.calls.some(
          ([, r]) => r.method === "close_agent_session",
        ),
      ).toBe(false);
    }
  },
);

it("creates the selected native Agent and keeps the saved session Agent fixed", async () => {
  const agents = [
    {
      id: "claude",
      name: "Claude Code",
      available: true,
      detail: "",
      provider_protocols: [],
    },
    {
      id: "traex",
      name: "Traex",
      available: true,
      detail: "",
      provider_protocols: [],
    },
  ];
  mocks.connect.mockResolvedValue({
    kind: "hello",
    server_id: "server-local",
    agents,
  });
  const base = mocks.request.getMockImplementation()!;
  const created = { ...session(), id: "native", agent: "traex" };
  mocks.request.mockImplementation(async (host: string, r: Request) => {
    if (r.method === "create_session")
      return { kind: "session", session: created };
    if (r.method === "send_queued")
      return { kind: "accepted", duplicate: false };
    if (r.method === "poll" && r.session_id === created.id)
      return { kind: "events", session: created, events: [], has_more: false };
    return base(host, r);
  });
  const { result } = renderHook(useWorkbench);
  await act(async () => {});
  act(() => result.current.selectAgent("traex"));
  expect(result.current.agent?.id).toBe("traex");
  await act(async () => {
    expect(await result.current.send("native turn", null, null, null)).toBe(
      true,
    );
  });
  expect(
    mocks.request.mock.calls.find(
      ([, r]) => r.method === "create_session",
    )?.[1],
  ).toMatchObject({ agent: "traex" });
  act(() => result.current.selectAgent("claude"));
  expect(result.current.agent?.id).toBe("traex");
});

it("persists pinned ordering through native refresh, disconnect/reconnect and remount without sending a request to reorder", async () => {
  const rows = [
    { ...session(), id: "pin-a", title: "A", pinned_at: 2 },
    { ...session(), id: "pin-b", title: "B", pinned_at: 1 },
  ];
  const base = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation((host, r) =>
    r.method === "pinned_sessions"
      ? Promise.resolve({ kind: "sessions", sessions: rows })
      : base(host, r),
  );
  const hook = renderHook(useWorkbench);
  await act(async () => {});
  expect(hook.result.current.pinned.map((s) => s.id)).toEqual([
    "pin-a",
    "pin-b",
  ]);
  mocks.request.mockClear();
  act(() =>
    hook.result.current.movePinnedSession(
      JSON.stringify(["local", "pin-b"]),
      JSON.stringify(["local", "pin-a"]),
      false,
    ),
  );
  expect(hook.result.current.pinned.map((s) => s.id)).toEqual([
    "pin-b",
    "pin-a",
  ]);
  expect(mocks.request).not.toHaveBeenCalled();
  rows.reverse();
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(hook.result.current.pinned.map((s) => s.id)).toEqual([
    "pin-b",
    "pin-a",
  ]);
  await act(async () =>
    hook.result.current.refreshHost(hook.result.current.host),
  );
  expect(hook.result.current.pinned.map((s) => s.id)).toEqual([
    "pin-b",
    "pin-a",
  ]);
  hook.unmount();
  const restored = renderHook(useWorkbench);
  await act(async () => {});
  expect(restored.result.current.pinned.map((s) => s.id)).toEqual([
    "pin-b",
    "pin-a",
  ]);
});

it("keeps the selected conversation unread while Skills is visible and returns on task navigation", async () => {
  const hook = renderHook(useWorkbench);
  await act(async () => {});
  await act(async () =>
    hook.result.current.openSession({ ...session(), hostId: "local" }),
  );
  const original = hook.result.current.sessionId;
  focused = true;
  mocks.request.mockClear();
  act(() => hook.result.current.setModal("skills"));
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(hook.result.current.sessionId).toBe(original);
  expect(
    mocks.request.mock.calls.filter(
      ([, request]) => request.method === "mark_session_unread",
    ),
  ).toHaveLength(0);
  act(() => hook.result.current.openSession({ ...session(), hostId: "local" }));
  expect(hook.result.current.modal).toBeNull();
  expect(hook.result.current.sessionId).toBe(original);
  act(() => hook.result.current.setModal("skills"));
  await act(async () => hook.result.current.createSession());
  expect(hook.result.current.modal).toBeNull();
  expect(hook.result.current.sessionId).toBe("");
});

it("reads skill support independently from each connected host hello", async () => {
  mocks.loadHosts.mockResolvedValue([
    { id: "local", name: "Local" },
    { id: "remote", name: "Remote", ssh: "fixture-host", server_path: null },
  ]);
  mocks.connect.mockImplementation(async (host: { id: string }) => ({
    kind: "hello",
    server_id: `server-${host.id}`,
    agents: [],
    skill_management: host.id === "local",
    skill_file_import: host.id === "local",
  }));
  const hook = renderHook(useWorkbench);
  await act(async () => {});
  expect(hook.result.current.hostSupportsSkills("local")).toBe(true);
  expect(hook.result.current.hostSupportsSkills("remote")).toBe(false);
  expect(hook.result.current.hostSupportsSkills("missing")).toBe(false);
  expect(hook.result.current.hostSupportsSkillFiles("local")).toBe(true);
  expect(hook.result.current.hostSupportsSkillFiles("remote")).toBe(false);
  expect(hook.result.current.hostSupportsSkillFiles("missing")).toBe(false);
});
