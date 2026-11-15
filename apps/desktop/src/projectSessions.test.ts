import { beforeEach, expect, it, vi } from "vitest";
import {
  openProjectSessions,
  needsCloseConfirmation,
  closeProjectSessions,
} from "./projectSessions";
import type { Session } from "./protocol";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => ({
  request: mocks.request,
  message: String,
  ServerRequestError: class extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
import { ServerRequestError } from "./api";
const session = (id: string, patch = {}) =>
  ({
    id,
    project_id: "p",
    status: "completed",
    agent_session_open: true,
    agent_session_busy: false,
    ...patch,
  }) as Session;
beforeEach(() => vi.clearAllMocks());
it("includes pinned and unselected open sessions and excludes closed history", async () => {
  mocks.request.mockResolvedValue({
    kind: "sessions",
    sessions: [
      session("pinned", { pinned_at: 1 }),
      session("other"),
      session("history", { agent_session_open: false }),
    ],
  });
  expect((await openProjectSessions("remote", "p")).map((s) => s.id)).toEqual([
    "pinned",
    "other",
  ]);
  expect(mocks.request).toHaveBeenCalledWith("remote", {
    method: "sessions",
    project_id: "p",
  });
});
it("does not infer closed state from older servers or task completion", async () => {
  mocks.request.mockResolvedValue({
    kind: "sessions",
    sessions: [session("old", { agent_session_open: undefined })],
  });
  await expect(openProjectSessions("remote", "p")).rejects.toThrow(
    "未提供会话状态",
  );
  expect(
    needsCloseConfirmation([
      session("background", { agent_session_busy: true }),
    ]),
  ).toBe(true);
  expect(
    needsCloseConfirmation([session("waiting", { status: "waiting" })]),
  ).toBe(true);
  expect(
    needsCloseConfirmation([
      session("unknown", { agent_session_busy: undefined }),
    ]),
  ).toBe(true);
  expect(needsCloseConfirmation([session("idle")])).toBe(false);
});
it("reports partial failures and retries only failed sessions on their host", async () => {
  const close = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("offline"));
  const result = await closeProjectSessions(
    "remote",
    "p",
    [session("a"), session("b")],
    close,
  );
  expect(result.closed).toEqual(["a"]);
  expect(result.failed[0].session.id).toBe("b");
  close.mockResolvedValue(undefined);
  await closeProjectSessions(
    "remote",
    "p",
    result.failed.map((x) => x.session),
    close,
  );
  expect(close.mock.calls).toEqual([
    ["remote", "a"],
    ["remote", "b"],
    ["remote", "b"],
  ]);
});

it("includes active children of a closed parent across every history page", async () => {
  mocks.request.mockImplementation(async (_host, action) => {
    if (action.method === "sessions")
      return {
        kind: "sessions",
        sessions: [
          session("parent", {
            agent: "claude",
            native_id: "native",
            agent_session_open: false,
          }),
        ],
      };
    return action.before === null
      ? {
          kind: "side_chat_history",
          sessions: [session("new", { agent_session_open: false })],
          next: "new",
        }
      : {
          kind: "side_chat_history",
          sessions: [
            session("running-side", {
              status: "running",
              agent_session_busy: true,
            }),
          ],
          next: null,
        };
  });
  const sessions = await openProjectSessions("remote", "p");
  expect(sessions.map((s) => s.id)).toEqual(["running-side"]);
  expect(needsCloseConfirmation(sessions)).toBe(true);
  expect(mocks.request).toHaveBeenCalledWith("remote", {
    method: "side_chat_history",
    session_id: "parent",
    before: "new",
  });
  const close = vi.fn().mockResolvedValue({ kind: "side_chat_closed" });
  const result = await closeProjectSessions("remote", "p", sessions, close);
  expect(result.closed).toEqual(["running-side"]);
  expect(result.failed).toEqual([]);
  expect(result.pendingWrites.map((s) => s.id)).toEqual(["running-side"]);
});

it("fails incomplete side inventory instead of closing a partial project", async () => {
  mocks.request.mockImplementation(async (_host, action) => {
    if (action.method === "sessions")
      return {
        kind: "sessions",
        sessions: [session("parent", { agent: "codex", native_id: "native" })],
      };
    return {
      kind: "side_chat_history",
      sessions: [session("side")],
      next: "same",
    };
  });
  await expect(openProjectSessions("remote", "p")).rejects.toThrow(
    "分页未前进",
  );
});

it("handles pre-side-chat hosts and rejects capped legacy side history", async () => {
  let legacyAvailable = false;
  mocks.request.mockImplementation(async (_host, action) => {
    if (action.method === "sessions")
      return {
        kind: "sessions",
        sessions: [session("parent", { agent: "codex", native_id: "native" })],
      };
    if (action.method === "side_chats" && legacyAvailable)
      return {
        kind: "sessions",
        sessions: Array.from({ length: 100 }, (_, i) => session(`side-${i}`)),
      };
    throw new ServerRequestError("invalid_request", "unknown method");
  });
  expect((await openProjectSessions("remote", "p")).map((s) => s.id)).toEqual([
    "parent",
  ]);
  legacyAvailable = true;
  await expect(openProjectSessions("remote", "p")).rejects.toThrow(
    "更新 Server",
  );
});
