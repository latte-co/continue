// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import { ServerRequestError } from "./api";
import type { Event, Request, Response, Session } from "./protocol";
import {
  resolveSideChatNavigation,
  resolveSideChatParentSession,
} from "./sideChatNavigation";
import { clearSideWriteConfirmation } from "./sideWritePrompts";
import { openSideChatTab, readWorkspace } from "./workspaceState";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  connect: vi.fn(),
  loadHosts: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  native: true,
  localHost: { id: "local", name: "本机", ssh: null, server_path: null },
  loadHosts: mocks.loadHosts,
  connect: mocks.connect,
  saveHosts: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  agentProviders: vi.fn().mockResolvedValue({
    kind: "providers",
    providers: [],
    bindings: [],
  }),
  agentEnvironments: vi.fn().mockResolvedValue({}),
  providerRequest: vi.fn().mockResolvedValue({
    kind: "providers",
    providers: [],
    bindings: [],
  }),
  request: mocks.request,
}));

vi.mock("./appLifecycle", () => ({ useAppLifecycle: () => {} }));
vi.mock("./TaskOverview", () => ({ TaskOverview: () => null }));
vi.mock("./TaskInfo", () => ({ TaskInfo: () => null }));
vi.mock("./SkillsPage", () => ({ SkillsPage: () => null }));
vi.mock("./SettingsPage", () => ({ SettingsPage: () => null }));
vi.mock("./HostDialogs", () => ({ HostDialogs: () => null }));
vi.mock("./SshPasswordDialog", () => ({ SshPasswordDialog: () => null }));

const UI_TIMEOUT = { timeout: 5000 };

function makeSession(
  overrides: Partial<Session> & Pick<Session, "id" | "project_id">,
): Session {
  return {
    title: overrides.id,
    agent: "codex",
    native_id: `native-${overrides.id}`,
    model: null,
    effort: null,
    permission_mode: null,
    status: "completed",
    created_at: 1,
    custom_title: false,
    title_requested: false,
    pinned_at: null,
    unread: false,
    archived: false,
    agent_session_open: false,
    agent_session_busy: false,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollTo = vi.fn();
  mocks.loadHosts.mockResolvedValue([
    { id: "local", name: "本机", ssh: null, server_path: null },
  ]);
  mocks.connect.mockResolvedValue({
    kind: "hello",
    server_id: "server-local",
    side_chat_controls: true,
    claude_side_chat: true,
    side_chat_inherit_permission: true,
    agents: [
      {
        id: "codex",
        name: "Codex",
        available: true,
        detail: "fixture",
        provider_protocols: [],
      },
      {
        id: "opencode",
        name: "OpenCode",
        available: true,
        detail: "fixture",
        provider_protocols: [],
      },
    ],
  });
});

afterEach(() => {
  clearSideWriteConfirmation("local", "side-a");
  clearSideWriteConfirmation("local", "side-archived-501");
  cleanup();
});

it("navigates from Project B to Project A's owning parent session to confirm a blocking side chat without project mismatch", async () => {
  let pendingWrite: string | undefined = "side-turn-1";
  const openedSessions = new Set<string>();
  const parentA = (): Session =>
    makeSession({
      id: "parent-a",
      project_id: "proj-a",
      title: "项目 A 主对话",
      agent: "codex",
      agent_session_open: openedSessions.has("parent-a"),
    });
  const sideA = (): Session =>
    makeSession({
      id: "side-a",
      project_id: "proj-a",
      title: "项目 A 侧聊",
      agent: "codex",
      parent_session_id: "parent-a",
      agent_session_open: openedSessions.has("side-a"),
      side_write_pending: pendingWrite,
    });
  // Project B uses opencode (which cannot open side chats itself) to verify
  // cross-project navigation is not gated on Project B's side-chat capability.
  const mainB = (): Session =>
    makeSession({
      id: "main-b",
      project_id: "proj-b",
      title: "项目 B 主对话",
      agent: "opencode",
      agent_session_open: openedSessions.has("main-b"),
    });
  const projectBChanges = {
    request_id: "req-b",
    undo: "ready" as const,
    interrupted: false,
    background_pending: false,
    summary: {
      baseline_at: 1,
      added: 2,
      removed: 0,
      binary_files: 0,
      truncated: false,
      unavailable: null,
      entries: [{ path: "b.txt", status: "M" as const, added: 2, removed: 0 }],
    },
  };
  const projectBEvents: Event[] = [
    {
      seq: 1,
      session_id: "main-b",
      at: 1,
      event: { kind: "user", text: "修改文件", request_id: "req-b" },
    },
    {
      seq: 2,
      session_id: "main-b",
      at: 2,
      event: {
        kind: "turn_changes",
        changes: projectBChanges,
      },
    },
  ];
  const sideAEvents: Event[] = [
    {
      seq: 1,
      session_id: "side-a",
      at: 1,
      event: {
        kind: "user",
        text: "后台检查",
        request_id: "side-turn-1",
      },
    },
    {
      seq: 2,
      session_id: "side-a",
      at: 2,
      event: { kind: "text", text: "侧聊输出完成" },
    },
  ];

  mocks.request.mockImplementation(
    async (_hostId: string, req: Request): Promise<Response> => {
      switch (req.method) {
        case "projects":
          return {
            kind: "projects",
            projects: [
              { id: "proj-b", name: "项目 B", path: "/tmp/proj-b" },
              { id: "proj-a", name: "项目 A", path: "/tmp/proj-a" },
            ],
          };
        case "pinned_sessions":
          return { kind: "sessions", sessions: [] };
        case "recent_sessions":
          return {
            kind: "recent_sessions",
            sessions: [
              { session: mainB(), updated_at: 2 },
              { session: parentA(), updated_at: 1 },
            ],
            next: null,
          };
        case "sessions":
          return {
            kind: "sessions",
            sessions: req.project_id === "proj-a" ? [parentA()] : [mainB()],
          };
        case "session":
          if (req.session_id === "side-a")
            return { kind: "session", session: sideA() };
          if (req.session_id === "parent-a")
            return { kind: "session", session: parentA() };
          if (req.session_id === "main-b")
            return { kind: "session", session: mainB() };
          throw new ServerRequestError("request_failed", "会话不存在");
        case "history":
          if (req.session_id === "main-b")
            return {
              kind: "history",
              session: mainB(),
              events: req.before == null ? projectBEvents : [],
              has_more: false,
              needs_earlier: false,
              before: null,
            };
          if (req.session_id === "parent-a")
            return {
              kind: "history",
              session: parentA(),
              events: [],
              has_more: false,
              needs_earlier: false,
              before: null,
            };
          if (req.session_id === "side-a")
            return {
              kind: "history",
              session: sideA(),
              events: req.before == null ? sideAEvents : [],
              has_more: false,
              needs_earlier: false,
              before: null,
            };
          throw new ServerRequestError("request_failed", "会话不存在");
        case "poll":
          if (req.session_id === "main-b")
            return {
              kind: "events",
              session: mainB(),
              events: req.after === 0 ? projectBEvents : [],
              has_more: false,
            };
          if (req.session_id === "parent-a")
            return {
              kind: "events",
              session: parentA(),
              events: [],
              has_more: false,
            };
          if (req.session_id === "side-a")
            return {
              kind: "events",
              session: sideA(),
              events: req.after === 0 ? sideAEvents : [],
              has_more: false,
            };
          throw new ServerRequestError("request_failed", "会话不存在");
        case "subagents":
          return { kind: "subagents", tasks: [], truncated: false };
        case "skills":
          return {
            kind: "skills",
            skills: [],
            warnings: [],
            truncated: false,
          };
        case "sources":
          return { kind: "sources", entries: [], truncated: false };
        case "message_queue":
          return {
            kind: "message_queue",
            entries: [],
            paused: false,
            reason: null,
          };
        case "agent_commands":
          return { kind: "agent_commands", commands: [] };
        case "terminals":
          return { kind: "terminals", terminals: [] };
        case "models":
          return {
            kind: "models",
            models: [],
            provider: null,
            default_model: null,
            effort_levels: [],
            model_labels: {},
          };
        case "agent_permissions":
          return {
            kind: "agent_permissions",
            modes: [],
          };
        case "open_agent_session":
          openedSessions.add(req.session_id);
          return { kind: "ok" };
        case "close_agent_session":
          openedSessions.delete(req.session_id);
          return { kind: "ok" };
        case "git_info":
          return {
            kind: "git_info",
            info: {
              branch: "main",
              head: null,
              default_base: "main",
              refs: [],
              truncated: false,
            },
          };
        case "side_chat_history":
          return {
            kind: "side_chat_history",
            sessions: req.session_id === "parent-a" ? [sideA()] : [],
            next: null,
          };
        case "undo_turn_changes":
          if (pendingWrite)
            throw new ServerRequestError(
              "request_failed",
              "具备写权限的侧边聊天（side-a）的写入结束时间待确认；请先核对后台进程并确认写入已结束",
            );
          return {
            kind: "turn_changes",
            changes: { ...projectBChanges, undo: "reverted" },
          };
        case "confirm_side_writes_ended":
          expect(req.session_id).toBe("side-a");
          expect(req.request_id).toBe("side-turn-1");
          pendingWrite = undefined;
          return { kind: "session", session: sideA() };
        default:
          throw new Error(`unexpected request: ${req.method}`);
      }
    },
  );

  render(<App />);

  // Open Project B's conversation from the sidebar and attempt to undo its turn changes.
  fireEvent.click(await screen.findByText("项目 B 主对话", {}, UI_TIMEOUT));
  const undoButton = await screen.findByRole(
    "button",
    { name: "撤销" },
    UI_TIMEOUT,
  );
  expect(screen.queryByRole("button", { name: /^状态提示（/ })).toBeNull();
  fireEvent.click(undoButton);

  // Status center surfaces the cross-project side-chat recovery action.
  const statusTrigger = await screen.findByRole(
    "button",
    { name: /^状态提示（/ },
    UI_TIMEOUT,
  );
  fireEvent.click(statusTrigger);
  fireEvent.click(
    await screen.findByRole("button", { name: "核对侧边聊天" }, UI_TIMEOUT),
  );

  // Must navigate to Project A's parent session and open side-a there, leaving Project B untouched.
  await waitFor(() => {
    expect(readWorkspace("parent-a").current).toBe("sideChat:side-a");
    expect(readWorkspace("parent-a").visible).toBe(true);
  }, UI_TIMEOUT);
  expect(readWorkspace("main-b").tabs).toEqual([]);

  // SideChat loads side-a under parent-a without "侧边聊天记录不匹配" and shows the write-confirmation notice.
  expect(await screen.findByText("侧聊输出完成", {}, UI_TIMEOUT)).toBeTruthy();
  expect(screen.queryByText("侧边聊天记录不匹配")).toBeNull();
  expect(
    await screen.findByText("侧边聊天后台写入待确认。", {}, UI_TIMEOUT),
  ).toBeTruthy();

  const inspectButton = await screen.findByRole(
    "button",
    { name: "核对后台写入已结束" },
    UI_TIMEOUT,
  );
  await waitFor(
    () => expect(inspectButton).toHaveProperty("disabled", false),
    UI_TIMEOUT,
  );
  fireEvent.click(inspectButton);

  expect(
    await screen.findByText(
      "请核对侧边聊天启动的后台进程和外部工具均已停止写入工作区。",
      {},
      UI_TIMEOUT,
    ),
  ).toBeTruthy();
  const confirmButton = await screen.findByRole(
    "button",
    { name: "我已核对，确认结束" },
    UI_TIMEOUT,
  );
  await waitFor(
    () => expect(confirmButton).toHaveProperty("disabled", false),
    UI_TIMEOUT,
  );
  fireEvent.click(confirmButton);

  await waitFor(() => expect(pendingWrite).toBeUndefined(), UI_TIMEOUT);

  // Returning to Project B now lets the blocked undo complete cleanly.
  fireEvent.click(await screen.findByText("项目 B 主对话", {}, UI_TIMEOUT));
  fireEvent.click(
    await screen.findByRole("button", { name: "撤销" }, UI_TIMEOUT),
  );
  expect(
    await screen.findByRole("button", { name: "已撤销" }, UI_TIMEOUT),
  ).toBeTruthy();
}, 15_000);

it("resolves the owning parent session on legacy servers that omit parent_session_id", async () => {
  const other = makeSession({ id: "parent-other", project_id: "proj-a" });
  const owner = makeSession({
    id: "parent-owner",
    project_id: "proj-a",
    archived: true,
  });
  const legacySide = makeSession({ id: "side-legacy", project_id: "proj-a" });

  mocks.request.mockImplementation(
    async (_hostId: string, req: Request): Promise<Response> => {
      if (req.method === "session" && req.session_id === "side-legacy")
        return { kind: "session", session: legacySide };
      if (req.method === "sessions" && req.project_id === "proj-a")
        return { kind: "sessions", sessions: [other, owner] };
      if (req.method === "side_chat_history") {
        if (req.session_id === "parent-other")
          return { kind: "side_chat_history", sessions: [], next: null };
        if (req.session_id === "parent-owner" && req.before === null)
          return {
            kind: "side_chat_history",
            sessions: [makeSession({ id: "side-newer", project_id: "proj-a" })],
            next: "side-newer",
          };
        if (req.session_id === "parent-owner" && req.before === "side-newer")
          return {
            kind: "side_chat_history",
            sessions: [legacySide],
            next: null,
          };
      }
      throw new Error(`unexpected request: ${JSON.stringify(req)}`);
    },
  );

  await expect(
    resolveSideChatParentSession("remote", "side-legacy"),
  ).resolves.toEqual(owner);
});

it("falls back to side_chats on older servers where side_chat_history is unsupported", async () => {
  const owner = makeSession({ id: "parent-v0", project_id: "proj-a" });
  const legacySide = makeSession({ id: "side-v0", project_id: "proj-a" });

  mocks.request.mockImplementation(
    async (_hostId: string, req: Request): Promise<Response> => {
      if (req.method === "session" && req.session_id === "side-v0")
        return { kind: "session", session: legacySide };
      if (req.method === "sessions" && req.project_id === "proj-a")
        return { kind: "sessions", sessions: [owner] };
      if (req.method === "side_chat_history")
        throw new ServerRequestError("unsupported", "不支持分页历史");
      if (req.method === "side_chats" && req.session_id === "parent-v0")
        return { kind: "sessions", sessions: [legacySide] };
      throw new Error(`unexpected request: ${JSON.stringify(req)}`);
    },
  );

  await expect(
    resolveSideChatParentSession("remote", "side-v0"),
  ).resolves.toEqual(owner);
});

it("paginates beyond the 500-session project cap on legacy servers without re-checking the first 500 sessions", async () => {
  const newerMains = Array.from({ length: 500 }, (_, index) =>
    makeSession({
      id: `main-new-${String(index + 1).padStart(3, "0")}`,
      project_id: "proj-a",
    }),
  );
  const otherProjectMain = makeSession({
    id: "main-other-proj",
    project_id: "proj-b",
  });
  const owner = makeSession({
    id: "parent-501",
    project_id: "proj-a",
  });
  const legacySide = makeSession({
    id: "side-beyond-500",
    project_id: "proj-a",
  });
  const allRecent = [...newerMains, otherProjectMain, owner].map(
    (session, index, list) => ({
      session,
      updated_at: list.length - index,
    }),
  );
  const historyChecks = new Map<string, number>();

  mocks.request.mockImplementation(
    async (_hostId: string, req: Request): Promise<Response> => {
      if (req.method === "session" && req.session_id === "side-beyond-500")
        return { kind: "session", session: legacySide };
      if (req.method === "sessions" && req.project_id === "proj-a")
        return { kind: "sessions", sessions: newerMains };
      if (req.method === "recent_sessions") {
        const startIndex =
          req.before == null
            ? 0
            : allRecent.findIndex(
                (item) =>
                  item.updated_at === req.before!.updated_at &&
                  item.session.id === req.before!.id,
              ) + 1;
        const slice = allRecent.slice(startIndex, startIndex + 100);
        const last = slice.at(-1);
        return {
          kind: "recent_sessions",
          sessions: slice,
          next:
            startIndex + slice.length < allRecent.length && last
              ? { updated_at: last.updated_at, id: last.session.id }
              : null,
        };
      }
      if (req.method === "side_chat_history") {
        historyChecks.set(
          req.session_id,
          (historyChecks.get(req.session_id) ?? 0) + 1,
        );
        return {
          kind: "side_chat_history",
          sessions: req.session_id === "parent-501" ? [legacySide] : [],
          next: null,
        };
      }
      throw new Error(`unexpected request: ${JSON.stringify(req)}`);
    },
  );

  await expect(
    resolveSideChatParentSession("remote", "side-beyond-500"),
  ).resolves.toEqual(owner);
  expect(historyChecks.get("parent-501")).toBe(1);
  expect(historyChecks.has("main-other-proj")).toBe(false);
  for (const session of newerMains) {
    expect(historyChecks.get(session.id)).toBe(1);
  }
});

it("falls back to project_agent_sessions when an active parent session in a hidden project is beyond the 500-session cap", async () => {
  const newerMains = Array.from({ length: 500 }, (_, index) =>
    makeSession({
      id: `main-live-cap-${index + 1}`,
      project_id: "proj-a",
    }),
  );
  const liveHiddenOwner = makeSession({
    id: "parent-live-501",
    project_id: "proj-a",
  });
  const legacySide = makeSession({
    id: "side-live-501",
    project_id: "proj-a",
  });

  mocks.request.mockImplementation(
    async (_hostId: string, req: Request): Promise<Response> => {
      if (req.method === "session" && req.session_id === "side-live-501")
        return { kind: "session", session: legacySide };
      if (req.method === "sessions" && req.project_id === "proj-a")
        return { kind: "sessions", sessions: newerMains };
      if (req.method === "recent_sessions")
        return { kind: "recent_sessions", sessions: [], next: null };
      if (
        req.method === "project_agent_sessions" &&
        req.project_id === "proj-a"
      ) {
        if (req.after === null)
          return {
            kind: "project_agent_sessions",
            sessions: [newerMains[0], legacySide],
            next: legacySide.id,
          };
        if (req.after === legacySide.id)
          return {
            kind: "project_agent_sessions",
            sessions: [liveHiddenOwner],
            next: null,
          };
      }
      if (req.method === "side_chat_history")
        return {
          kind: "side_chat_history",
          sessions: req.session_id === "parent-live-501" ? [legacySide] : [],
          next: null,
        };
      throw new Error(`unexpected request: ${JSON.stringify(req)}`);
    },
  );

  await expect(
    resolveSideChatParentSession("remote", "side-live-501"),
  ).resolves.toEqual(liveHiddenOwner);
});

it("clears a stale draft flag when opening a persisted side-chat tab", () => {
  openSideChatTab("ws-parent", "side-persisted", true);
  expect(readWorkspace("ws-parent").tabs).toEqual([
    { id: "sideChat:side-persisted", kind: "sideChat", draft: true },
  ]);
  openSideChatTab("ws-parent", "side-persisted", false);
  expect(readWorkspace("ws-parent").tabs).toEqual([
    { id: "sideChat:side-persisted", kind: "sideChat", draft: false },
  ]);
});

it("falls back to standalone side-chat recovery when a legacy parent session is archived, closed, and beyond the 500-session cap", async () => {
  const newerMains = Array.from({ length: 500 }, (_, index) =>
    makeSession({
      id: `main-cap-${index + 1}`,
      project_id: "proj-a",
    }),
  );
  const legacySide = makeSession({
    id: "side-archived-501",
    project_id: "proj-a",
    side_write_pending: "side-turn-archived",
  });

  mocks.request.mockImplementation(
    async (_hostId: string, req: Request): Promise<Response> => {
      if (req.method === "session" && req.session_id === "side-archived-501")
        return { kind: "session", session: legacySide };
      if (req.method === "sessions" && req.project_id === "proj-a")
        return { kind: "sessions", sessions: newerMains };
      if (req.method === "recent_sessions")
        return { kind: "recent_sessions", sessions: [], next: null };
      if (
        req.method === "project_agent_sessions" &&
        req.project_id === "proj-a"
      )
        return { kind: "project_agent_sessions", sessions: [], next: null };
      if (req.method === "side_chat_history")
        return { kind: "side_chat_history", sessions: [], next: null };
      throw new Error(`unexpected request: ${JSON.stringify(req)}`);
    },
  );

  await expect(
    resolveSideChatNavigation("remote", "side-archived-501"),
  ).resolves.toEqual({
    kind: "standalone",
    side: legacySide,
  });
});

it("rejects main sessions during legacy side-chat resolution instead of misrouting to standalone recovery", async () => {
  const mainTarget = makeSession({
    id: "main-not-side",
    project_id: "proj-a",
  });

  mocks.request.mockImplementation(
    async (_hostId: string, req: Request): Promise<Response> => {
      if (req.method === "session" && req.session_id === "main-not-side")
        return { kind: "session", session: mainTarget };
      if (req.method === "sessions" && req.project_id === "proj-a")
        return { kind: "sessions", sessions: [mainTarget] };
      throw new Error(`unexpected request: ${JSON.stringify(req)}`);
    },
  );

  await expect(
    resolveSideChatNavigation("remote", "main-not-side"),
  ).rejects.toThrow("侧边聊天记录不匹配");

  // Even if an archived, closed main session is beyond the 500-session cap,
  // owning child side chats proves it is a parent session rather than a side chat.
  const archivedParent = makeSession({
    id: "archived-parent-501",
    project_id: "proj-a",
    archived: true,
  });
  const childSide = makeSession({
    id: "child-of-501",
    project_id: "proj-a",
  });
  mocks.request.mockImplementation(
    async (_hostId: string, req: Request): Promise<Response> => {
      if (req.method === "session" && req.session_id === "archived-parent-501")
        return { kind: "session", session: archivedParent };
      if (req.method === "sessions" && req.project_id === "proj-a")
        return { kind: "sessions", sessions: [] };
      if (req.method === "recent_sessions")
        return { kind: "recent_sessions", sessions: [], next: null };
      if (req.method === "project_agent_sessions")
        return { kind: "project_agent_sessions", sessions: [], next: null };
      if (
        req.method === "side_chat_history" &&
        req.session_id === "archived-parent-501"
      )
        return {
          kind: "side_chat_history",
          sessions: [childSide],
          next: null,
        };
      throw new Error(`unexpected request: ${JSON.stringify(req)}`);
    },
  );

  await expect(
    resolveSideChatNavigation("remote", "archived-parent-501"),
  ).rejects.toThrow("侧边聊天记录不匹配");
});

it("reconciles a blocking legacy side chat via standalone recovery dialog when its archived closed parent is beyond the 500-session cap", async () => {
  let pendingClose: string | undefined = "close-archived-1";
  let pendingWrite: string | undefined = "side-turn-archived";
  let sideOpen = true;
  const newerMains = Array.from({ length: 500 }, (_, index) =>
    makeSession({
      id: `main-cap-e2e-${index + 1}`,
      project_id: "proj-a",
    }),
  );
  const legacySide = (): Session =>
    makeSession({
      id: "side-archived-501",
      project_id: "proj-a",
      title: "归档老父会话侧聊",
      agent: "codex",
      agent_session_open: sideOpen,
      agent_close_pending: pendingClose,
      side_write_pending: pendingWrite,
    });
  const mainB = (): Session =>
    makeSession({
      id: "main-b",
      project_id: "proj-b",
      title: "项目 B 主对话",
      agent: "opencode",
      agent_session_open: true,
    });
  const projectBChanges = {
    request_id: "req-b",
    undo: "ready" as const,
    interrupted: false,
    background_pending: false,
    summary: {
      baseline_at: 1,
      added: 2,
      removed: 0,
      binary_files: 0,
      truncated: false,
      unavailable: null,
      entries: [{ path: "b.txt", status: "M" as const, added: 2, removed: 0 }],
    },
  };
  const projectBEvents: Event[] = [
    {
      seq: 1,
      session_id: "main-b",
      at: 1,
      event: { kind: "user", text: "修改文件", request_id: "req-b" },
    },
    {
      seq: 2,
      session_id: "main-b",
      at: 2,
      event: { kind: "turn_changes", changes: projectBChanges },
    },
  ];
  const sideEvents: Event[] = [
    {
      seq: 1,
      session_id: "side-archived-501",
      at: 1,
      event: {
        kind: "user",
        text: "后台写入检查",
        request_id: "side-turn-archived",
      },
    },
    {
      seq: 2,
      session_id: "side-archived-501",
      at: 2,
      event: { kind: "text", text: "归档主会话侧聊输出完成" },
    },
  ];

  mocks.request.mockImplementation(
    async (_hostId: string, req: Request): Promise<Response> => {
      switch (req.method) {
        case "projects":
          return {
            kind: "projects",
            projects: [
              { id: "proj-b", name: "Project B", path: "/repo/b" },
              { id: "proj-a", name: "Project A", path: "/repo/a" },
            ],
          };
        case "pinned_sessions":
          return { kind: "sessions", sessions: [] };
        case "recent_sessions":
          return {
            kind: "recent_sessions",
            sessions: [{ session: mainB(), updated_at: 20 }],
            next: null,
          };
        case "project_agent_sessions":
          return {
            kind: "project_agent_sessions",
            sessions: req.project_id === "proj-b" ? [mainB()] : [legacySide()],
            next: null,
          };
        case "sessions":
          return {
            kind: "sessions",
            sessions: req.project_id === "proj-b" ? [mainB()] : newerMains,
          };
        case "session":
          if (req.session_id === "side-archived-501")
            return { kind: "session", session: legacySide() };
          if (req.session_id === "main-b")
            return { kind: "session", session: mainB() };
          throw new ServerRequestError("request_failed", "会话不存在");
        case "history":
          if (req.session_id === "main-b")
            return {
              kind: "history",
              session: mainB(),
              events: req.before == null ? projectBEvents : [],
              has_more: false,
              needs_earlier: false,
              before: null,
            };
          if (req.session_id === "side-archived-501")
            return {
              kind: "history",
              session: legacySide(),
              events: req.before == null ? sideEvents : [],
              has_more: false,
              needs_earlier: false,
              before: null,
            };
          throw new ServerRequestError("request_failed", "会话不存在");
        case "side_chat_history":
          return { kind: "side_chat_history", sessions: [], next: null };
        case "subagents":
          return { kind: "subagents", tasks: [], truncated: false };
        case "skills":
          return {
            kind: "skills",
            skills: [],
            warnings: [],
            truncated: false,
          };
        case "sources":
          return { kind: "sources", entries: [], truncated: false };
        case "message_queue":
          return {
            kind: "message_queue",
            entries: [],
            paused: false,
            reason: null,
          };
        case "agent_commands":
          return { kind: "agent_commands", commands: [] };
        case "terminals":
          return { kind: "terminals", terminals: [] };
        case "models":
          return {
            kind: "models",
            models: [],
            provider: null,
            default_model: null,
            effort_levels: [],
            model_labels: {},
          };
        case "agent_permissions":
          return { kind: "agent_permissions", modes: [] };
        case "git_info":
          return {
            kind: "git_info",
            info: {
              branch: "main",
              head: null,
              default_base: "main",
              refs: [],
              truncated: false,
            },
          };
        case "open_agent_session":
          return { kind: "ok" };
        case "close_agent_session":
          if (req.session_id === "side-archived-501") {
            sideOpen = false;
            return { kind: "side_chat_closed" };
          }
          return { kind: "ok" };
        case "poll":
          if (req.session_id === "main-b") {
            const slice = projectBEvents.filter((e) => e.seq > req.after);
            return {
              kind: "events",
              session: mainB(),
              events: slice,
              has_more: false,
            };
          }
          if (req.session_id === "side-archived-501") {
            const slice = sideEvents.filter((e) => e.seq > req.after);
            return {
              kind: "events",
              session: legacySide(),
              events: slice,
              has_more: false,
            };
          }
          throw new Error(`unexpected poll: ${req.session_id}`);
        case "undo_turn_changes":
          if (pendingClose || pendingWrite) {
            throw new ServerRequestError(
              "request_failed",
              "具备写权限的侧边聊天（side-archived-501）的写入结束时间待确认，请打开该侧边聊天核对后再撤销修改",
            );
          }
          return {
            kind: "turn_changes",
            changes: { ...projectBChanges, undo: "reverted" },
          };
        case "confirm_agent_closed":
          expect(req.session_id).toBe("side-archived-501");
          expect(req.close_id).toBe("close-archived-1");
          expect(sideOpen).toBe(false);
          pendingClose = undefined;
          return { kind: "session", session: legacySide() };
        case "confirm_side_writes_ended":
          expect(req.session_id).toBe("side-archived-501");
          expect(req.request_id).toBe("side-turn-archived");
          pendingWrite = undefined;
          return { kind: "session", session: legacySide() };
        default:
          throw new Error(`unexpected request: ${JSON.stringify(req)}`);
      }
    },
  );

  render(<App />);

  fireEvent.click(await screen.findByText("项目 B 主对话", {}, UI_TIMEOUT));
  fireEvent.click(
    await screen.findByRole("button", { name: "撤销" }, UI_TIMEOUT),
  );

  const statusTrigger = await screen.findByRole(
    "button",
    { name: /^状态提示（/ },
    UI_TIMEOUT,
  );
  fireEvent.click(statusTrigger);
  fireEvent.click(
    await screen.findByRole("button", { name: "核对侧边聊天" }, UI_TIMEOUT),
  );

  const dialog = await screen.findByRole(
    "dialog",
    { name: /核对侧边聊天/ },
    UI_TIMEOUT,
  );
  expect(dialog.textContent).toContain(
    "旧版 Server 未返回该侧边聊天所属的主会话",
  );
  await waitFor(() => {
    expect(dialog.textContent).toContain("归档主会话侧聊输出完成");
  }, UI_TIMEOUT);
  expect(readWorkspace("main-b").tabs).toEqual([]);

  // Close the managed native agent session before confirming agent_close_pending.
  fireEvent.click(
    await screen.findByRole("button", { name: "关闭原生会话" }, UI_TIMEOUT),
  );
  const confirmCloseBtn = await screen.findByRole<HTMLButtonElement>(
    "button",
    { name: "核对原生会话关闭" },
    UI_TIMEOUT,
  );
  await waitFor(() => expect(confirmCloseBtn.disabled).toBe(false), UI_TIMEOUT);
  fireEvent.click(confirmCloseBtn);
  fireEvent.click(
    await screen.findByRole(
      "button",
      { name: "我已核对，确认结束" },
      UI_TIMEOUT,
    ),
  );

  // Then confirm side_write_pending.
  const confirmWriteBtn = await screen.findByRole<HTMLButtonElement>(
    "button",
    { name: "核对后台写入已结束" },
    UI_TIMEOUT,
  );
  await waitFor(() => expect(confirmWriteBtn.disabled).toBe(false), UI_TIMEOUT);
  fireEvent.click(confirmWriteBtn);
  fireEvent.click(
    await screen.findByRole(
      "button",
      { name: "我已核对，确认结束" },
      UI_TIMEOUT,
    ),
  );

  await screen.findByText(
    "后台写入已确认结束，关闭此窗口后可继续原操作。",
    {},
    UI_TIMEOUT,
  );
  fireEvent.click(screen.getByRole("button", { name: "完成" }));
  await waitFor(
    () =>
      expect(screen.queryByRole("dialog", { name: /核对侧边聊天/ })).toBeNull(),
    UI_TIMEOUT,
  );

  // Still on Project B's conversation — retrying undo now succeeds!
  fireEvent.click(
    await screen.findByRole("button", { name: "撤销" }, UI_TIMEOUT),
  );
  expect(
    await screen.findByRole("button", { name: "已撤销" }, UI_TIMEOUT),
  ).toBeTruthy();
}, 15_000);
