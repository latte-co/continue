// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithStatus as render } from "./test/renderWithStatus";
import { afterEach, expect, it, vi } from "vitest";
import { TaskOverview } from "./TaskOverview";
import { clearSelectedGitRepositoriesForTests } from "./gitRepositories";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => ({ request: mocks.request, message: String }));
afterEach(() => {
  clearSelectedGitRepositoriesForTests();
  cleanup();
});
const project = { id: "p", name: "Project", path: "/project" };
const state = {
  tasks: [
    {
      id: "child",
      native_id: "native",
      tool_use_id: null,
      title: "Child",
      status: "running" as const,
      summary: null,
      last_tool: "Read",
      started_at: 1,
      updated_at: 2,
    },
  ],
  loading: false,
  error: "",
  truncated: false,
};
it("opens a keyboard-accessible overview and routes to real changes, child list without sources", async () => {
  mocks.request.mockResolvedValue({
    kind: "git_review",
    review: {
      entries: [{ path: "a" }, { path: "b" }],
      added: 12,
      removed: 3,
      binary_files: 0,
      truncated: false,
      unavailable: null,
    },
  });
  const changes = vi.fn(),
    children = vi.fn();
  render(
    <TaskOverview
      hostId="local"
      project={project}
      connected
      subagents={state}
      openChanges={changes}
      openSubagents={children}
      openInfo={vi.fn()}
    />,
  );
  const trigger = screen.getByRole("button", { name: "任务概览" });
  fireEvent.click(trigger);
  await screen.findByText("2 个文件");
  expect(screen.queryByText("来源")).toBeNull();
  expect(
    screen.queryByRole("button", { name: /添加来源|查看全部/ }),
  ).toBeNull();
  expect(screen.getByText("+12")).toBeTruthy();
  expect(screen.getByText("-3")).toBeTruthy();
  expect(screen.getByText("1 个运行中 · 0 完成")).toBeTruthy();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: /变更/ }));
  expect(changes).toHaveBeenCalledOnce();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: /1 个运行中/ }));
  expect(children).toHaveBeenCalledOnce();
});
it("fences late changes and scopes the overview to its host/project", async () => {
  let resolve!: (value: unknown) => void;
  mocks.request
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue({
      kind: "git_review",
      review: {
        entries: [],
        added: 0,
        removed: 0,
        binary_files: 0,
        truncated: false,
        unavailable: null,
      },
    });
  const props = {
    connected: true,
    subagents: state,
    openChanges: vi.fn(),
    openSubagents: vi.fn(),
    openInfo: vi.fn(),
  };
  const view = render(
    <TaskOverview {...props} hostId="local" project={project} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "任务概览" }));
  view.rerender(
    <TaskOverview
      {...props}
      hostId="remote"
      project={{ ...project, id: "other" }}
    />,
  );
  await screen.findByText("0 个文件");
  resolve({
    kind: "git_review",
    review: {
      entries: [{ path: "stale" }],
      added: 20,
      removed: 0,
      truncated: false,
    },
  });
  await waitFor(() => expect(screen.getByText("0 个文件")).toBeTruthy());
});
it("pins the overview into task information and dismisses the popover", () => {
  const openInfo = vi.fn();
  render(
    <TaskOverview
      hostId="local"
      connected={false}
      subagents={state}
      openChanges={vi.fn()}
      openSubagents={vi.fn()}
      openInfo={openInfo}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "任务概览" }));
  const pin = screen.getByRole("button", { name: "固定到右侧栏" });
  expect(document.activeElement).toBe(pin);
  fireEvent.click(pin);
  expect(openInfo).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("opens a historical side chat from the main conversation overview", async () => {
  const openSideChat = vi.fn();
  const title = "排查长对话切换到侧边聊天后的上下文恢复";
  mocks.request.mockImplementation(async (_host, request) => {
    if (request.method === "side_chat_history") {
      if (!request.before)
        return {
          kind: "side_chat_history",
          sessions: [
            {
              id: "new",
              title: "较新记录",
              created_at: Date.now(),
              status: "completed",
            },
          ],
          next: "new",
        };
      return {
        kind: "side_chat_history",
        sessions: [
          { id: "old", title, created_at: Date.now(), status: "waiting" },
        ],
        next: null,
      };
    }
    return { kind: "git_review", review: { entries: [] } };
  });
  render(
    <TaskOverview
      hostId="local"
      project={project}
      connected
      subagents={state}
      openChanges={vi.fn()}
      openSubagents={vi.fn()}
      openInfo={vi.fn()}
      sideChatHistory={{
        hostId: "local",
        parentId: "parent",
        onOpen: openSideChat,
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "任务概览" }));
  fireEvent.click(await screen.findByRole("button", { name: "查看更早记录" }));
  expect(screen.getByRole("button", { name: /较新记录/ })).toBeTruthy();
  const entry = await screen.findByRole("button", { name: /排查长对话/ });
  expect(entry.getAttribute("title")).toBe(title);
  expect(entry.textContent).toContain("等待回应");
  expect(entry.querySelector("time")?.textContent).toMatch(
    /^今天 \d{2}:\d{2}$/,
  );
  fireEvent.click(entry);
  expect(openSideChat).toHaveBeenCalledWith("old");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("stays silent on non-Git projects and summarizes child repositories when present", async () => {
  const nonGitError = Object.assign(new Error("此项目无 Git 分支信息"), {
    code: "not_git_repository",
  });
  mocks.request.mockImplementation(async (_host, req) => {
    if (req.method === "git_review") throw nonGitError;
    if (req.method === "git_repositories")
      return { kind: "git_repositories", repositories: [], truncated: false };
    throw new Error(`unexpected ${req.method}`);
  });
  const view = render(
    <TaskOverview
      hostId="local"
      project={project}
      connected
      subagents={state}
      openChanges={vi.fn()}
      openSubagents={vi.fn()}
      openInfo={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "任务概览" }));
  await screen.findByText("此项目无 Git 分支信息");
  // StatusCenter stays quiet (no badge count in aria-label).
  expect(screen.getByRole("button", { name: "状态提示" })).toBeTruthy();

  // Umbrella workspace with child repositories shows child branch stats without alerts.
  mocks.request.mockImplementation(async (_host, req) => {
    if (req.method === "git_review" && !req.repo_path) throw nonGitError;
    if (req.method === "git_repositories")
      return {
        kind: "git_repositories",
        repositories: [
          { path: "continue", name: "continue", kind: "repository" },
          {
            path: ".oh-my-code/worktree/continue/fix",
            name: "continue/fix",
            kind: "worktree",
          },
        ],
        truncated: false,
      };
    if (req.method === "git_review" && req.repo_path === "continue")
      return {
        kind: "git_review",
        review: {
          entries: [{ path: "src/App.tsx", binary: false }],
          added: 9,
          removed: 2,
          truncated: false,
        },
      };
    throw new Error(`unexpected ${JSON.stringify(req)}`);
  });
  view.rerender(
    <TaskOverview
      hostId="local"
      project={{ id: "umbrella", name: "latte-co", path: "/latte-co" }}
      connected
      subagents={state}
      openChanges={vi.fn()}
      openSubagents={vi.fn()}
      openInfo={vi.fn()}
    />,
  );
  await screen.findByText("1 个文件");
  expect(screen.getByText("+9")).toBeTruthy();
  expect(screen.getByText("-2")).toBeTruthy();
  expect(screen.getByText("continue · 分支 · 共 2 个仓库")).toBeTruthy();
  expect(screen.getByRole("button", { name: "状态提示" })).toBeTruthy();
});
