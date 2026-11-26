// @vitest-environment jsdom
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Conversation } from "./Conversation";
import { DraftStore } from "./drafts";
import { renderWithStatus } from "./test/renderWithStatus";
import type { Effort, Event, Session } from "./protocol";
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  model: vi.fn(),
  effort: vi.fn(),
}));
vi.mock("./api", () => ({ request: mocks.request, message: String }));
vi.mock("./PermissionPicker", () => ({ PermissionPicker: () => null }));
vi.mock("./TaskProjectPicker", () => ({ TaskProjectPicker: () => null }));
vi.mock("./useAgentPreferences", () => ({
  useAgentPreferences: () => {
    const [model, setModel] = useState<string | null>("opus");
    const [effort, setEffort] = useState<Effort | null>("high");
    return {
      model,
      effort,
      permissionMode: null,
      chooseModel: (value: string | null) => {
        mocks.model(value);
        setModel(value);
      },
      chooseEffort: (value: Effort | null) => {
        mocks.effort(value);
        setEffort(value);
      },
    };
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  HTMLElement.prototype.scrollTo = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  mocks.request.mockResolvedValue({
    kind: "models",
    models: ["opus", "haiku"],
    provider: null,
    default_model: null,
    effort_levels: ["low", "high"],
    model_labels: {},
  });
});
afterEach(cleanup);
function setup(extra = {}) {
  const p = {
    drafts: new DraftStore(),
    hostId: "remote",
    projectId: "p",
    projectName: "Test",
    projects: [],
    hosts: [],
    settingsOpen: false,
    events: [],
    connected: true,
    available: true,
    selectTaskProject: vi.fn(),
    openProject: vi.fn(),
    send: vi.fn().mockResolvedValue(true),
    cancel: vi.fn(),
    approve: vi.fn(),
    ...extra,
  };
  renderWithStatus(<Conversation {...p} />);
  return p;
}
const input = () => screen.getByRole("textbox", { name: "任务输入" });
function inputValue(): string {
  const el = input();
  if (el instanceof HTMLTextAreaElement) return el.value;
  return Array.from(el.children)
    .map((block) =>
      Array.from(block.childNodes)
        .map((node) =>
          node instanceof HTMLElement && node.dataset.commandName
            ? `/${node.dataset.commandName}`
            : (node.textContent ?? ""),
        )
        .join(""),
    )
    .join("\n");
}
function setInputText(text: string) {
  let el = input();
  if (!(el instanceof HTMLTextAreaElement)) {
    // Delete trailing space + command pill or paste replacement
    fireEvent.paste(el, {
      clipboardData: {
        files: [],
        types: ["text/plain"],
        getData: (mime: string) => (mime === "text/plain" ? text : ""),
      },
    });
    return;
  }
  fireEvent.change(el, { target: { value: text } });
}
function command(text: string) {
  // Trailing whitespace matches the command inserted by the autocomplete menu.
  fireEvent.change(input(), { target: { value: `${text} ` } });
  fireEvent.keyDown(input(), { key: "Enter" });
}
it.each(["model", "effort"] as const)(
  "/%s opens the shared menu and updates App preferences without a turn",
  async (target) => {
    const p = setup();
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Model and reasoning effort" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    mocks.request.mockClear();
    command(`/${target}`);
    const option = await screen.findByRole("menuitemradio", {
      name: target === "model" ? "haiku" : "low",
    });
    const menu = screen.getByRole("menu", {
      name: target === "model" ? "Model" : "Reasoning effort",
    });
    expect(menu.contains(document.activeElement)).toBe(true);
    expect(inputValue()).toBe("");
    expect(mocks.request).toHaveBeenCalledWith(
      "remote",
      expect.objectContaining({ method: "models", model: "opus" }),
    );
    // The real portal keyboard handler must not bubble into send or stop.
    option.focus();
    fireEvent.keyDown(option, { key: "Enter" });
    expect(
      target === "model" ? mocks.model : mocks.effort,
    ).toHaveBeenCalledWith(target === "model" ? "haiku" : "low");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(p.send).not.toHaveBeenCalled();
    expect(p.cancel).not.toHaveBeenCalled();
    expect(
      mocks.request.mock.calls.some(([, r]) =>
        ["send", "create_session", "agent_commands"].includes(r.method),
      ),
    ).toBe(false);
  },
);

it("retries the initial failed model request when /model is entered", async () => {
  let attempts = 0;
  mocks.request.mockImplementation(async (_host, request) => {
    if (request.method !== "models") return { kind: "ok" };
    if (++attempts === 1) throw new Error("missing initial catalog");
    return {
      kind: "models",
      models: ["opus", "haiku"],
      provider: null,
      default_model: null,
      effort_levels: ["high"],
      model_labels: {},
    };
  });
  const p = setup();
  await act(async () => {});
  expect(attempts).toBe(1);
  expect(screen.getByRole("button", { name: "状态提示（1）" })).toBeTruthy();
  command("/model");
  expect(inputValue()).toBe("");
  expect(screen.getByRole("menu", { name: "Model" })).toBeTruthy();
  expect(
    await screen.findByRole("menuitemradio", { name: "haiku" }),
  ).toBeTruthy();
  expect(attempts).toBe(2);
  expect(p.send).not.toHaveBeenCalled();
});

it("keeps /model from becoming stop during a running turn", async () => {
  const events: Event[] = [
    {
      seq: 1,
      at: 1,
      session_id: "s",
      event: { kind: "user", request_id: "r", text: "work" },
    },
  ];
  const p = setup({
    session: {
      id: "s",
      agent: "claude",
      status: "running",
      archived: false,
    } as Session,
    events,
  });
  await waitFor(() => expect(mocks.request).toHaveBeenCalled());
  command("/model");
  expect(screen.getByText(/请在任务结束后选择/)).toBeTruthy();
  expect(inputValue()).toBe("/model ");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(p.send).not.toHaveBeenCalled();
  expect(p.cancel).not.toHaveBeenCalled();
});
it.each([true, false])(
  "/effort uses the refreshed levels when the selected model's capability changes (previously supported: %s)",
  async (previouslySupported) => {
    const catalog = {
      kind: "models",
      models: ["opus"],
      provider: null,
      default_model: null,
      model_labels: {},
    };
    mocks.request.mockResolvedValueOnce({
      ...catalog,
      effort_levels: previouslySupported ? ["high"] : [],
    });
    let finishRefresh!: (result: unknown) => void;
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const p = setup();
    await act(async () => {});
    command("/effort");
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(inputValue()).toBe("/effort ");
    expect(screen.queryByRole("menu", { name: "Reasoning effort" })).toBeNull();
    await act(async () =>
      finishRefresh({
        ...catalog,
        effort_levels: previouslySupported ? [] : ["low"],
      }),
    );
    if (previouslySupported) {
      expect(screen.getByText(/不支持调整思考强度/)).toBeTruthy();
      expect(inputValue()).toBe("/effort ");
      expect(screen.queryByRole("menu")).toBeNull();
    } else {
      expect(screen.getByRole("menuitemradio", { name: "low" })).toBeTruthy();
      expect(screen.queryByRole("menuitemradio", { name: "high" })).toBeNull();
      expect(inputValue()).toBe("");
    }
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(p.send).not.toHaveBeenCalled();
  },
);
it("does not open /effort after the user edits the pending command", async () => {
  const catalog = {
    kind: "models",
    models: ["opus"],
    provider: null,
    default_model: null,
    effort_levels: ["high"],
    model_labels: {},
  };
  mocks.request.mockResolvedValueOnce(catalog);
  let finishRefresh!: (result: typeof catalog) => void;
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRefresh = resolve;
      }),
  );
  const p = setup();
  await act(async () => {});
  command("/effort");
  p.drafts.update("new-task", { text: "continue" });
  setInputText("continue");
  await waitFor(() => expect(inputValue()).toContain("continue"));
  await act(async () => finishRefresh(catalog));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(p.send).not.toHaveBeenCalled();
});
it.each(["Enter", "click"])(
  "accepts /model via %s before an obsolete /effort refresh settles",
  async (submitVia) => {
    const catalog = {
      kind: "models",
      models: ["opus", "haiku"],
      provider: null,
      default_model: null,
      effort_levels: ["high"],
      model_labels: {},
    };
    mocks.request.mockResolvedValueOnce(catalog);
    let finishRefresh!: (result: typeof catalog) => void;
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const p = setup();
    await act(async () => {});
    command("/effort");
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(inputValue()).toBe("/effort ");

    // Click the command pill to select it, delete it, then enter `/model `
    const pill = input().querySelector<HTMLElement>(
      '[data-command-name="effort"]',
    )!;
    fireEvent.click(pill);
    fireEvent.keyDown(input(), { key: "Backspace", keyCode: 8 });
    await waitFor(() => expect(input()).toBeInstanceOf(HTMLTextAreaElement));
    fireEvent.change(input(), { target: { value: "/model " } });
    expect(input().querySelector('[data-command-name="model"]')).toBeTruthy();
    if (submitVia === "Enter") fireEvent.keyDown(input(), { key: "Enter" });
    else fireEvent.click(screen.getByRole("button", { name: "选择模型" }));
    expect(inputValue()).toBe("");
    expect(screen.getByRole("menu", { name: "Model" })).toBeTruthy();
    expect(screen.getByText("正在刷新模型…")).toBeTruthy();

    await act(async () => finishRefresh(catalog));
    expect(screen.getByRole("menuitemradio", { name: "haiku" })).toBeTruthy();
    expect(screen.queryByRole("menu", { name: "Reasoning effort" })).toBeNull();
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(p.send).not.toHaveBeenCalled();
  },
);
it("preserves a model command during disconnect without opening a stale menu", () => {
  const p = setup({ connected: false });
  command("/model");
  expect(screen.getByText(/主机未连接/)).toBeTruthy();
  expect(inputValue()).toBe("/model ");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(p.send).not.toHaveBeenCalled();
});
