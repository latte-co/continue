// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectActions } from "./ProjectActions";
import type { Workbench } from "./useWorkbench";
import type { Session } from "./protocol";
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  connect: vi.fn(),
  chooseProjectFolder: vi.fn(),
  closeSession: vi.fn(),
  updateProject: vi.fn(),
  removeProject: vi.fn(),
}));
vi.mock("./api", () => ({
  localHost: { id: "local", name: "本机", ssh: null, server_path: null },
  connect: mocks.connect,
  chooseProjectFolder: mocks.chooseProjectFolder,
  request: mocks.request,
  message: String,
  revealProject: vi.fn(),
}));
const session = (id: string, busy = false): Session => ({
  id,
  project_id: "p",
  title: id,
  agent: "claude",
  native_id: null,
  model: null,
  effort: null,
  permission_mode: null,
  status: "completed",
  created_at: 0,
  custom_title: false,
  title_requested: false,
  pinned_at: id === "pinned" ? 1 : null,
  unread: true,
  archived: false,
  agent_session_open: true,
  agent_session_busy: busy,
});
let rows: Session[];
beforeEach(() => {
  vi.clearAllMocks();
  rows = [session("pinned"), session("other")];
  mocks.request.mockImplementation(async () => ({
    kind: "project_agent_sessions",
    sessions: rows,
    next: null,
  }));
  mocks.connect.mockResolvedValue({
    kind: "hello",
    server_id: "remote-1",
    agents: [],
  });
  mocks.chooseProjectFolder.mockResolvedValue(null);
  mocks.closeSession.mockResolvedValue(undefined);
  mocks.updateProject.mockResolvedValue([]);
  mocks.removeProject.mockResolvedValue(undefined);
});
afterEach(cleanup);
const props = () => ({
  project: { hostId: "remote", id: "p", name: "Project", path: "/work/repo" },
  point: { x: 20, y: 20 },
  close: vi.fn(),
  state: {
    hosts: [
      { id: "local", name: "本机", ssh: null, server_path: null },
      { id: "remote", name: "Remote", ssh: "devbox", server_path: null },
    ],
    sessionAction: mocks.closeSession,
    updateProject: mocks.updateProject,
    removeProject: mocks.removeProject,
    setError: vi.fn(),
  } as unknown as Workbench,
});
it("shows the live count and directly closes all idle sessions on the right host", async () => {
  const p = props();
  render(<ProjectActions {...p} />);
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "关闭全部对话（2）" }),
  );
  await waitFor(() => expect(p.close).toHaveBeenCalledOnce());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(mocks.closeSession.mock.calls).toEqual([
    [
      "remote",
      {
        method: "close_agent_session",
        session_id: "pinned",
        only_if_idle: true,
      },
    ],
    [
      "remote",
      {
        method: "close_agent_session",
        session_id: "other",
        only_if_idle: true,
      },
    ],
  ]);
});
it("asks once for background work and closes only after confirmation", async () => {
  rows[1].agent_session_busy = true;
  const p = props();
  render(<ProjectActions {...p} />);
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "关闭全部对话（2）" }),
  );
  await screen.findByRole("dialog", { name: "关闭全部对话" });
  expect(mocks.closeSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "关闭全部" }));
  await waitFor(() => expect(p.close).toHaveBeenCalledOnce());
  expect(mocks.closeSession).toHaveBeenCalledWith(
    "remote",
    expect.objectContaining({ session_id: "other", only_if_idle: false }),
  );
});
it("reports partial failure and retries just that session", async () => {
  mocks.closeSession
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("temporarily busy"));
  const p = props();
  render(<ProjectActions {...p} />);
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "关闭全部对话（2）" }),
  );
  await screen.findByText("已关闭 1 个，1 个关闭失败。");
  rows = [session("other")];
  fireEvent.click(screen.getByRole("button", { name: "重试失败项" }));
  await waitFor(() => expect(p.close).toHaveBeenCalledOnce());
  expect(mocks.closeSession.mock.calls.map(([, r]) => r.session_id)).toEqual([
    "pinned",
    "other",
    "other",
  ]);
});
it("shows unavailable live evidence instead of inventing a zero count", async () => {
  rows[0].agent_session_open = undefined;
  render(<ProjectActions {...props()} />);
  await screen.findByRole("alert");
  const button = screen.getByRole("menuitem", {
    name: "关闭全部对话",
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(mocks.closeSession).not.toHaveBeenCalled();
});

it("confirms and closes a running side chat, preserving the pending-write notice", async () => {
  rows = [{ ...session("main"), native_id: "native-main" }];
  const side = { ...session("side", true), status: "running" as const };
  mocks.request.mockResolvedValue({
    kind: "project_agent_sessions",
    sessions: [...rows, side],
    next: null,
  });
  mocks.closeSession.mockImplementation(async (_host, action) => ({
    kind: action.session_id === "side" ? "side_chat_closed" : "ok",
  }));
  const p = props();
  render(<ProjectActions {...p} />);
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "关闭全部对话（2）" }),
  );
  await screen.findByRole("dialog", { name: "关闭全部对话" });
  expect(mocks.closeSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "关闭全部" }));
  await screen.findByText(/side：本地会话已关闭，后台写入待确认/);
  expect(
    mocks.closeSession.mock.calls.map(([, action]) => [
      action.session_id,
      action.only_if_idle,
    ]),
  ).toEqual([
    ["main", false],
    ["side", false],
  ]);
  expect(p.close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "完成" }));
  expect(p.close).toHaveBeenCalledOnce();
});

it("edits a local project's name and source folder, supports clearing/re-adding the folder, and routes bottom-left remove back to edit on cancel", async () => {
  mocks.chooseProjectFolder.mockResolvedValue("/Users/dev/new-repo");
  const p = {
    ...props(),
    project: {
      hostId: "local",
      id: "p",
      name: "continue",
      path: "/Users/dev/continue",
    },
  };
  render(<ProjectActions {...p} />);
  fireEvent.click(await screen.findByRole("menuitem", { name: "编辑" }));
  await screen.findByRole("dialog", { name: "编辑项目" });

  const nameInput = screen.getByLabelText("项目名称") as HTMLInputElement;
  expect(nameInput.value).toBe("continue");
  expect(screen.getByText("continue")).toBeTruthy();

  const saveButton = screen.getByRole("button", {
    name: "保存",
  }) as HTMLButtonElement;
  expect(saveButton.disabled).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "移除源文件夹" }));
  expect(saveButton.disabled).toBe(true);
  const addFolderButton = screen.getByRole("button", { name: "添加文件夹" });
  expect(document.activeElement).toBe(addFolderButton);

  fireEvent.click(addFolderButton);
  await screen.findByText("new-repo");
  expect(saveButton.disabled).toBe(false);

  fireEvent.change(nameInput, { target: { value: "continue-next" } });
  fireEvent.click(screen.getByRole("button", { name: "移除本地项目" }));
  await screen.findByRole("dialog", { name: "移除项目" });
  fireEvent.click(screen.getByRole("button", { name: "取消" }));

  await screen.findByRole("dialog", { name: "编辑项目" });
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "移除本地项目" }),
  );
  expect((screen.getByLabelText("项目名称") as HTMLInputElement).value).toBe(
    "continue-next",
  );
  expect(screen.getByText("new-repo")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(p.close).toHaveBeenCalledOnce());
  expect(mocks.updateProject).toHaveBeenCalledWith(
    "local",
    "p",
    "continue-next",
    "/Users/dev/new-repo",
  );
});

it("browses remote directories when editing an SSH project and returns to edit view on Escape", async () => {
  mocks.request.mockImplementation(async (_host, r) => {
    if (r.method === "browse_directories")
      return {
        kind: "directories",
        path: r.path === "/work/next" ? "/work/next" : "/work",
        parent: "/",
        entries: [{ name: "next", path: "/work/next", directory: true }],
        truncated: false,
      };
    return { kind: "project_agent_sessions", sessions: rows, next: null };
  });
  const p = props();
  render(<ProjectActions {...p} />);
  fireEvent.click(await screen.findByRole("menuitem", { name: "编辑" }));
  await screen.findByRole("dialog", { name: "编辑项目" });
  expect(screen.getByRole("button", { name: "移除项目" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "更换文件夹" }));
  await screen.findByRole("heading", { name: "选择文件夹" });

  fireEvent.keyDown(window, { key: "Escape" });
  await screen.findByRole("heading", { name: "编辑项目" });
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "更换文件夹" }),
  );
  expect(p.close).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "更换文件夹" }));
  fireEvent.click(await screen.findByRole("button", { name: "next" }));
  const choose = await screen.findByRole("button", { name: "选择此文件夹" });
  await waitFor(() =>
    expect((choose as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(choose);

  await screen.findByText("next");
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(p.close).toHaveBeenCalledOnce());
  expect(mocks.updateProject).toHaveBeenCalledWith(
    "remote",
    "p",
    "Project",
    "/work/next",
  );
});
