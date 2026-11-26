// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { AppearanceProvider } from "./AppearanceProvider";
import { SettingsPage } from "./SettingsPage";
import type { Workbench } from "./useWorkbench";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  invoke.mockImplementation(async (command) => {
    if (command === "connect_host")
      return {
        kind: "hello",
        server_id: "srv",
        custom_agent_environment: true,
        agents: [
          {
            id: "claude",
            name: "Claude Code",
            detail: "2.1.306",
            provider_protocols: ["anthropic_messages"],
          },
        ],
      };
    if (command === "agent_providers" || command === "provider_request")
      return { kind: "providers", providers: [], bindings: [] };
    if (command === "agent_environments") return {};
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function makeWorkbench(overrides?: Partial<Workbench>): Workbench {
  return {
    settingsTab: "agents",
    setSettingsTab: vi.fn(),
    settingsReturnToProject: false,
    setSettingsReturnToProject: vi.fn(),
    setModal: vi.fn(),
    host: { id: "local", name: "本机", ssh: "", server_path: null },
    hosts: [
      { id: "local", name: "本机", ssh: "", server_path: null },
      { id: "devbox", name: "Devbox", ssh: "devbox", server_path: null },
    ],
    hostErrors: { devbox: "" },
    projects: [],
    saveSshHost: vi.fn(),
    removeSshHost: vi.fn(),
    refreshHost: vi.fn(),
    sessionAction: vi.fn(),
    ...overrides,
  } as unknown as Workbench;
}

it("suspends background siblings with inert while open and peels Escape layers (Select -> Subview -> Modal)", async () => {
  const state = makeWorkbench();
  const view = render(
    <AppearanceProvider>
      <div data-testid="background-app">
        <button type="button">打开设置触发器</button>
      </div>
      <SettingsPage state={state} active={false} />
    </AppearanceProvider>,
  );

  const trigger = screen.getByRole("button", { name: "打开设置触发器" });
  const bgApp = screen.getByTestId("background-app");
  trigger.focus();
  expect(bgApp.inert).toBeFalsy();

  view.rerender(
    <AppearanceProvider>
      <div data-testid="background-app">
        <button type="button">打开设置触发器</button>
      </div>
      <SettingsPage state={state} active />
    </AppearanceProvider>,
  );

  expect(screen.getByRole("dialog", { name: "设置" })).toBeTruthy();
  expect(bgApp.inert).toBe(true);

  // Enter Agent edit subview
  const editButton = await screen.findByRole("button", {
    name: "编辑 Claude Code",
  });
  editButton.focus();
  fireEvent.click(editButton);
  // Open Provider Select inside subview
  const providerSelect = screen.getByRole("combobox", {
    name: "Claude Code 关联 Provider",
  });
  fireEvent.click(providerSelect);
  expect(
    screen.getByRole("listbox", { name: "Claude Code 关联 Provider" }),
  ).toBeTruthy();

  // 1st Escape: closes open Select popover only
  fireEvent.keyDown(window, { key: "Escape" });
  expect(
    screen.queryByRole("listbox", { name: "Claude Code 关联 Provider" }),
  ).toBeNull();
  expect(screen.getByLabelText("Claude Code 环境变量")).toBeTruthy();
  expect(state.setModal).not.toHaveBeenCalled();

  // 2nd Escape: exits Subview back to Agent list and restores focus inside Settings
  fireEvent.keyDown(providerSelect, { key: "Escape", bubbles: true });
  expect(screen.queryByLabelText("Claude Code 环境变量")).toBeNull();
  const restoredEditButton = screen.getByRole("button", {
    name: "编辑 Claude Code",
  });
  expect(document.activeElement).toBe(restoredEditButton);
  expect(state.setModal).not.toHaveBeenCalled();

  // 3rd Escape on the active element: closes Settings modal
  fireEvent.keyDown(document.activeElement!, {
    key: "Escape",
    bubbles: true,
  });
  expect(state.setModal).toHaveBeenCalledWith(null);

  // Closing releases inert and restores trigger focus
  view.rerender(
    <AppearanceProvider>
      <div data-testid="background-app">
        <button type="button">打开设置触发器</button>
      </div>
      <SettingsPage state={state} active={false} />
    </AppearanceProvider>,
  );
  await waitFor(() => expect(bgApp.inert).toBeFalsy());
  expect(document.activeElement).toBe(trigger);
});

it("navigates categories via keyboard arrows and returns to ProjectDialog when settingsReturnToProject is set", () => {
  const state = makeWorkbench({
    settingsTab: "ssh",
    settingsReturnToProject: true,
  });
  render(
    <AppearanceProvider>
      <SettingsPage state={state} active />
    </AppearanceProvider>,
  );

  const tablist = screen.getByRole("tablist", { name: "设置分类" });
  fireEvent.keyDown(tablist, { key: "ArrowDown" });
  expect(state.setSettingsTab).toHaveBeenCalledWith("providers");

  fireEvent.click(screen.getAllByRole("button", { name: "关闭设置" })[0]);
  expect(state.setModal).toHaveBeenCalledWith("project");
  expect(state.setSettingsReturnToProject).toHaveBeenCalledWith(false);
});
