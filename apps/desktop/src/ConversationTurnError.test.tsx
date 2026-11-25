// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithStatus } from "./test/renderWithStatus";
import { Conversation } from "./Conversation";
import { DraftStore } from "./drafts";
import type { Host } from "./api";
import type { Event, Session } from "./protocol";

const LOCAL_HOST: Host = {
  id: "local",
  name: "本机",
  ssh: null,
  server_path: null,
};

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => ({ request: mocks.request, message: String }));
vi.mock("./useAgentPreferences", () => ({
  useAgentPreferences: () => ({
    model: null,
    effort: null,
    permissionMode: null,
  }),
}));
vi.mock("./ModelPicker", async () => {
  const { useEffect } = await import("react");
  const { modelSelectionScope } = await import("./modelSelectionScope");
  return {
    ModelPicker: (props: {
      hostId: string;
      projectId?: string;
      projectPath?: string;
      agent: string;
      value: null;
      effort: null;
      onReadyChange: (value: { scope: string; ready: boolean }) => void;
    }) => {
      useEffect(
        () =>
          props.onReadyChange({
            scope: modelSelectionScope(
              props.hostId,
              props.projectId,
              props.agent,
              props.value,
              props.effort,
              props.projectPath,
            ),
            ready: true,
          }),
        [
          props.hostId,
          props.projectId,
          props.projectPath,
          props.agent,
          props.value,
          props.effort,
          props.onReadyChange,
        ],
      );
      return null;
    },
  };
});
vi.mock("./PermissionPicker", () => ({ PermissionPicker: () => null }));
vi.mock("./TaskProjectPicker", () => ({ TaskProjectPicker: () => null }));

function baseSession(overrides?: Partial<Session>): Session {
  return {
    id: "s-err",
    project_id: "proj-1",
    title: "PR 评审",
    agent: "claude",
    native_id: null,
    model: null,
    effort: null,
    permission_mode: null,
    status: "failed",
    created_at: 1,
    custom_title: false,
    title_requested: false,
    pinned_at: null,
    unread: false,
    archived: false,
    ...overrides,
  };
}

describe("Conversation TurnErrorRow integration", () => {
  beforeEach(() => {
    mocks.request.mockClear();
    HTMLElement.prototype.scrollTo = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    mocks.request.mockImplementation(async (_, req) =>
      req.method === "message_queue"
        ? { kind: "message_queue", entries: [], paused: false, reason: null }
        : { kind: "files", entries: [] },
    );
  });

  afterEach(() => {
    cleanup();
  });

  it("deduplicates historical synthetic 429 text, offers 继续 on mid-turn failure without wiping unsent Composer draft, and retires action on newer turns", async () => {
    const raw429 =
      "API Error: Request rejected (429) · [1302][您的账户已达到速率限制，请您控制请求频率][20261125162645e418428b3b184a3a]";
    const drafts = new DraftStore();
    drafts.update(JSON.stringify(["local", "s-err"]), {
      text: "并发 3 个 subagent 就行",
    });
    const send = vi.fn().mockResolvedValue(true);

    const midTurnEvents: Event[] = [
      {
        seq: 1,
        session_id: "s-err",
        at: 1000,
        event: { kind: "user", text: "审查整个 PR", request_id: "req-1" },
      },
      {
        seq: 2,
        session_id: "s-err",
        at: 2000,
        event: {
          kind: "tool",
          id: "t1",
          name: "Agent",
          input: { description: "Review storage" },
        },
      },
      {
        seq: 3,
        session_id: "s-err",
        at: 3000,
        event: {
          kind: "tool_result",
          id: "t1",
          content: "ok",
          is_error: false,
        },
      },
      {
        seq: 4,
        session_id: "s-err",
        at: 4000,
        event: { kind: "text", text: raw429 },
      },
      {
        seq: 5,
        session_id: "s-err",
        at: 4100,
        event: { kind: "state", status: "failed", message: raw429 },
      },
    ];

    const view = renderWithStatus(
      <Conversation
        drafts={drafts}
        session={baseSession()}
        hostId="local"
        settingsOpen={false}
        events={midTurnEvents}
        connected
        available
        projectName="latte-code"
        projectId="proj-1"
        projects={[]}
        hosts={[LOCAL_HOST]}
        selectTaskProject={() => {}}
        openProject={() => {}}
        send={send}
        cancel={async () => true}
        approve={async () => {}}
      />,
    );

    expect(
      await screen.findByRole("button", { name: /请求达到速率限制 \(429\)/ }),
    ).toBeTruthy();
    // Synthetic white assistant text is deduplicated and raw codes stay hidden until expanded.
    expect(screen.queryByText(raw429)).toBeNull();

    const continueBtn = screen.getByRole("button", { name: "继续" });
    fireEvent.click(continueBtn);

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith("继续", null, null, null);
    });
    // Unsent Composer draft is preserved intact!
    expect(drafts.get(JSON.stringify(["local", "s-err"])).text).toBe(
      "并发 3 个 subagent 就行",
    );

    // Once a follow-up turn starts, the older turn's recovery button retires automatically.
    view.rerender(
      <Conversation
        drafts={drafts}
        session={baseSession({ status: "running" })}
        hostId="local"
        settingsOpen={false}
        events={[
          ...midTurnEvents,
          {
            seq: 6,
            session_id: "s-err",
            at: 5000,
            event: { kind: "user", text: "继续评审", request_id: "req-2" },
          },
          {
            seq: 7,
            session_id: "s-err",
            at: 5100,
            event: { kind: "state", status: "running", message: null },
          },
        ]}
        connected
        available
        projectName="latte-code"
        projectId="proj-1"
        projects={[]}
        hosts={[LOCAL_HOST]}
        selectTaskProject={() => {}}
        openProject={() => {}}
        send={send}
        cancel={async () => true}
        approve={async () => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "继续" })).toBeNull();
  });

  it("offers 重试 on zero-progress failures and 模型设置 on 401 auth failures", async () => {
    const drafts = new DraftStore();
    const send = vi.fn().mockResolvedValue(true);
    const openModelSettings = vi.fn();

    const view = renderWithStatus(
      <Conversation
        drafts={drafts}
        session={baseSession()}
        hostId="local"
        settingsOpen={false}
        openModelSettings={openModelSettings}
        events={[
          {
            seq: 1,
            session_id: "s-err",
            at: 1000,
            event: { kind: "user", text: "导出评测汇总", request_id: "req-1" },
          },
          {
            seq: 2,
            session_id: "s-err",
            at: 1200,
            event: {
              kind: "state",
              status: "failed",
              message: "API Error: 502 Bad Gateway · upstream timeout",
            },
          },
        ]}
        connected
        available
        projectName="latte-code"
        projectId="proj-1"
        projects={[]}
        hosts={[LOCAL_HOST]}
        selectTaskProject={() => {}}
        openProject={() => {}}
        send={send}
        cancel={async () => true}
        approve={async () => {}}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    await waitFor(() => {
      expect(send).toHaveBeenCalledWith("导出评测汇总", null, null, null);
    });

    view.rerender(
      <Conversation
        drafts={drafts}
        session={baseSession()}
        hostId="local"
        settingsOpen={false}
        openModelSettings={openModelSettings}
        events={[
          {
            seq: 1,
            session_id: "s-err",
            at: 1000,
            event: { kind: "user", text: "导出评测汇总", request_id: "req-1" },
          },
          {
            seq: 2,
            session_id: "s-err",
            at: 1200,
            event: {
              kind: "state",
              status: "failed",
              message: "API Error: 401 Unauthorized · invalid_api_key",
            },
          },
        ]}
        connected
        available
        projectName="latte-code"
        projectId="proj-1"
        projects={[]}
        hosts={[LOCAL_HOST]}
        selectTaskProject={() => {}}
        openProject={() => {}}
        send={send}
        cancel={async () => true}
        approve={async () => {}}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "模型设置" }));
    expect(openModelSettings).toHaveBeenCalledTimes(1);
  });
});
