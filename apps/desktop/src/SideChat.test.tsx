// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { ModelPicker } from "./ModelPicker";
import { modelSelectionScope } from "./modelSelectionScope";
import { DraftStore } from "./drafts";
import { closeSideChat, SideChat, sideDraftKey } from "./SideChat";
import { openSideChatTab, useWorkspaceState } from "./workspaceState";
import type { Event, Request, Session } from "./protocol";
import { ServerRequestError } from "./api";
import { annotationPrompt, userMessageContent } from "./annotations";
import { readWorkspace } from "./workspaceState";

it.each([0, 1])(
  "validates final UTF-8 context before first-side-chat creation (over limit by %s)",
  async (excess) => {
    const drafts = new DraftStore();
    const workspaceId = crypto.randomUUID();
    openSideChatTab(workspaceId, child.id, true);
    const key = sideDraftKey("local", parent.id, child.id);
    const annotation = {
      id: "one",
      quote: "原文",
      comment: "建议",
      source: { message: 2, start: 0, end: 2 },
    };
    const prompt = annotationPrompt("", [annotation]);
    const budget = 128 * 1024 - new TextEncoder().encode(prompt).length - 4;
    const quote =
      "中".repeat(Math.floor(budget / 3)) + "a".repeat((budget % 3) + excess);
    drafts.update(key, { quotes: [quote], annotations: [annotation] });
    request.mockImplementation(async (_host, action: Request) => {
      if (action.method === "agent_permissions")
        return { kind: "agent_permissions", modes: [] };
      if (action.method === "open_side_chat")
        return { kind: "session", session: child };
      if (action.method === "send")
        return { kind: "accepted", duplicate: false };
      if (action.method === "poll")
        return { kind: "events", session: child, events: [], has_more: false };
      throw new Error("unexpected");
    });
    render(
      <ChatTab
        parent={parent}
        sideId={child.id}
        workspaceId={workspaceId}
        hostId="local"
        drafts={drafts}
        active
        connected
        supported
      />,
    );
    const send = screen.getByRole<HTMLButtonElement>("button", {
      name: "发送侧边聊天消息",
    });
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    if (excess) {
      await screen.findByText(
        "消息、引用文本与注释总内容过长，请缩短后再发送。",
      );
      expect(
        request.mock.calls.some(([, cmd]) =>
          ["open_side_chat", "send"].includes(cmd.method),
        ),
      ).toBe(false);
      expect(
        readWorkspace(workspaceId).tabs.find(
          (tab) => tab.id === `sideChat:${child.id}`,
        ),
      ).toMatchObject({ draft: true });
      expect(drafts.get(key)).toMatchObject({
        quotes: [quote],
        annotations: [annotation],
      });
    } else {
      await waitFor(() => expect(drafts.get(key).annotations).toBeUndefined());
      const sent = request.mock.calls.find(
        ([, cmd]) => cmd.method === "send",
      )![1];
      expect(new TextEncoder().encode(sent.text).length).toBe(128 * 1024);
    }
  },
);

it("sends side-chat annotations through its own durable request and retains main drafts", async () => {
  const drafts = new DraftStore();
  const key = sideDraftKey("remote", parent.id, child.id);
  const annotation = {
    id: "one",
    quote: "原文",
    comment: "针对侧聊",
    source: { message: 2, start: 0, end: 2 },
  };
  drafts.update(key, { annotations: [annotation] });
  drafts.update("main", { text: "不要清空" });
  request.mockImplementation(async (_host, action: Request) => {
    if (action.method === "agent_permissions")
      return { kind: "agent_permissions", modes: [] };
    if (action.method === "poll")
      return { kind: "events", session: child, events: [], has_more: false };
    if (action.method === "send") return { kind: "accepted", duplicate: false };
    throw new Error("unexpected");
  });
  render(
    <SideChat
      parent={parent}
      sideId={child.id}
      workspaceId={crypto.randomUUID()}
      hostId="remote"
      drafts={drafts}
      active
      connected
      supported
    />,
  );
  const button = screen.getByRole<HTMLButtonElement>("button", {
    name: "发送侧边聊天消息",
  });
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(drafts.get(key).annotations).toBeUndefined());
  const call = request.mock.calls.find(([, cmd]) => cmd.method === "send")!;
  expect(call[0]).toBe("remote");
  expect(call[1].session_id).toBe(child.id);
  expect(userMessageContent(call[1].text).annotations).toEqual([annotation]);
  expect(drafts.get("main").text).toBe("不要清空");
});

vi.mock("./ModelPicker", async () => {
  const { useEffect } = await import("react");
  return {
    ModelPicker: ({
      hostId,
      projectId,
      projectPath,
      agent,
      settingsOpen,
      preserveUnavailableModel,
      value,
      effort,
      onReadyChange,
      onChange,
      onProviderFallback,
      onEffortChange,
    }: ComponentProps<typeof ModelPicker>) => {
      pickerSpy({
        settingsOpen,
        preserveUnavailableModel,
        value,
        onProviderFallback,
      });
      useEffect(
        () =>
          onReadyChange?.({
            scope: modelSelectionScope(
              hostId,
              projectId,
              agent,
              value,
              effort,
              projectPath,
            ),
            ready: !settingsOpen,
          }),
        [
          hostId,
          projectId,
          projectPath,
          agent,
          settingsOpen,
          value,
          effort,
          onReadyChange,
        ],
      );
      return (
        <>
          <button onClick={() => onChange("chosen-model")}>
            选择侧边聊天模型
          </button>
          <button onClick={() => onEffortChange("high")}>
            选择侧边聊天思考强度
          </button>
        </>
      );
    },
  };
});
const { request, pickerSpy } = vi.hoisted(() => ({
  request: vi.fn(),
  pickerSpy: vi.fn(),
}));
vi.mock("./api", () => ({
  request,
  message: String,
  ServerRequestError: class extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  request.mockReset();
});
const parent = {
  id: "main",
  project_id: "p",
  native_id: "native-main",
  agent: "codex",
  status: "running",
} as Session;
const child = {
  ...parent,
  id: "child",
  native_id: "native-child",
  status: "ready",
} as Session;

type SideChatProps = Omit<ComponentProps<typeof SideChat>, "isDraft">;
function ChatTab(props: SideChatProps) {
  const [workspace] = useWorkspaceState(props.workspaceId);
  const tab = workspace.tabs.find(
    (tab) => tab.id === `sideChat:${props.sideId}`,
  );
  return (
    <SideChat {...props} isDraft={tab?.kind === "sideChat" && tab.draft} />
  );
}

it("opens without sending, reconciles an ambiguous admission and keeps main input independent", async () => {
  const drafts = new DraftStore();
  const workspaceId = crypto.randomUUID();
  openSideChatTab(workspaceId, child.id, true);
  const key = sideDraftKey("local", parent.id, child.id);
  const mainKey = JSON.stringify(["local", parent.id]);
  drafts.update(mainKey, { text: "main draft" });
  drafts.update(key, {
    text: "side question",
    quotes: ["selected detail", "remove me"],
  });
  let received = "";
  let published = false;
  request.mockImplementation(async (_host: string, action: Request) => {
    if (action.method === "agent_permissions")
      return {
        kind: "agent_permissions",
        modes: [
          {
            id: "bypass_permissions",
            label: "完全访问权限",
            elevated: true,
            description: "测试权限",
          },
        ],
      };
    if (action.method === "open_side_chat")
      return { kind: "session", session: child };
    if (action.method === "poll")
      return {
        kind: "events",
        session: child,
        has_more: false,
        events:
          published && received && !action.after
            ? [
                {
                  seq: 1,
                  at: 1,
                  session_id: child.id,
                  event: {
                    kind: "user",
                    text: "side question",
                    request_id: received,
                  },
                },
              ]
            : [],
      };
    if (action.method === "send") {
      received = action.request_id;
      throw new Error("receipt lost");
    }
    throw Error("unexpected request");
  });
  const props = {
    parent,
    workspaceId,
    sideId: child.id,
    hostId: "local",
    drafts,
    active: true,
    connected: true,
    supported: true,
  };
  const view = render(<ChatTab {...props} />);
  const send = screen.getByRole("button", {
    name: "发送侧边聊天消息",
  }) as HTMLButtonElement;
  await waitFor(() => expect(send.disabled).toBe(false));
  expect(received).toBe("");
  expect(screen.queryByText("正在读取记录…")).toBeNull();
  expect(request.mock.calls.map(([, action]) => action.method)).toEqual([
    "agent_permissions",
  ]);
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "侧边聊天输入" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "移除文本片段 2" }));
  fireEvent.click(screen.getByRole("button", { name: "选择侧边聊天模型" }));
  fireEvent.click(
    await screen.findByRole("combobox", { name: "侧边聊天权限" }),
  );
  fireEvent.click(await screen.findByRole("option", { name: /完全访问权限/ }));
  await waitFor(() => expect(send.disabled).toBe(false));
  fireEvent.click(send);
  await screen.findByRole("alert");
  expect(request).toHaveBeenCalledWith(
    "local",
    expect.objectContaining({
      method: "send",
      session_id: "child",
      text: "> selected detail\n\nside question",
      model: "chosen-model",
      permission_mode: "bypass_permissions",
    }),
  );
  expect(drafts.get(key).text).toBe("side question");
  view.rerender(<ChatTab {...props} connected={false} />);
  expect(send.disabled).toBe(true);
  published = true;
  view.rerender(<ChatTab {...props} />);
  await waitFor(() => expect(drafts.get(key).text).toBe(""));
  expect(
    request.mock.calls.filter(([, cmd]) => cmd.method === "send"),
  ).toHaveLength(1);
  expect(drafts.get(mainKey).text).toBe("main draft");
});

it.each(["admission_unknown", "request_failed"])(
  "keeps the same request ID after an ambiguous server %s receipt",
  async (code) => {
    const drafts = new DraftStore();
    const key = sideDraftKey("local", parent.id, child.id);
    drafts.update(key, { text: "execute once" });
    let attempts = 0;
    request.mockImplementation(async (_host, action: Request) => {
      if (action.method === "agent_permissions")
        return { kind: "agent_permissions", modes: [] };
      if (action.method === "poll")
        return { kind: "events", session: child, events: [], has_more: false };
      if (action.method === "send") {
        attempts++;
        if (attempts === 1)
          throw new ServerRequestError(code, "会话接收超时，请核对请求状态");
        return { kind: "accepted", duplicate: true };
      }
      throw new Error("unexpected request");
    });
    render(
      <SideChat
        parent={parent}
        sideId={child.id}
        workspaceId={crypto.randomUUID()}
        hostId="local"
        drafts={drafts}
        active
        connected
        supported
      />,
    );
    const send = () =>
      screen.getByRole<HTMLButtonElement>("button", {
        name: "发送侧边聊天消息",
      });
    await waitFor(() => expect(send().disabled).toBe(false));
    fireEvent.click(send());
    await screen.findByRole("alert");
    await waitFor(() => expect(send().disabled).toBe(false));
    expect(drafts.get(key).text).toBe("execute once");
    fireEvent.click(send());
    await waitFor(() => expect(drafts.get(key).text).toBe(""));
    const sends = request.mock.calls
      .map(([, action]) => action)
      .filter((action) => action.method === "send");
    expect(sends).toHaveLength(2);
    expect(sends[1].request_id).toBe(sends[0].request_id);
  },
);

it("stops only the side turn and never reads a hidden tab", async () => {
  const drafts = new DraftStore();
  request.mockImplementation(async (_host: string, action: Request) => {
    if (action.method === "open_side_chat")
      return { kind: "session", session: child };
    if (action.method === "poll")
      return {
        kind: "events",
        session: { ...child, status: "running" },
        events: [],
        has_more: false,
      };
    return { kind: "ok" };
  });
  const props = {
    parent,
    workspaceId: crypto.randomUUID(),
    sideId: child.id,
    hostId: "ssh",
    drafts,
    active: false,
    connected: true,
    supported: true,
  };
  const view = render(<SideChat {...props} />);
  expect(request).not.toHaveBeenCalled();
  view.rerender(<SideChat {...props} active />);
  fireEvent.click(await screen.findByRole("button", { name: "停止侧边聊天" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("ssh", {
      method: "cancel",
      session_id: "child",
    }),
  );
  expect(request).not.toHaveBeenCalledWith("ssh", {
    method: "cancel",
    session_id: "main",
  });
});

it("inherits parent permission mode on new draft side chats while keeping legacy read-only side chats read-only", async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const drafts = new DraftStore();
  const workspaceId = crypto.randomUUID();
  const key = sideDraftKey("local", parent.id, child.id);
  drafts.update(key, { text: "keep this draft" });
  request.mockImplementation(async (_host: string, action: Request) => {
    if (action.method === "agent_permissions")
      return {
        kind: "agent_permissions",
        modes: [
          {
            id: "bypass_permissions",
            label: "完全访问权限",
            elevated: true,
            description: "测试权限",
          },
        ],
      };
    if (action.method === "open_side_chat")
      return {
        kind: "session",
        session: { ...child, id: action.side_id, permission_mode: "inherit" },
      };
    if (action.method === "send") return { kind: "accepted" };
    if (action.method === "poll")
      return {
        kind: "events",
        session: { ...child, permission_mode: null },
        events: [],
        has_more: false,
      };
    throw new Error("unexpected request");
  });
  const elevatedDraftId = "draft-elevated";
  openSideChatTab(workspaceId, elevatedDraftId, true);
  const draftView = render(
    <ChatTab
      parent={{ ...parent, permission_mode: "bypass_permissions" }}
      workspaceId={workspaceId}
      sideId={elevatedDraftId}
      hostId="local"
      drafts={drafts}
      active
      connected
      supported
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "侧边聊天权限" }).textContent,
    ).toContain("完全访问权限"),
  );
  draftView.unmount();

  const inheritDraftId = "draft-inherit";
  openSideChatTab(workspaceId, inheritDraftId, true);
  drafts.update(sideDraftKey("local", parent.id, inheritDraftId), {
    text: "align with main",
  });
  const inheritView = render(
    <ChatTab
      parent={{ ...parent, permission_mode: null }}
      workspaceId={workspaceId}
      sideId={inheritDraftId}
      hostId="local"
      drafts={drafts}
      active
      connected
      supported
    />,
  );
  const inheritSend = screen.getByRole<HTMLButtonElement>("button", {
    name: "发送侧边聊天消息",
  });
  await waitFor(() => expect(inheritSend.disabled).toBe(false));
  expect(
    screen.getByRole("combobox", { name: "侧边聊天权限" }).textContent,
  ).toContain("跟随 Agent");
  fireEvent.click(inheritSend);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "local",
      expect.objectContaining({
        method: "send",
        session_id: inheritDraftId,
        text: "align with main",
        permission_mode: "inherit",
      }),
    ),
  );
  inheritView.unmount();

  const props = {
    parent: { ...parent, permission_mode: "bypass_permissions" },
    workspaceId,
    sideId: child.id,
    hostId: "local",
    drafts,
    active: true,
    connected: true,
    supported: true,
  };
  // Historical read-only side chats stored permission_mode: null and must stay
  // read-only on restore even when the parent session has write permissions.
  const view = render(<SideChat {...props} />);
  const send = () =>
    screen.getByRole<HTMLButtonElement>("button", { name: "发送侧边聊天消息" });
  await waitFor(() => expect(send().disabled).toBe(false));
  expect(
    screen.getByRole("combobox", { name: "侧边聊天权限" }).textContent,
  ).toContain("只读");
  fireEvent.click(screen.getByRole("button", { name: "选择侧边聊天模型" }));
  fireEvent.click(screen.getByRole("button", { name: "选择侧边聊天思考强度" }));
  view.rerender(<div>另一主会话</div>);
  view.rerender(<SideChat {...props} />);
  await waitFor(() => expect(send().disabled).toBe(false));
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", { name: "侧边聊天输入" })
      .value,
  ).toBe("keep this draft");
  expect(
    screen.getByRole("combobox", { name: "侧边聊天权限" }).textContent,
  ).toContain("只读");
  fireEvent.click(send());
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "local",
      expect.objectContaining({
        method: "send",
        session_id: child.id,
        text: "keep this draft",
        permission_mode: null,
        model: "chosen-model",
        effort: "high",
      }),
    ),
  );
});

it("waits for an existing side chat session before activating ModelPicker and preserves its model", async () => {
  const drafts = new DraftStore();
  let resolvePoll: ((value: unknown) => void) | undefined;
  request.mockImplementation((_host: string, action: Request) => {
    if (action.method === "agent_permissions")
      return Promise.resolve({ kind: "agent_permissions", modes: [] });
    if (action.method === "poll")
      return new Promise((resolve) => {
        resolvePoll = resolve;
      });
    throw new Error("unexpected request");
  });
  pickerSpy.mockClear();
  render(
    <SideChat
      parent={{ ...parent, model: "parent-model" }}
      sideId={child.id}
      workspaceId={crypto.randomUUID()}
      hostId="local"
      drafts={drafts}
      active
      connected
      supported
    />,
  );
  expect(pickerSpy).toHaveBeenLastCalledWith(
    expect.objectContaining({
      settingsOpen: true,
      preserveUnavailableModel: true,
    }),
  );
  await waitFor(() => expect(resolvePoll).toBeTypeOf("function"));
  resolvePoll?.({
    kind: "events",
    session: { ...child, model: "side-model" },
    events: [],
    has_more: false,
  });
  await waitFor(() =>
    expect(pickerSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        settingsOpen: false,
        preserveUnavailableModel: true,
        value: "side-model",
      }),
    ),
  );
});

it("closes an unsent draft locally and waits for the first send before closing the child session", async () => {
  const drafts = new DraftStore();
  const workspaceId = crypto.randomUUID();
  const tabId = `sideChat:${child.id}`;
  const close = () =>
    closeSideChat(drafts, "local", parent.id, workspaceId, tabId);
  openSideChatTab(workspaceId, child.id, true);
  await close();
  expect(request).not.toHaveBeenCalled();

  const props = {
    parent,
    workspaceId,
    sideId: child.id,
    hostId: "local",
    drafts,
    active: true,
    connected: true,
    supported: true,
  };
  let finishCreation!: (value: unknown) => void;
  const creation = new Promise((resolve) => {
    finishCreation = resolve;
  });
  request.mockImplementation(async (_host, action: Request) => {
    if (action.method === "agent_permissions")
      return { kind: "agent_permissions", modes: [] };
    if (action.method === "open_side_chat") return creation;
    if (action.method === "send") return { kind: "accepted" };
    if (action.method === "poll")
      return { kind: "events", session: child, events: [], has_more: false };
    return { kind: "ok" };
  });
  drafts.update(sideDraftKey("local", parent.id, child.id), { text: "first" });
  render(<ChatTab {...props} />);
  const send = screen.getByRole("button", {
    name: "发送侧边聊天消息",
  }) as HTMLButtonElement;
  await waitFor(() => expect(send.disabled).toBe(false));
  fireEvent.click(send);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("local", {
      method: "open_side_chat",
      session_id: parent.id,
      side_id: child.id,
    }),
  );
  const closing = close();
  expect(
    request.mock.calls.some(
      ([, action]) => action.method === "close_agent_session",
    ),
  ).toBe(false);
  finishCreation({ kind: "session", session: child });
  await closing;
  expect(
    request.mock.calls
      .map(([, action]) => action.method)
      .filter((method) => method !== "poll"),
  ).toEqual([
    "agent_permissions",
    "open_side_chat",
    "send",
    "close_agent_session",
  ]);
  expect(request).toHaveBeenCalledWith("local", {
    method: "close_agent_session",
    session_id: child.id,
    only_if_idle: false,
  });
});

it.each(["ok", "side_chat_closed"] as const)(
  "closes a side chat cleanly with %s response and confirms unverified native agent close after reopening",
  async (closeResponseKind) => {
    const drafts = new DraftStore();
    const workspaceId = crypto.randomUUID();
    openSideChatTab(workspaceId, child.id, false);
    let closePending: string | undefined = "close-1";
    request.mockImplementation(async (_host: string, action: Request) => {
      if (action.method === "close_agent_session")
        return { kind: closeResponseKind };
      if (action.method === "confirm_agent_closed") {
        closePending = undefined;
        return {
          kind: "session",
          session: child,
        };
      }
      if (action.method === "poll")
        return {
          kind: "events",
          session: {
            ...child,
            agent_close_pending: closePending,
            agent_session_open: false,
          },
          events: [],
          has_more: false,
        };
      return { kind: "agent_permissions", modes: [] };
    });
    await expect(
      closeSideChat(
        drafts,
        "local",
        parent.id,
        workspaceId,
        `sideChat:${child.id}`,
      ),
    ).resolves.toBeUndefined();
    render(
      <SideChat
        parent={parent}
        workspaceId={workspaceId}
        sideId={child.id}
        hostId="local"
        drafts={drafts}
        active
        connected
        supported
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "核对原生会话关闭" }),
    );
    expect(
      request.mock.calls.some(
        ([, action]) => action.method === "confirm_agent_closed",
      ),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "我已核对，确认结束" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("local", {
        method: "confirm_agent_closed",
        session_id: child.id,
        close_id: "close-1",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText(/原生会话的关闭状态待确认/)).toBeNull(),
    );
    expect(
      request.mock.calls.filter(
        ([, action]) => action.method === "close_agent_session",
      ),
    ).toHaveLength(1);
  },
);

it("falls back to legacy read-only permission on older SSH Servers that do not advertise inherit", async () => {
  const drafts = new DraftStore();
  const workspaceId = crypto.randomUUID();
  const legacyDraftId = "draft-legacy-server";
  openSideChatTab(workspaceId, legacyDraftId, true);
  drafts.update(sideDraftKey("legacy-ssh", parent.id, legacyDraftId), {
    text: "run on old v1 server",
  });
  request.mockImplementation(async (_host: string, action: Request) => {
    if (action.method === "agent_permissions")
      return { kind: "agent_permissions", modes: [] };
    if (action.method === "open_side_chat")
      return {
        kind: "session",
        session: { ...child, id: action.side_id, permission_mode: null },
      };
    if (action.method === "send") return { kind: "accepted" };
    if (action.method === "poll")
      return {
        kind: "events",
        session: { ...child, id: legacyDraftId, permission_mode: null },
        events: [],
        has_more: false,
      };
    throw new Error("unexpected request");
  });
  render(
    <ChatTab
      parent={{ ...parent, permission_mode: null }}
      workspaceId={workspaceId}
      sideId={legacyDraftId}
      hostId="legacy-ssh"
      drafts={drafts}
      active
      connected
      supported
      supportsInheritPermission={false}
    />,
  );
  const send = screen.getByRole<HTMLButtonElement>("button", {
    name: "发送侧边聊天消息",
  });
  await waitFor(() => expect(send.disabled).toBe(false));
  expect(
    screen.getByRole("combobox", { name: "侧边聊天权限" }).textContent,
  ).toContain("只读");
  fireEvent.click(send);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "legacy-ssh",
      expect.objectContaining({
        method: "send",
        session_id: legacyDraftId,
        text: "run on old v1 server",
        permission_mode: null,
      }),
    ),
  );
});

it("keeps ordinary completed writable side chats banner-free until undo conflict or unknown status requires confirmation", async () => {
  const { requestSideWriteConfirmation } = await import("./sideWritePrompts");
  const drafts = new DraftStore();
  const workspaceId = crypto.randomUUID();
  let sideWritePending: string | undefined = "write-1";
  request.mockImplementation(async (_host: string, action: Request) => {
    if (action.method === "confirm_side_writes_ended") {
      sideWritePending = undefined;
      return {
        kind: "session",
        session: { ...child, status: "completed", permission_mode: "inherit" },
      };
    }
    if (action.method === "poll")
      return {
        kind: "events",
        session: {
          ...child,
          status: "completed",
          permission_mode: "inherit",
          side_write_pending: sideWritePending,
        },
        events: [],
        has_more: false,
      };
    return { kind: "agent_permissions", modes: [] };
  });
  render(
    <SideChat
      parent={parent}
      workspaceId={workspaceId}
      sideId={child.id}
      hostId="local"
      drafts={drafts}
      active
      connected
      supported
    />,
  );
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "local",
      expect.objectContaining({ method: "poll" }),
    ),
  );
  expect(screen.queryByText(/侧边聊天后台写入待确认/)).toBeNull();

  // When main-turn undo hits an unconfirmed side-write interval, the confirmation bar appears on demand.
  requestSideWriteConfirmation("local", child.id);
  fireEvent.click(
    await screen.findByRole("button", { name: "核对后台写入已结束" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "我已核对，确认结束" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("local", {
      method: "confirm_side_writes_ended",
      session_id: child.id,
      request_id: "write-1",
    }),
  );
  await waitFor(() =>
    expect(screen.queryByText(/侧边聊天后台写入待确认/)).toBeNull(),
  );
});

it("caches loaded side-chat messages across hide/remount, polls incrementally, and invalidates when serverId changes", async () => {
  const drafts = new DraftStore();
  const workspaceId = crypto.randomUUID();
  const allEvents = [
    {
      seq: 1,
      at: 1,
      session_id: child.id,
      event: { kind: "user" as const, text: "第一问", request_id: "r1" },
    },
    {
      seq: 2,
      at: 2,
      session_id: child.id,
      event: { kind: "text" as const, text: "已缓存的侧聊回复" },
    },
  ];
  let liveEvents = [...allEvents];
  const pollCursors: number[] = [];
  request.mockImplementation(async (_host: string, action: Request) => {
    if (action.method === "agent_permissions")
      return { kind: "agent_permissions", modes: [] };
    if (action.method === "poll") {
      pollCursors.push(action.after);
      return {
        kind: "events",
        session: { ...child, status: "completed" },
        events: liveEvents.filter((entry) => entry.seq > action.after),
        has_more: false,
      };
    }
    throw new Error("unexpected request");
  });
  const baseProps = {
    parent,
    workspaceId,
    sideId: child.id,
    hostId: "local",
    serverId: "server-1",
    drafts,
    active: true,
    connected: true,
    supported: true,
  };
  const view = render(<SideChat {...baseProps} />);
  await screen.findByText("已缓存的侧聊回复");
  expect(pollCursors).toEqual([0]);

  // Hide and re-open panel while mounted: retains ready state and polls after seq 2.
  view.rerender(<SideChat {...baseProps} active={false} />);
  liveEvents = [
    ...allEvents,
    {
      seq: 3,
      at: 3,
      session_id: child.id,
      event: { kind: "text" as const, text: "\n\n增量新增回复" },
    },
  ];
  view.rerender(<SideChat {...baseProps} active />);
  expect(screen.queryByText("正在读取记录…")).toBeNull();
  expect(screen.getByText("已缓存的侧聊回复")).toBeTruthy();
  await screen.findByText("增量新增回复");
  expect(pollCursors.at(-1)).toBe(2);

  // Switch away to another main conversation (unmount) and remount: restores from cache immediately.
  view.unmount();
  const remounted = render(<SideChat {...baseProps} />);
  expect(screen.queryByText("正在读取记录…")).toBeNull();
  expect(screen.getByText("已缓存的侧聊回复")).toBeTruthy();
  expect(screen.getByText("增量新增回复")).toBeTruthy();
  await waitFor(() => expect(pollCursors.at(-1)).toBe(3));

  // Daemon replacement (serverId change) invalidates that host's cache and reloads from 0.
  remounted.rerender(<SideChat {...baseProps} serverId="server-2" />);
  await waitFor(() => expect(pollCursors.at(-1)).toBe(0));
  await screen.findByText("增量新增回复");
});

it("shows return-to-latest when scrolled up, preserves reading position across updates and remounts, and resets on close", async () => {
  const drafts = new DraftStore();
  const workspaceId = crypto.randomUUID();
  openSideChatTab(workspaceId, child.id, false);
  let seq = 2;
  const events = [
    {
      seq: 1,
      at: 1,
      session_id: child.id,
      event: { kind: "user" as const, text: "问题", request_id: "r1" },
    },
    {
      seq: 2,
      at: 2,
      session_id: child.id,
      event: { kind: "text" as const, text: "第一段回答" },
    },
  ];
  request.mockImplementation(async (_host: string, action: Request) => {
    if (action.method === "agent_permissions")
      return { kind: "agent_permissions", modes: [] };
    if (action.method === "close_agent_session") return { kind: "ok" };
    if (action.method === "poll")
      return {
        kind: "events",
        session: { ...child, status: "running" },
        events: events.filter((entry) => entry.seq > action.after),
        has_more: false,
      };
    throw new Error("unexpected request");
  });
  const props = {
    parent,
    workspaceId,
    sideId: child.id,
    hostId: "local",
    drafts,
    active: true,
    connected: true,
    supported: true,
  };
  const view = render(<SideChat {...props} />);
  await screen.findByText("第一段回答");
  const transcript = document.querySelector(
    ".side-chat-transcript",
  ) as HTMLDivElement;
  Object.defineProperties(transcript, {
    clientHeight: { value: 300, configurable: true },
    scrollHeight: { value: 1500, configurable: true },
    scrollTop: { value: 120, writable: true, configurable: true },
  });
  transcript.scrollTo = vi.fn();
  fireEvent.scroll(transcript);
  expect(screen.getByRole("button", { name: "回到最新" })).toBeTruthy();

  // Incoming output does not yank scroll while reading earlier messages.
  events.push({
    seq: ++seq,
    at: 3,
    session_id: child.id,
    event: { kind: "text" as const, text: "\n\n第二段回答" },
  });
  view.rerender(<SideChat {...props} active={false} />);
  view.rerender(<SideChat {...props} active />);
  await screen.findByText("第二段回答");
  expect(transcript.scrollTop).toBe(120);
  expect(screen.getByRole("button", { name: "回到最新" })).toBeTruthy();

  // Unmount and remount preserves scrolled-up position and button.
  view.unmount();
  const remount = render(<SideChat {...props} />);
  const nextTranscript = document.querySelector(
    ".side-chat-transcript",
  ) as HTMLDivElement;
  Object.defineProperties(nextTranscript, {
    clientHeight: { value: 300, configurable: true },
    scrollHeight: { value: 1500, configurable: true },
  });
  nextTranscript.scrollTo = vi.fn();
  expect(nextTranscript.scrollTop).toBe(120);
  fireEvent.click(screen.getByRole("button", { name: "回到最新" }));
  expect(nextTranscript.scrollTop).toBe(1500);
  expect(nextTranscript.scrollTo).toHaveBeenCalledWith({ top: 1500 });
  expect(screen.queryByRole("button", { name: "回到最新" })).toBeNull();

  // Scroll up again, then explicitly close the tab: reopening starts following latest.
  nextTranscript.scrollTop = 80;
  fireEvent.scroll(nextTranscript);
  expect(screen.getByRole("button", { name: "回到最新" })).toBeTruthy();
  remount.unmount();
  await closeSideChat(
    drafts,
    "local",
    parent.id,
    workspaceId,
    `sideChat:${child.id}`,
  );
  openSideChatTab(workspaceId, child.id, false);
  render(<SideChat {...props} />);
  expect(screen.queryByRole("button", { name: "回到最新" })).toBeNull();
});

it("keeps default tab title while first turn runs and updates tab title after first turn completes", async () => {
  const drafts = new DraftStore();
  const workspaceId = crypto.randomUUID();
  openSideChatTab(workspaceId, child.id, false);
  let currentSession: Session = {
    ...child,
    title: "侧聊首条问题原始前缀",
    status: "running",
    title_requested: false,
    custom_title: false,
  };
  let currentEvents: Event[] = [
    {
      seq: 1,
      at: 1,
      session_id: child.id,
      event: {
        kind: "user",
        text: "侧聊首条问题原始前缀",
        request_id: "r1",
      },
    },
  ];
  request.mockImplementation(async (_host: string, action: Request) => {
    if (action.method === "agent_permissions")
      return { kind: "agent_permissions", modes: [] };
    if (action.method === "poll")
      return {
        kind: "events",
        session: currentSession,
        events: currentEvents.filter((entry) => entry.seq > action.after),
        has_more: false,
      };
    throw new Error("unexpected request");
  });
  const props = {
    parent,
    workspaceId,
    sideId: child.id,
    hostId: "local",
    drafts,
    active: true,
    connected: true,
    supported: true,
  };
  const view = render(<SideChat {...props} />);
  await screen.findByText("侧聊首条问题原始前缀");
  expect(
    readWorkspace(workspaceId).tabs.find(
      (tab) => tab.id === `sideChat:${child.id}`,
    ),
  ).not.toHaveProperty("title");

  // First turn completes and generated title arrives -> tab title updates immediately.
  currentSession = {
    ...currentSession,
    title: "排查侧聊重复加载",
    status: "completed",
    title_requested: true,
  };
  currentEvents = [
    ...currentEvents,
    {
      seq: 2,
      at: 2,
      session_id: child.id,
      event: {
        kind: "state" as const,
        status: "completed" as const,
        message: null,
      },
    },
  ];
  view.rerender(<SideChat {...props} active={false} />);
  view.rerender(<SideChat {...props} active />);
  await waitFor(() =>
    expect(
      readWorkspace(workspaceId).tabs.find(
        (tab) => tab.id === `sideChat:${child.id}`,
      ),
    ).toMatchObject({ title: "排查侧聊重复加载" }),
  );
});

it("falls back to the prompt prefix when automatic naming fails after the first turn completes", async () => {
  const drafts = new DraftStore();
  const workspaceId = crypto.randomUUID();
  openSideChatTab(workspaceId, child.id, false);
  request.mockImplementation(async (_host: string, action: Request) => {
    if (action.method === "agent_permissions")
      return { kind: "agent_permissions", modes: [] };
    if (action.method === "poll")
      return {
        kind: "events",
        session: {
          ...child,
          title: "为什么侧聊切回会重新加载",
          status: "completed",
          title_requested: true,
          custom_title: false,
        },
        events: [
          {
            seq: 1,
            at: 1,
            session_id: child.id,
            event: {
              kind: "user" as const,
              text: "> 引用片段\n\n为什么侧聊切回会重新加载",
              request_id: "r1",
            },
          },
          {
            seq: 2,
            at: 2,
            session_id: child.id,
            event: {
              kind: "notice" as const,
              text: "会话自动命名未完成，保留原名称：unsupported",
            },
          },
          {
            seq: 3,
            at: 3,
            session_id: child.id,
            event: {
              kind: "state" as const,
              status: "completed" as const,
              message: null,
            },
          },
        ].filter((entry) => entry.seq > action.after),
        has_more: false,
      };
    throw new Error("unexpected request");
  });
  render(
    <SideChat
      parent={parent}
      workspaceId={workspaceId}
      sideId={child.id}
      hostId="local"
      drafts={drafts}
      active
      connected
      supported
    />,
  );
  await waitFor(() =>
    expect(
      readWorkspace(workspaceId).tabs.find(
        (tab) => tab.id === `sideChat:${child.id}`,
      ),
    ).toMatchObject({ title: "为什么侧聊切回会重新加载" }),
  );
});

function createSideChatReviewFixture() {
  const drafts = new DraftStore();
  const workspaceId = crypto.randomUUID();
  const sideId = crypto.randomUUID();
  openSideChatTab(workspaceId, sideId, false);
  const props = {
    parent,
    sideId,
    workspaceId,
    hostId: "local",
    serverId: "server-a",
    drafts,
    active: true,
    connected: true,
    supported: true,
  };
  const readTabTitle = () => {
    const tab = readWorkspace(workspaceId).tabs.find(
      (entry) => entry.id === `sideChat:${sideId}`,
    );
    return tab?.kind === "sideChat" ? tab.title : undefined;
  };
  const question = "侧聊评审回归问题";
  const state = {
    session: {
      ...child,
      id: sideId,
      status: "completed",
      title: question,
      title_requested: true,
      agent_session_open: true,
      custom_title: false,
    } as Session,
    events: [
      {
        seq: 1,
        at: 1,
        session_id: sideId,
        event: { kind: "user", text: question, request_id: "q" },
      },
    ] as Event[],
  };
  const cursors: number[] = [];
  request.mockImplementation(async (_host: string, action: Request) => {
    if (action.method === "poll") {
      cursors.push(action.after);
      return {
        kind: "events",
        session: { ...state.session },
        events: state.events.filter((entry) => entry.seq > action.after),
        has_more: false,
      };
    }
    return { kind: "agent_permissions", modes: [] };
  });
  return { props, readTabTitle, state, cursors, question };
}

it("preserves an undo-triggered write confirmation on cold mount from cached state", async () => {
  const { props, state, question } = createSideChatReviewFixture();
  const { clearSideWriteConfirmation, requestSideWriteConfirmation } =
    await import("./sideWritePrompts");
  try {
    const initialView = render(<SideChat {...props} />);
    await screen.findByText(question);
    initialView.unmount();

    state.session = {
      ...state.session,
      side_write_pending: "new-pending-write",
    };
    requestSideWriteConfirmation("local", props.sideId);
    render(<SideChat {...props} />);
    expect(
      await screen.findByRole("button", { name: "核对后台写入已结束" }),
    ).toBeTruthy();
  } finally {
    clearSideWriteConfirmation("local", props.sideId);
  }
});

it("reloads from seq 0 if cached events were mounted while disconnected before a new server handshake", async () => {
  const { props, state, question, cursors } = createSideChatReviewFixture();
  const initialView = render(<SideChat {...props} />);
  await screen.findByText(question);
  initialView.unmount();

  const offlineView = render(
    <SideChat {...props} serverId="" connected={false} supported={false} />,
  );
  state.events = [
    {
      seq: 1,
      at: 1,
      session_id: props.sideId,
      event: {
        kind: "user",
        text: "replacement history",
        request_id: "new",
      },
    },
  ];
  offlineView.rerender(<SideChat {...props} serverId="server-b" />);
  await waitFor(() => expect(cursors.length).toBeGreaterThan(1));
  expect(cursors[1]).toBe(0);
  expect(await screen.findByText("replacement history")).toBeTruthy();
});

it("falls back to prompt prefix after settle window even while live polling continues", async () => {
  const { props, question, readTabTitle } = createSideChatReviewFixture();
  render(<SideChat {...props} />);
  await screen.findByText(question);
  await waitFor(() => expect(readTabTitle()).toBe(question), {
    timeout: 3250,
  });
});

it("publishes a generated first-turn title when the user switches to a sibling workspace tab", async () => {
  const { props, state, readTabTitle, question } =
    createSideChatReviewFixture();
  state.session = {
    ...state.session,
    status: "running",
    title_requested: false,
  };
  const view = render(<SideChat {...props} />);
  await screen.findByText(question);
  view.rerender(<SideChat {...props} active={false} />);
  state.session = {
    ...state.session,
    status: "completed",
    title_requested: true,
    title: "finished in background",
  };
  await waitFor(() => expect(readTabTitle()).toBe("finished in background"), {
    timeout: 2650,
  });
});

it("reuses cached transcript byte size on status-only polls without re-serializing events", async () => {
  const { props, question, cursors } = createSideChatReviewFixture();
  const originalStringify = JSON.stringify;
  let serializations = 0;
  const spy = vi.spyOn(JSON, "stringify").mockImplementation(function (
    value,
    ...rest
  ) {
    if (
      Array.isArray(value) &&
      typeof value[0] === "object" &&
      value[0] !== null &&
      (value[0] as Event).event?.kind === "user" &&
      ((value[0] as Event).event as { text?: string }).text === question
    ) {
      serializations += 1;
    }
    return originalStringify(
      value,
      ...(rest as [
        ((this: unknown, key: string, value: unknown) => unknown)?,
        (string | number)?,
      ]),
    );
  });
  try {
    render(<SideChat {...props} />);
    await screen.findByText(question);
    const initialCount = serializations;
    await waitFor(() => expect(cursors.length).toBeGreaterThan(2), {
      timeout: 2200,
    });
    expect(serializations).toBe(initialCount);
  } finally {
    spy.mockRestore();
  }
});

it("restores saved scroll position after the transcript cache entry has been evicted", async () => {
  const { props } = createSideChatReviewFixture();
  const offsets = new WeakMap<Element, number>();
  // jsdom has no layout engine; model native scrollTop clamping against loaded content height.
  const maxTop = (el: HTMLElement) =>
    el.textContent?.includes("loaded-page") ? 1200 : 0;
  const beforeTop = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollTop",
  );
  const beforeHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );
  const beforeClient = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientHeight",
  );
  Object.defineProperties(HTMLElement.prototype, {
    scrollTop: {
      configurable: true,
      get(this: HTMLElement) {
        return offsets.get(this) ?? 0;
      },
      set(this: HTMLElement, value: number) {
        offsets.set(this, Math.max(0, Math.min(value, maxTop(this))));
      },
    },
    clientHeight: {
      configurable: true,
      get() {
        return 300;
      },
    },
    scrollHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return 300 + maxTop(this);
      },
    },
  });
  try {
    request.mockImplementation(async (_host: string, action: Request) => {
      if (action.method !== "poll")
        return { kind: "agent_permissions", modes: [] };
      const session = {
        ...child,
        id: action.session_id,
        status: "completed" as const,
      };
      return {
        kind: "events",
        session,
        events: action.after
          ? []
          : [
              {
                seq: 1,
                at: 1,
                session_id: session.id,
                event: {
                  kind: "user" as const,
                  text: `loaded-page ${session.id}`,
                  request_id: "r",
                },
              },
            ],
        has_more: false,
      };
    });
    const element = () =>
      document.querySelector<HTMLElement>(".side-chat-transcript")!;
    let view = render(<SideChat {...props} />);
    await screen.findByText(`loaded-page ${props.sideId}`);
    element().scrollTop = 500;
    fireEvent.scroll(element());
    view.unmount();

    for (let i = 0; i < 24; i += 1) {
      const other = crypto.randomUUID();
      view = render(<SideChat {...props} sideId={other} />);
      await screen.findByText(`loaded-page ${other}`);
      view.unmount();
    }

    view = render(<SideChat {...props} />);
    await screen.findByText(`loaded-page ${props.sideId}`);
    expect(element().scrollTop).toBe(500);
  } finally {
    for (const [prop, descriptor] of Object.entries({
      scrollTop: beforeTop,
      scrollHeight: beforeHeight,
      clientHeight: beforeClient,
    })) {
      if (descriptor) {
        Object.defineProperty(HTMLElement.prototype, prop, descriptor);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, prop);
      }
    }
  }
});
