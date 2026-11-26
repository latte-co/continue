// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { AgentSettings } from "./AgentSettings";
import type { Workbench } from "./useWorkbench";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const host = {
  id: "env-devbox",
  name: "Env Devbox",
  ssh: "env-devbox",
  server_path: null,
};
const state = { host, hosts: [host] } as Workbench;

function setup(supported = true) {
  let saved = { claude: { HTTPS_PROXY: "http://saved.test:7890" } };
  invoke.mockImplementation(async (command, args) => {
    if (command === "connect_host")
      return {
        kind: "hello",
        server_id: "env-server",
        custom_agent_environment: supported,
        agents: [
          {
            id: "claude",
            name: "Claude Code",
            detail: "Fixture",
            provider_protocols: ["anthropic_messages"],
          },
          {
            id: "codex",
            name: "Codex",
            detail: "Fixture",
            provider_protocols: ["openai_responses"],
          },
        ],
      };
    if (command === "agent_providers")
      return { kind: "providers", providers: [], bindings: [] };
    if (command === "agent_environments")
      return args.hostId === host.id ? saved : {};
    if (command === "save_agent_environment") {
      saved = { ...saved, [args.agent]: args.environment };
      return args.environment;
    }
    throw new Error("Unexpected native command");
  });
}

function saveButton() {
  return screen.getByRole("button", { name: "保存" }) as HTMLButtonElement;
}

it("starts as a collapsed summary list, saves literal ENV via subview, and restores after reopening", async () => {
  setup();
  const onBusy = vi.fn();
  const view = render(<AgentSettings state={state} active onBusy={onBusy} />);

  await screen.findByRole("button", {
    name: "编辑 Claude Code",
  });
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByText("ENV · 1")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "编辑 Codex" }));
  expect(
    (screen.getByLabelText("Codex 环境变量") as HTMLTextAreaElement).value,
  ).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "连接与 Agent" }));

  fireEvent.click(screen.getByRole("button", { name: "编辑 Claude Code" }));
  const field = screen.getByLabelText(
    "Claude Code 环境变量",
  ) as HTMLTextAreaElement;
  expect(field.value).toBe("HTTPS_PROXY=http://saved.test:7890");
  expect(saveButton().disabled).toBe(true);

  fireEvent.change(field, {
    target: {
      value:
        "HTTP_PROXY=http://proxy:7890\nEMPTY=\nLITERAL=$(do-not-run)=value",
    },
  });
  fireEvent.click(saveButton());
  await screen.findByText(/环境变量已保存；下次启动/);
  expect(screen.getByText("ENV · 3")).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("save_agent_environment", {
    hostId: host.id,
    agent: "claude",
    environment: {
      HTTP_PROXY: "http://proxy:7890",
      EMPTY: "",
      LITERAL: "$(do-not-run)=value",
    },
  });
  expect(onBusy.mock.calls).toEqual([[true], [false]]);

  view.rerender(<AgentSettings state={state} active={false} onBusy={onBusy} />);
  view.rerender(<AgentSettings state={state} active onBusy={onBusy} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "编辑 Claude Code" }),
  );
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Claude Code 环境变量") as HTMLTextAreaElement)
        .value,
    ).toContain("HTTP_PROXY=http://proxy:7890"),
  );
  expect(saveButton().disabled).toBe(true);
  expect(
    invoke.mock.calls.some(
      ([command]) =>
        command === "host_request" || command === "bind_agent_provider",
    ),
  ).toBe(false);
});

it("keeps Cursor ENV host-isolated and disables unsupported App Provider binding", async () => {
  setup();
  const base = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, args) => {
    if (command === "connect_host") {
      const hello = await base(command, args);
      return {
        ...hello,
        agents: [
          ...hello.agents,
          {
            id: "cursor",
            name: "Cursor Agent",
            available: true,
            detail: "Host-prepared",
            provider_protocols: [],
          },
        ],
      };
    }
    return base(command, args);
  });
  const other = { ...host, id: "cursor-other-host", name: "Cursor Other Host" };
  render(
    <AgentSettings
      state={{ ...state, hosts: [host, other] } as Workbench}
      active
      onBusy={() => {}}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "编辑 Cursor Agent" }),
  );
  const field = screen.getByLabelText(
    "Cursor Agent 环境变量",
  ) as HTMLTextAreaElement;
  expect(
    (
      screen.getByRole("combobox", {
        name: "Cursor Agent 关联 Provider",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.getByText(/暂不支持 App Provider 关联/)).toBeTruthy();
  expect(saveButton().disabled).toBe(true);

  fireEvent.change(field, { target: { value: "CURSOR_ENV=local-value" } });
  fireEvent.click(saveButton());
  await screen.findByText(/环境变量已保存；下次启动/);
  expect(invoke).toHaveBeenCalledWith("save_agent_environment", {
    hostId: host.id,
    agent: "cursor",
    environment: { CURSOR_ENV: "local-value" },
  });

  fireEvent.click(screen.getByRole("button", { name: "编辑 Claude Code" }));
  expect(
    (screen.getByLabelText("Claude Code 环境变量") as HTMLTextAreaElement)
      .value,
  ).toBe("HTTPS_PROXY=http://saved.test:7890");
  fireEvent.click(screen.getByRole("button", { name: "连接与 Agent" }));

  fireEvent.click(screen.getByRole("combobox", { name: "运行主机" }));
  fireEvent.click(screen.getByRole("option", { name: other.name }));
  fireEvent.click(
    await screen.findByRole("button", { name: "编辑 Cursor Agent" }),
  );
  expect(
    (screen.getByLabelText("Cursor Agent 环境变量") as HTMLTextAreaElement)
      .value,
  ).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "连接与 Agent" }));

  fireEvent.click(screen.getByRole("combobox", { name: "运行主机" }));
  fireEvent.click(screen.getByRole("option", { name: host.name }));
  fireEvent.click(
    await screen.findByRole("button", { name: "编辑 Cursor Agent" }),
  );
  expect(
    (screen.getByLabelText("Cursor Agent 环境变量") as HTMLTextAreaElement)
      .value,
  ).toBe("CURSOR_ENV=local-value");
  expect(
    invoke.mock.calls.some(([command]) => command === "bind_agent_provider"),
  ).toBe(false);
});

it("rejects invalid ENV, retains edits after a save failure, and discards draft on Cancel", async () => {
  setup();
  render(<AgentSettings state={state} active onBusy={() => {}} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "编辑 Claude Code" }),
  );
  const field = screen.getByLabelText(
    "Claude Code 环境变量",
  ) as HTMLTextAreaElement;
  fireEvent.change(field, {
    target: { value: "TOKEN=private-value\nTOKEN=another" },
  });
  expect(screen.getByRole("alert").textContent).toContain("变量名重复");
  expect(screen.getByRole("alert").textContent).not.toContain("private-value");
  expect(saveButton().disabled).toBe(true);

  fireEvent.change(field, {
    target: { value: "HTTP_PROXY=http://retry.test:7890" },
  });
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) =>
    command === "save_agent_environment"
      ? Promise.reject(new Error("无法保存配置"))
      : original(command, args),
  );
  fireEvent.click(saveButton());
  await screen.findByText("无法保存配置");
  expect(field.value).toBe("HTTP_PROXY=http://retry.test:7890");
  expect(saveButton().disabled).toBe(false);

  // Clicking Cancel discards the unsaved draft and returns to the list.
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByText("未保存修改")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "编辑 Claude Code" }));
  expect(
    (screen.getByLabelText("Claude Code 环境变量") as HTMLTextAreaElement)
      .value,
  ).toBe("HTTPS_PROXY=http://saved.test:7890");
});

it("disables ENV editing on an older Server and explains the required update", async () => {
  setup(false);
  render(<AgentSettings state={state} active onBusy={() => {}} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "编辑 Claude Code" }),
  );
  const field = screen.getByLabelText(
    "Claude Code 环境变量",
  ) as HTMLTextAreaElement;
  expect(field.disabled).toBe(true);
  expect(saveButton().disabled).toBe(true);
  expect(screen.getByText(/需要更新 Server 并重新连接/)).toBeTruthy();
});

it("keeps hosts isolated when switching the settings target", async () => {
  setup();
  const other = { ...host, id: "other-env-host", name: "Other Host" };
  render(
    <AgentSettings
      state={{ ...state, hosts: [host, other] } as Workbench}
      active
      onBusy={() => {}}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "编辑 Claude Code" }),
  );
  fireEvent.change(screen.getByLabelText("Claude Code 环境变量"), {
    target: { value: "TOKEN=unsaved-private-value" },
  });
  fireEvent.keyDown(screen.getByLabelText("Claude Code 环境变量"), {
    key: "Escape",
  });
  expect(screen.getByText("未保存修改")).toBeTruthy();

  fireEvent.click(screen.getByRole("combobox", { name: "运行主机" }));
  fireEvent.click(screen.getByRole("option", { name: "Other Host" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "编辑 Claude Code" }),
  );
  expect(
    (screen.getByLabelText("Claude Code 环境变量") as HTMLTextAreaElement)
      .value,
  ).toBe("");
  expect(invoke).toHaveBeenCalledWith("agent_environments", {
    hostId: other.id,
  });
  fireEvent.click(screen.getByRole("button", { name: "连接与 Agent" }));

  fireEvent.click(screen.getByRole("combobox", { name: "运行主机" }));
  fireEvent.click(screen.getByRole("option", { name: host.name }));
  expect(await screen.findByText("未保存修改")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "编辑 Claude Code" }));
  expect(
    (screen.getByLabelText("Claude Code 环境变量") as HTMLTextAreaElement)
      .value,
  ).toBe("TOKEN=unsaved-private-value");
  fireEvent.click(screen.getByRole("button", { name: "连接与 Agent" }));
  fireEvent.click(screen.getByRole("button", { name: "编辑 Codex" }));
  expect(
    (screen.getByLabelText("Codex 环境变量") as HTMLTextAreaElement).value,
  ).toBe("");
  expect(
    invoke.mock.calls.some(([command]) => command === "save_agent_environment"),
  ).toBe(false);
});

it.each(["", "TOKEN=first\nTOKEN=invalid-draft"])(
  "retains an unsaved ENV draft (%j) across category changes and reconnects",
  async (draft) => {
    setup();
    const onBusy = vi.fn();
    const view = render(<AgentSettings state={state} active onBusy={onBusy} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "编辑 Claude Code" }),
    );
    fireEvent.change(screen.getByLabelText("Claude Code 环境变量"), {
      target: { value: draft },
    });
    fireEvent.click(screen.getByRole("button", { name: "连接与 Agent" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑 Codex" }));
    fireEvent.change(screen.getByLabelText("Codex 环境变量"), {
      target: { value: "CODEX_TOKEN=independent-unsaved-value" },
    });
    fireEvent.click(screen.getByRole("button", { name: "连接与 Agent" }));

    view.rerender(
      <AgentSettings state={state} active={false} onBusy={onBusy} />,
    );
    view.rerender(<AgentSettings state={state} active onBusy={onBusy} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "编辑 Claude Code" }),
    );
    const reopened = screen.getByLabelText(
      "Claude Code 环境变量",
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(reopened.disabled).toBe(false));
    expect(reopened.value).toBe(draft);
    fireEvent.click(screen.getByRole("button", { name: "连接与 Agent" }));

    fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "编辑 Claude Code" }),
    );
    const reconnected = screen.getByLabelText(
      "Claude Code 环境变量",
    ) as HTMLTextAreaElement;
    await waitFor(() => expect(reconnected.disabled).toBe(false));
    expect(reconnected.value).toBe(draft);
    fireEvent.click(screen.getByRole("button", { name: "连接与 Agent" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑 Codex" }));
    expect(
      (screen.getByLabelText("Codex 环境变量") as HTMLTextAreaElement).value,
    ).toBe("CODEX_TOKEN=independent-unsaved-value");
    expect(
      invoke.mock.calls.some(
        ([command]) => command === "save_agent_environment",
      ),
    ).toBe(false);
  },
);

it("refreshes clean ENV while retaining dirty input against the latest saved baseline", async () => {
  setup();
  render(<AgentSettings state={state} active onBusy={() => {}} />);
  await screen.findByRole("button", { name: "编辑 Claude Code" });
  const original = invoke.getMockImplementation()!;
  let saved = { HTTPS_PROXY: "http://external.test:7890" };
  invoke.mockImplementation((command, args) =>
    command === "agent_environments"
      ? Promise.resolve({ claude: saved })
      : original(command, args),
  );
  fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "编辑 Claude Code" }),
  );
  let field = screen.getByLabelText(
    "Claude Code 环境变量",
  ) as HTMLTextAreaElement;
  await waitFor(() =>
    expect(field.value).toBe("HTTPS_PROXY=http://external.test:7890"),
  );
  expect(saveButton().disabled).toBe(true);
  fireEvent.change(field, { target: { value: "TOKEN=keep-this-draft" } });
  fireEvent.click(screen.getByRole("button", { name: "连接与 Agent" }));

  saved = { HTTPS_PROXY: "http://newer.test:7890" };
  fireEvent.click(screen.getByRole("button", { name: "重新连接" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "编辑 Claude Code" }),
  );
  field = screen.getByLabelText("Claude Code 环境变量") as HTMLTextAreaElement;
  await waitFor(() => expect(field.disabled).toBe(false));
  expect(field.value).toBe("TOKEN=keep-this-draft");
  expect(saveButton().disabled).toBe(false);
});
