// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SSHSettings } from "./SSHSettings";
import type { Workbench } from "./useWorkbench";

vi.mock("./api", () => ({
  chooseIdentityFile: vi.fn().mockResolvedValue("/Users/test/.ssh/id_ed25519"),
  message: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeState(overrides?: Partial<Workbench>): Workbench {
  return {
    hosts: [
      { id: "local", name: "本机", ssh: "", server_path: null },
      {
        id: "devbox",
        name: "Devbox",
        ssh: "user@devbox",
        port: 2222,
        server_path: "~/.local/bin/latte-continue-server",
        auth: "none",
      },
    ],
    hostErrors: { devbox: "" },
    saveSshHost: vi.fn().mockResolvedValue(undefined),
    removeSshHost: vi.fn().mockResolvedValue(undefined),
    refreshHost: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Workbench;
}

it("switches into an in-pane subview for adding and editing SSH hosts without nested modals", async () => {
  const state = makeState();
  render(<SSHSettings state={state} onBusy={() => {}} />);

  expect(screen.getByText("Devbox")).toBeTruthy();
  expect(screen.getByText("user@devbox:2222 · 默认身份验证")).toBeTruthy();
  expect(document.querySelector('[role="dialog"]')).toBeNull();

  // Enter Edit subview
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect((screen.getByLabelText("显示名称") as HTMLInputElement).value).toBe(
    "Devbox",
  );
  expect(
    (screen.getByLabelText("SSH 端口（可选）") as HTMLInputElement).value,
  ).toBe("2222");

  // Validate port bounds in subview
  fireEvent.change(screen.getByLabelText("SSH 端口（可选）"), {
    target: { value: "70000" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存并连接" }));
  expect(screen.getByRole("alert").textContent).toContain("1–65535");
  expect(state.saveSshHost).not.toHaveBeenCalled();

  // Escape exits subview back to list
  fireEvent.keyDown(screen.getByLabelText("显示名称"), { key: "Escape" });
  expect(screen.getByText("user@devbox:2222 · 默认身份验证")).toBeTruthy();

  // Add new SSH host via top-right Add button and switch auth mode via Select
  fireEvent.click(screen.getByRole("button", { name: "添加" }));
  fireEvent.change(screen.getByLabelText("显示名称"), {
    target: { value: "Sandbox" },
  });
  fireEvent.change(screen.getByLabelText("主机名"), {
    target: { value: "sandbox.internal" },
  });
  fireEvent.click(screen.getByRole("combobox", { name: "身份验证方式" }));
  fireEvent.click(screen.getByRole("option", { name: /身份文件/ }));
  fireEvent.change(screen.getByLabelText("身份文件"), {
    target: { value: "/Users/test/.ssh/id_ed25519" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存并连接" }));
  await waitFor(() =>
    expect(state.saveSshHost).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Sandbox",
        ssh: "sandbox.internal",
        port: null,
        auth: "identity_file",
        identity_file: "/Users/test/.ssh/id_ed25519",
      }),
      undefined,
    ),
  );
});

it("confirms SSH host removal inline without window.confirm", async () => {
  const state = makeState();
  render(<SSHSettings state={state} onBusy={() => {}} />);

  fireEvent.click(screen.getByRole("button", { name: "移除 Devbox" }));
  expect(screen.getByText("移除后此设备上的项目将从侧边栏隐藏。")).toBeTruthy();
  expect(state.removeSshHost).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByText("移除后此设备上的项目将从侧边栏隐藏。")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "移除 Devbox" }));
  fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
  await waitFor(() =>
    expect(state.removeSshHost).toHaveBeenCalledWith("devbox"),
  );
});
