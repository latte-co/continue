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
import { resolveSideChatParentSession } from "./sideChatNavigation";
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
  cleanup();
});

it("navigates from Project B to Project A's owning parent session to confirm a blocking side chat without project mismatch", async () => {
  let pendingWrite: string | undefined = "side-turn-1";
  const parentA = makeSession({
    id: "parent-a",
    project_id: "proj-a",
    title: "项目 A 主对话",
    agent: "codex",
  });
  const sideA = (): Session =>
    makeSession({
      id: "side-a",
      project_id: "proj-a",
      title: "项目 A 侧聊",
      agent: "codex",
      parent_session_id: "parent-a",
      side_write_pending: pendingWrite,
    });
  // Project B uses opencode (which cannot open side chats itself) to verify
  // cross-project navigation is not gated on Project B's side-chat capability.
  const mainB = makeSession({
    id: "main-b",
    project_id: "proj-b",
    title: "项目 B 主对话",
    agent: "opencode",
  });
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
        changes: {
          request_id: "req-b",
          undo: "ready",
          interrupted: false,
          background_pending: false,
          summary: {
            baseline_at: 1,
            added: 2,
            removed: 0,
            binary_files: 0,
            truncated: false,
            unavailable: null,
            entries: [{ path: "b.txt", status: "M", added: 2, removed: 0 }],
          },
        },
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
              { session: mainB, updated_at: 2 },
              { session: parentA, updated_at: 1 },
            ],
            next: null,
          };
        case "sessions":
          return {
            kind: "sessions",
            sessions: req.project_id === "proj-a" ? [parentA] : [mainB],
          };
        case "session":
          if (req.session_id === "side-a")
            return { kind: "session", session: sideA() };
          if (req.session_id === "parent-a")
            return { kind: "session", session: parentA };
          if (req.session_id === "main-b")
            return { kind: "session", session: mainB };
          throw new ServerRequestError("request_failed", "会话不存在");
        case "poll":
          if (req.session_id === "main-b")
            return {
              kind: "events",
              session: mainB,
              events: req.after === 0 ? projectBEvents : [],
              has_more: false,
            };
          if (req.session_id === "parent-a")
            return {
              kind: "events",
              session: parentA,
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
        case "close_agent_session":
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
          throw new ServerRequestError(
            "request_failed",
            "具备写权限的侧边聊天（side-a）的写入结束时间待确认；请先核对后台进程并确认写入已结束",
          );
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
  fireEvent.click(await screen.findByText("项目 B 主对话"));
  const undoButton = await screen.findByRole("button", { name: "撤销" });
  fireEvent.click(undoButton);

  // Status center surfaces the cross-project side-chat recovery action.
  const statusTrigger = await screen.findByRole("button", {
    name: /^状态提示（/,
  });
  fireEvent.click(statusTrigger);
  fireEvent.click(await screen.findByRole("button", { name: "核对侧边聊天" }));

  // Must navigate to Project A's parent session and open side-a there, leaving Project B untouched.
  await waitFor(() => {
    expect(readWorkspace("parent-a").current).toBe("sideChat:side-a");
    expect(readWorkspace("parent-a").visible).toBe(true);
  });
  expect(readWorkspace("main-b").tabs).toEqual([]);

  // SideChat loads side-a under parent-a without "侧边聊天记录不匹配" and shows the write-confirmation notice.
  expect(await screen.findByText("侧聊输出完成")).toBeTruthy();
  expect(screen.queryByText("侧边聊天记录不匹配")).toBeNull();
  expect(await screen.findByText("侧边聊天后台写入待确认。")).toBeTruthy();

  const inspectButton = await screen.findByRole("button", {
    name: "核对后台写入已结束",
  });
  await waitFor(() => expect(inspectButton).toHaveProperty("disabled", false));
  fireEvent.click(inspectButton);

  expect(
    await screen.findByText(
      "请核对侧边聊天启动的后台进程和外部工具均已停止写入工作区。",
    ),
  ).toBeTruthy();
  const confirmButton = await screen.findByRole("button", {
    name: "我已核对，确认结束",
  });
  await waitFor(() => expect(confirmButton).toHaveProperty("disabled", false));
  fireEvent.click(confirmButton);

  await waitFor(() => expect(pendingWrite).toBeUndefined());
});

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
