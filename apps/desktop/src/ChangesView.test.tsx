// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { renderWithStatus as render } from "./test/renderWithStatus";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChangesView } from "./ChangesView";
import { clearSelectedGitRepositoriesForTests } from "./gitRepositories";
import type { Request, TurnChanges } from "./protocol";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => ({ request: mocks.request, message: String }));
const project = { id: "p", name: "Project", path: "/project" };
const props = { hostId: "local", project, active: true };
const info = {
  branch: "feature",
  head: "a".repeat(40),
  default_base: "refs/remotes/origin/main",
  refs: [
    { name: "origin/main", full_name: "refs/remotes/origin/main" },
    { name: "main", full_name: "refs/heads/main" },
  ],
  truncated: false,
};
const entries = [
  {
    path: "a.ts",
    previous_path: null,
    status: "M",
    added: 2,
    removed: 1,
    binary: false,
    untracked: false,
  },
  {
    path: "b.ts",
    previous_path: "old.ts",
    status: "R",
    added: 0,
    removed: 0,
    binary: false,
    untracked: false,
  },
];
const review = {
  base: "b".repeat(40),
  head: info.head,
  entries,
  added: 2,
  removed: 1,
  truncated: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  clearSelectedGitRepositoriesForTests();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  mocks.request.mockImplementation(async (_host: string, req: Request) =>
    req.method === "git_info"
      ? { kind: "git_info", info }
      : req.method === "git_review"
        ? { kind: "git_review", review }
        : {
            kind: "content",
            text: `--- a/${"path" in req ? req.path : ""}\n+++ b/file\n@@ -10 +20,2 @@\n-old\n+new\n+extra\n`,
            truncated: false,
          },
  );
});
afterEach(cleanup);
it("routes image previews to the saved turn on the selected remote host without reading textual diff or live sources", async () => {
  URL.createObjectURL = vi.fn(() => "blob:saved-image");
  URL.revokeObjectURL = vi.fn();
  mocks.request.mockImplementation(async (_host: string, req: Request) => {
    if (req.method === "turn_change_summary")
      return {
        kind: "turn_changes",
        changes: {
          request_id: "saved-r",
          undo: "ready",
          interrupted: false,
          background_pending: false,
          summary: {
            entries: [
              { path: "qr.png", status: "M", added: null, removed: null },
            ],
            added: 0,
            removed: 0,
            binary_files: 1,
            truncated: false,
            baseline_at: 1000,
            unavailable: null,
          },
        },
      };
    if (req.method === "preview_change")
      return {
        kind: "change_preview",
        chunk: {
          data: [137, 80, 78, 71],
          mime_type: "image/png",
          size: 4,
          next: 4,
          has_more: false,
          version: "saved",
          sha256: null,
        },
      };
    throw new Error(`unexpected ${req.method}`);
  });
  render(
    <ChangesView
      {...props}
      hostId="devbox"
      sessionId="saved-session"
      requestId="saved-r"
    />,
  );
  expect(
    await screen.findByRole("img", { name: "qr.png · 修改后" }),
  ).toBeTruthy();
  const diffGrid = document.querySelector(".review-image-diff")!;
  expect(diffGrid.classList.contains("review-image-diff--single")).toBe(false);
  fireEvent.click(screen.getByRole("radio", { name: "修改后" }));
  expect(diffGrid.classList.contains("review-image-diff--single")).toBe(true);
  expect(screen.queryByRole("img", { name: "qr.png · 修改前" })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "并排" }));
  expect(diffGrid.classList.contains("review-image-diff--single")).toBe(false);
  expect(mocks.request).toHaveBeenCalledWith("devbox", {
    method: "preview_change",
    target: {
      kind: "turn",
      session_id: "saved-session",
      request_id: "saved-r",
    },
    path: "qr.png",
    before: false,
    offset: 0,
  });
  expect(
    mocks.request.mock.calls.every(([, req]) =>
      ["turn_change_summary", "preview_change"].includes(req.method),
    ),
  ).toBe(true);
});
async function scope(label: string) {
  fireEvent.click(screen.getByRole("combobox", { name: "变更范围" }));
  fireEvent.click(screen.getByRole("option", { name: label }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "变更范围" }).textContent).toBe(
      label,
    ),
  );
}
it("defaults to the real branch base, filters the right list, routes selected diffs and switches layouts", async () => {
  render(<ChangesView {...props} />);
  await screen.findAllByRole("region", { name: "统一文件差异" });
  expect(mocks.request).toHaveBeenCalledWith("local", {
    method: "git_review",
    project_id: "p",
    scope: "branch",
    base: "refs/remotes/origin/main",
  });
  const list = screen.getByRole("complementary", { name: "变更文件" });
  expect(within(list).getAllByRole("button")).toHaveLength(2);
  fireEvent.change(screen.getByRole("textbox", { name: "筛选文件" }), {
    target: { value: "old" },
  });
  expect(within(list).getAllByRole("button")).toHaveLength(1);
  fireEvent.click(within(list).getByRole("button", { name: /b.ts/ }));
  await waitFor(() =>
    expect(mocks.request).toHaveBeenLastCalledWith(
      "local",
      expect.objectContaining({
        method: "git_review_diff",
        path: "b.ts",
        base: review.base,
        head: review.head,
      }),
    ),
  );
  await screen.findAllByRole("region", { name: "统一文件差异" });
  fireEvent.click(screen.getByRole("button", { name: "并排差异" }));
  expect(
    screen.getAllByRole("region", { name: "并排文件差异" })[0],
  ).toBeTruthy();
  expect(
    screen
      .getAllByRole("region", { name: "并排文件差异" })[0]
      .classList.contains("wrap"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "自动换行" }));
  expect(
    screen
      .getAllByRole("region", { name: "并排文件差异" })[0]
      .classList.contains("wrap"),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "更多差异选项" }));
  fireEvent.click(
    screen.getByRole("menuitemcheckbox", { name: "加载完整文件" }),
  );
  await waitFor(() =>
    expect(mocks.request).toHaveBeenLastCalledWith(
      "local",
      expect.objectContaining({ full_context: true }),
    ),
  );
  await screen.findAllByRole("region", { name: "并排文件差异" });
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "更多差异选项" }));
  expect(
    screen
      .getByRole("menuitemcheckbox", { name: "加载完整文件" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "更多差异选项" }),
  );
  expect(screen.queryByRole("button", { name: "复制 diff" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "文件列表" }));
  expect(screen.queryByRole("complementary")).toBeNull();
});
it("changes comparison scopes and base without submitting agent commands", async () => {
  render(<ChangesView {...props} />);
  await screen.findAllByRole("region", { name: "统一文件差异" });
  fireEvent.click(screen.getByRole("combobox", { name: "比较基准" }));
  fireEvent.change(screen.getByRole("combobox", { name: "搜索分支" }), {
    target: { value: "main" },
  });
  fireEvent.click(screen.getByRole("option", { name: "main" }));
  await waitFor(() =>
    expect(mocks.request).toHaveBeenCalledWith(
      "local",
      expect.objectContaining({
        method: "git_review",
        base: "refs/heads/main",
      }),
    ),
  );
  for (const [label, value] of [
    ["未提交", "worktree"],
    ["未暂存", "unstaged"],
    ["已暂存", "staged"],
  ]) {
    await scope(label);
    await screen.findAllByRole("region", { name: "统一文件差异" });
    expect(mocks.request).toHaveBeenCalledWith(
      "local",
      expect.objectContaining({
        method: "git_review",
        scope: value,
        base: null,
      }),
    );
  }
  fireEvent.click(screen.getByRole("button", { name: "刷新变更" }));
  await waitFor(() =>
    expect(
      mocks.request.mock.calls.filter(([, r]) => r.method === "git_info"),
    ).toHaveLength(2),
  );
  expect(
    mocks.request.mock.calls.every(([, r]) => r.method.startsWith("git_")),
  ).toBe(true);
});
it("fences stale host reads, performs no reads while hidden and reports unsupported servers", async () => {
  let resolve!: (value: unknown) => void;
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = render(<ChangesView {...props} />);
  view.rerender(<ChangesView {...props} hostId="remote" />);
  await screen.findAllByRole("region", { name: "统一文件差异" });
  await act(async () =>
    resolve({ kind: "git_info", info: { ...info, branch: "stale" } }),
  );
  expect(screen.queryByText("stale")).toBeNull();
  const count = mocks.request.mock.calls.length;
  view.rerender(<ChangesView {...props} hostId="remote" active={false} />);
  expect(mocks.request).toHaveBeenCalledTimes(count);
  view.unmount();
  mocks.request.mockResolvedValue({ kind: "ok" });
  render(<ChangesView {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: /^状态提示（/ }));
  expect(
    screen.getByRole("dialog", { name: "状态提示" }).textContent,
  ).toContain("不支持分支审阅");
});
it("distinguishes an empty branch from a filter with no matching files", async () => {
  render(<ChangesView {...props} />);
  await screen.findAllByRole("region", { name: "统一文件差异" });
  fireEvent.change(screen.getByRole("textbox", { name: "筛选文件" }), {
    target: { value: "missing" },
  });
  expect(screen.getByText("没有匹配的文件")).toBeTruthy();
  expect(screen.queryByText("此范围没有变更")).toBeNull();
  mocks.request.mockImplementation(async (_h, req) =>
    req.method === "git_info"
      ? { kind: "git_info", info }
      : {
          kind: "git_review",
          review: { ...review, entries: [], added: 0, removed: 0 },
        },
  );
  fireEvent.click(screen.getByRole("button", { name: "刷新变更" }));
  expect(await screen.findByText("此范围没有变更")).toBeTruthy();
});
const turn: TurnChanges = {
  request_id: "r1",
  undo: "reverted",
  interrupted: true,
  background_pending: true,
  summary: {
    entries: [{ path: "saved.txt", status: "M", added: 2, removed: 1 }],
    added: 2,
    removed: 1,
    binary_files: 0,
    truncated: false,
    baseline_at: 1,
    unavailable: null,
  },
};
it("reads the saved last turn outside Git, preserves its status and refreshes only the snapshot", async () => {
  mocks.request.mockImplementation(async (_host, req) => {
    if (req.method === "git_info") throw new Error("不是 Git 仓库");
    if (req.method === "last_turn_changes")
      return { kind: "last_turn_changes", changes: turn };
    if (req.method === "turn_change_diff")
      return {
        kind: "content",
        text: "@@ -1 +1 @@\n-old\n+saved\n",
        truncated: false,
      };
    throw new Error(`unexpected ${req.method}`);
  });
  const view = render(<ChangesView {...props} sessionId="s1" />);
  await screen.findByRole("button", { name: /^状态提示（/ });
  mocks.request.mockClear();
  await scope("上一轮");
  await screen.findByText("+saved");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText(/本轮修改已撤销/).textContent).toContain(
    "后台任务尚未结束",
  );
  expect(mocks.request).toHaveBeenCalledWith("local", {
    method: "turn_change_diff",
    session_id: "s1",
    request_id: "r1",
    path: "saved.txt",
  });
  fireEvent.click(screen.getByRole("button", { name: "更多差异选项" }));
  expect(
    (
      screen.getByRole("menuitemcheckbox", {
        name: "加载完整文件",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.getByText("回合快照仅保留采集时的上下文。")).toBeTruthy();
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "刷新变更" }));
  await waitFor(() =>
    expect(
      mocks.request.mock.calls.filter(
        ([, req]) => req.method === "last_turn_changes",
      ),
    ).toHaveLength(2),
  );
  await screen.findByText("+saved");
  expect(
    mocks.request.mock.calls.every(([, req]) =>
      ["last_turn_changes", "turn_change_diff"].includes(req.method),
    ),
  ).toBe(true);
  const count = mocks.request.mock.calls.length;
  view.rerender(
    <ChangesView
      {...props}
      sessionId="s1"
      lastTurnVersion="r1"
      active={false}
    />,
  );
  expect(mocks.request).toHaveBeenCalledTimes(count);
});
it("does not invent a last turn when the conversation has no recorded snapshot", async () => {
  render(<ChangesView {...props} />);
  await screen.findAllByRole("region", { name: "统一文件差异" });
  mocks.request.mockClear();
  await scope("上一轮");
  expect(await screen.findByText("当前对话尚无已保存的回合快照")).toBeTruthy();
  expect(mocks.request).not.toHaveBeenCalled();
});
it("uses the server's empty snapshot result and reports unsupported responses", async () => {
  const previous = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation(async (host, req) =>
    req.method === "last_turn_changes"
      ? { kind: "last_turn_changes", changes: null }
      : previous(host, req),
  );
  render(<ChangesView {...props} sessionId="s1" />);
  await screen.findAllByRole("region", { name: "统一文件差异" });
  await scope("上一轮");
  await screen.findByText("当前对话尚无已保存的回合快照");
  expect(mocks.request).toHaveBeenCalledWith("local", {
    method: "last_turn_changes",
    session_id: "s1",
  });
  mocks.request.mockResolvedValue({ kind: "ok" });
  fireEvent.click(screen.getByRole("button", { name: "刷新变更" }));
  fireEvent.click(await screen.findByRole("button", { name: /^状态提示（/ }));
  expect(
    screen.getByRole("dialog", { name: "状态提示" }).textContent,
  ).toContain("不支持回合快照");
});
it("reconciles an undo event for the same last turn without changing its saved diff", async () => {
  let saved = {
    ...turn,
    undo: "ready" as TurnChanges["undo"],
    interrupted: false,
    background_pending: false,
  };
  const previous = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation(async (host, req) =>
    req.method === "last_turn_changes"
      ? { kind: "last_turn_changes", changes: saved }
      : previous(host, req),
  );
  const view = render(
    <ChangesView {...props} sessionId="s1" lastTurnVersion="r1-ready" />,
  );
  await screen.findAllByRole("region", { name: "统一文件差异" });
  await scope("上一轮");
  await within(
    screen.getByRole("complementary", { name: "变更文件" }),
  ).findByRole("button", { name: /saved.txt/ });
  expect(screen.queryByText(/本轮修改已撤销/)).toBeNull();
  saved = { ...saved, undo: "reverted" };
  view.rerender(
    <ChangesView {...props} sessionId="s1" lastTurnVersion="r1-reverted" />,
  );
  await screen.findByText(/本轮修改已撤销/);
  expect(
    mocks.request.mock.calls.filter(
      ([, req]) => req.method === "last_turn_changes",
    ),
  ).toHaveLength(2);
  expect(mocks.request).toHaveBeenCalledWith("local", {
    method: "turn_change_diff",
    session_id: "s1",
    request_id: "r1",
    path: "saved.txt",
  });
});
it.each([false, true])(
  "fences old session snapshots, including empty results (%s)",
  async (empty) => {
    let finish!: (value: unknown) => void;
    mocks.request.mockImplementation(async (_host, req) => {
      if (req.method === "git_info") return { kind: "git_info", info };
      if (req.method === "git_review") return { kind: "git_review", review };
      if (req.method === "last_turn_changes") {
        if (req.session_id === "s1")
          return new Promise((resolve) => {
            finish = resolve;
          });
        return {
          kind: "last_turn_changes",
          changes: { ...turn, request_id: "r2" },
        };
      }
      return {
        kind: "content",
        text: "@@ -1 +1 @@\n+new session\n",
        truncated: false,
      };
    });
    const view = render(
      <ChangesView {...props} sessionId="s1" lastTurnVersion="r1" />,
    );
    await screen.findAllByRole("region", { name: "统一文件差异" });
    await scope("上一轮");
    view.rerender(
      <ChangesView {...props} sessionId="s2" lastTurnVersion="r2" />,
    );
    await screen.findByText("+new session");
    await act(async () =>
      finish({
        kind: "last_turn_changes",
        changes: empty
          ? null
          : {
              ...turn,
              summary: {
                ...turn.summary,
                entries: [
                  { path: "stale.txt", status: "A", added: 1, removed: 0 },
                ],
              },
            },
      }),
    );
    expect(screen.queryByText("stale.txt")).toBeNull();
    expect(screen.getByText("+new session")).toBeTruthy();
    expect(
      mocks.request.mock.calls
        .filter(([, req]) => req.method === "turn_change_diff")
        .map(([, req]) => req),
    ).toEqual([
      {
        method: "turn_change_diff",
        session_id: "s2",
        request_id: "r2",
        path: "saved.txt",
      },
    ]);
  },
);
it("uses one page for a historical snapshot and Git scopes, preserving layout and returning to the exact request", async () => {
  const previous = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation(async (host, req) =>
    req.method === "turn_change_summary"
      ? {
          kind: "turn_changes",
          changes: { ...turn, request_id: req.request_id },
        }
      : previous(host, req),
  );
  render(<ChangesView {...props} sessionId="s1" requestId="historical" />);
  await screen.findAllByRole("region", { name: "统一文件差异" });
  expect(mocks.request).not.toHaveBeenCalledWith(
    "local",
    expect.objectContaining({ method: "git_info" }),
  );
  expect(screen.queryByRole("button", { name: "工作区" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "并排差异" }));
  await scope("未暂存");
  await screen.findAllByRole("region", { name: "并排文件差异" });
  await scope("本轮");
  await screen.findAllByRole("region", { name: "并排文件差异" });
  expect(mocks.request).toHaveBeenCalledWith("local", {
    method: "turn_change_diff",
    session_id: "s1",
    request_id: "historical",
    path: "saved.txt",
  });
  expect(
    mocks.request.mock.calls.every(
      ([, req]) => !["send", "open_agent_session"].includes(req.method),
    ),
  ).toBe(true);
});
it("selects a real commit through the submenu and pins its diff IDs", async () => {
  const previous = mocks.request.getMockImplementation()!;
  const commit = { oid: "c".repeat(40), subject: "Fix review" };
  mocks.request.mockImplementation(async (host, req) =>
    req.method === "git_commits"
      ? {
          kind: "git_commits",
          head: commit.oid,
          commits: [commit],
          has_more: false,
        }
      : previous(host, req),
  );
  render(<ChangesView {...props} />);
  await screen.findAllByRole("region", { name: "统一文件差异" });
  fireEvent.click(screen.getByRole("combobox", { name: "变更范围" }));
  fireEvent.click(screen.getByRole("option", { name: "已提交" }));
  fireEvent.click(await screen.findByRole("option", { name: /Fix review/ }));
  await screen.findAllByRole("region", { name: "统一文件差异" });
  expect(
    screen.getByRole("combobox", { name: "变更范围" }).textContent,
  ).toContain("已提交 · cccccccc");
  expect(mocks.request).toHaveBeenCalledWith("local", {
    method: "git_review",
    project_id: "p",
    scope: "commit",
    base: commit.oid,
  });
  expect(mocks.request).toHaveBeenCalledWith(
    "local",
    expect.objectContaining({
      method: "git_review_diff",
      scope: "commit",
      base: review.base,
      head: review.head,
    }),
  );
});

it("opens a later frozen-file page and replaces page DOM instead of accumulating files", async () => {
  const makeEntry = (n: number) => ({
    path: `src/file-${n}.txt`,
    status: "M",
    added: 1,
    removed: 1,
  });
  mocks.request.mockImplementation(async (_host: string, req: Request) => {
    if (req.method === "turn_change_summary") {
      const offset =
        req.offset ?? Number(req.path?.match(/file-(\d+)/)?.[1] ?? 10000);
      return {
        kind: "turn_changes",
        changes: {
          request_id: "large",
          undo: "ready",
          interrupted: false,
          background_pending: false,
          summary: {
            entries: Array.from({ length: 64 }, (_, n) =>
              makeEntry(n + offset),
            ),
            added: 20000,
            removed: 20000,
            binary_files: 0,
            truncated: false,
            unavailable: null,
            baseline_at: 1,
            total_files: 20000,
            offset,
            next_offset: offset + 64,
          },
        },
      };
    }
    return {
      kind: "content",
      text: "@@ -1 +1 @@\n-old\n+new",
      truncated: false,
    };
  });
  const view = render(
    <ChangesView
      {...props}
      sessionId="s"
      requestId="large"
      initialScope="turn"
      initialPath="src/file-10000.txt"
    />,
  );
  await screen.findByText("文件 10001–10064 / 20000");
  expect(mocks.request).toHaveBeenCalledWith("local", {
    method: "turn_change_summary",
    session_id: "s",
    request_id: "large",
    offset: undefined,
    path: "src/file-10000.txt",
  });
  expect(document.querySelectorAll(".review-file-section")).toHaveLength(64);
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByText("文件 10065–10128 / 20000");
  expect(mocks.request).toHaveBeenCalledWith("local", {
    method: "turn_change_summary",
    session_id: "s",
    request_id: "large",
    offset: 10064,
    path: undefined,
  });
  expect(document.querySelectorAll(".review-file-section")).toHaveLength(64);
  fireEvent.click(screen.getByRole("button", { name: "上一页" }));
  await screen.findByText("文件 10001–10064 / 20000");
  view.rerender(
    <ChangesView
      {...props}
      sessionId="s"
      requestId="large"
      initialScope="turn"
      initialPath="src/file-15000.txt"
    />,
  );
  await screen.findByText("文件 15001–15064 / 20000");
  expect(mocks.request).toHaveBeenCalledWith("local", {
    method: "turn_change_summary",
    session_id: "s",
    request_id: "large",
    offset: undefined,
    path: "src/file-15000.txt",
  });
  expect(document.querySelectorAll(".review-file-section")).toHaveLength(64);
});

it("refreshes git info and branch review when project.path changes for the same project id", async () => {
  let currentBranch = "branch-old";
  let changedPath = "old-dir.ts";
  mocks.request.mockImplementation(async (_host: string, req: Request) => {
    if (req.method === "git_info")
      return {
        kind: "git_info",
        info: { ...info, branch: currentBranch },
      };
    if (req.method === "git_review")
      return {
        kind: "git_review",
        review: {
          ...review,
          entries: [
            {
              path: changedPath,
              previous_path: null,
              status: "M",
              added: 1,
              removed: 0,
              binary: false,
              untracked: false,
            },
          ],
        },
      };
    return {
      kind: "content",
      text: `--- a/${"path" in req ? req.path : ""}\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n`,
      truncated: false,
    };
  });
  const view = render(
    <ChangesView
      hostId="local"
      project={{ id: "p", name: "Project", path: "/dir-old" }}
      active
    />,
  );
  await screen.findByText("branch-old");
  expect((await screen.findAllByText("old-dir.ts")).length).toBeGreaterThan(0);

  currentBranch = "branch-new";
  changedPath = "new-dir.ts";
  view.rerender(
    <ChangesView
      hostId="local"
      project={{ id: "p", name: "Project", path: "/dir-new" }}
      active
    />,
  );
  await screen.findByText("branch-new");
  expect((await screen.findAllByText("new-dir.ts")).length).toBeGreaterThan(0);
});

it("resets commit scope to branch review instead of dereferencing an empty commit when project.path changes", async () => {
  const commit = { oid: "c".repeat(40), subject: "Fix review" };
  let currentBranch = "branch-old";
  let changedPath = "old-dir.ts";
  mocks.request.mockImplementation(async (_host: string, req: Request) => {
    if (req.method === "git_info")
      return {
        kind: "git_info",
        info: { ...info, branch: currentBranch },
      };
    if (req.method === "git_commits")
      return {
        kind: "git_commits",
        head: commit.oid,
        commits: [commit],
        has_more: false,
      };
    if (req.method === "git_review")
      return {
        kind: "git_review",
        review: {
          ...review,
          entries: [
            {
              path: changedPath,
              previous_path: null,
              status: "M",
              added: 1,
              removed: 0,
              binary: false,
              untracked: false,
            },
          ],
        },
      };
    return {
      kind: "content",
      text: `--- a/${"path" in req ? req.path : ""}\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n`,
      truncated: false,
    };
  });
  const view = render(
    <ChangesView
      hostId="local"
      project={{ id: "p", name: "Project", path: "/dir-old" }}
      active
    />,
  );
  await screen.findAllByRole("region", { name: "统一文件差异" });
  fireEvent.click(screen.getByRole("combobox", { name: "变更范围" }));
  fireEvent.click(screen.getByRole("option", { name: "已提交" }));
  fireEvent.click(await screen.findByRole("option", { name: /Fix review/ }));
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "变更范围" }).textContent,
    ).toContain("已提交 · cccccccc"),
  );

  mocks.request.mockClear();
  currentBranch = "branch-new";
  changedPath = "new-dir.ts";
  view.rerender(
    <ChangesView
      hostId="local"
      project={{ id: "p", name: "Project", path: "/dir-new" }}
      active
    />,
  );
  await screen.findByText("branch-new");
  expect((await screen.findAllByText("new-dir.ts")).length).toBeGreaterThan(0);
  expect(
    screen.getByRole("combobox", { name: "变更范围" }).textContent,
  ).not.toContain("已提交");
  expect(mocks.request).toHaveBeenCalledWith("local", {
    method: "git_review",
    project_id: "p",
    scope: "branch",
    base: info.default_base,
  });
});

it("stays silent on pure non-Git folders and falls back to task snapshot when a session is active", async () => {
  const nonGitError = Object.assign(new Error("此项目无 Git 分支信息"), {
    code: "not_git_repository",
  });
  mocks.request.mockImplementation(async (_host: string, req: Request) => {
    if (req.method === "git_info") throw nonGitError;
    if (req.method === "git_repositories")
      return { kind: "git_repositories", repositories: [], truncated: false };
    if (req.method === "change_summary")
      return {
        kind: "change_summary",
        summary: {
          entries: [{ path: "notes.md", status: "M", added: 4, removed: 0 }],
          added: 4,
          removed: 0,
          binary_files: 0,
          truncated: false,
          baseline_at: 1,
          unavailable: null,
        },
      };
    if (req.method === "task_change_diff")
      return {
        kind: "content",
        text: "@@ -0,0 +1,4 @@\n+line\n",
        truncated: false,
      };
    throw new Error(`unexpected ${req.method}`);
  });

  const draftView = render(
    <ChangesView
      hostId="local"
      project={{ id: "plain", name: "Plain", path: "/plain" }}
      active
    />,
  );
  await screen.findByText("此项目及子目录未发现 Git 仓库");
  expect(screen.getByRole("button", { name: "状态提示" })).toBeTruthy();
  draftView.unmount();

  render(
    <ChangesView
      hostId="local"
      project={{ id: "plain", name: "Plain", path: "/plain" }}
      sessionId="s-plain"
      active
    />,
  );
  await screen.findByText("+line");
  expect(screen.getByRole("combobox", { name: "变更范围" }).textContent).toBe(
    "任务净变更",
  );
  expect(screen.getByRole("button", { name: "状态提示" })).toBeTruthy();
});

it("discovers child repositories, submodules and worktrees and switches repo_path across Git scopes", async () => {
  const nonGitError = Object.assign(new Error("此项目无 Git 分支信息"), {
    code: "not_git_repository",
  });
  const commit = { oid: "d".repeat(40), subject: "Worktree commit" };
  mocks.request.mockImplementation(async (_host: string, req: Request) => {
    if (req.method === "git_info" && !req.repo_path) throw nonGitError;
    if (req.method === "git_repositories")
      return {
        kind: "git_repositories",
        repositories: [
          { path: "continue", name: "continue", kind: "repository" },
          {
            path: "continue/vendor/sub",
            name: "continue/vendor/sub",
            kind: "submodule",
          },
          {
            path: ".oh-my-code/worktree/continue/fix-ux",
            name: "continue/fix-ux",
            kind: "worktree",
          },
        ],
        truncated: false,
      };
    if (req.method === "git_info")
      return {
        kind: "git_info",
        info: {
          ...info,
          branch:
            req.repo_path === ".oh-my-code/worktree/continue/fix-ux"
              ? "fix/ux"
              : "main",
        },
      };
    if (req.method === "git_commits")
      return {
        kind: "git_commits",
        head: commit.oid,
        commits: [commit],
        has_more: false,
      };
    if (req.method === "git_review")
      return {
        kind: "git_review",
        review: {
          ...review,
          entries: [
            {
              path:
                req.repo_path === ".oh-my-code/worktree/continue/fix-ux"
                  ? "SideChat.tsx"
                  : "App.tsx",
              previous_path: null,
              status: "M",
              added: 5,
              removed: 1,
              binary: false,
              untracked: false,
            },
          ],
        },
      };
    if (req.method === "git_review_diff")
      return {
        kind: "content",
        text: `@@ -1 +1 @@\n-old\n+${req.repo_path}:${req.path}\n`,
        truncated: false,
      };
    throw new Error(`unexpected ${req.method}`);
  });

  render(
    <ChangesView
      hostId="local"
      project={{ id: "umbrella", name: "latte-co", path: "/latte-co" }}
      active
    />,
  );
  await screen.findByText(
    (_, element) =>
      element?.tagName === "CODE" &&
      element.textContent === "+continue:App.tsx",
  );
  expect(screen.getByRole("button", { name: "状态提示" })).toBeTruthy();

  const repoTrigger = screen.getByRole("combobox", { name: "Git 仓库" });
  expect(repoTrigger.textContent).toContain("continue");
  fireEvent.click(repoTrigger);
  expect(screen.getByText("子模块")).toBeTruthy();
  expect(
    screen.getByText("工作树 · .oh-my-code/worktree/continue/fix-ux"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("option", { name: /continue\/fix-ux/ }));

  await screen.findByText(
    (_, element) =>
      element?.tagName === "CODE" &&
      element.textContent ===
        "+.oh-my-code/worktree/continue/fix-ux:SideChat.tsx",
  );
  expect(screen.getByText("fix/ux")).toBeTruthy();

  fireEvent.click(screen.getByRole("combobox", { name: "变更范围" }));
  fireEvent.click(screen.getByRole("option", { name: "已提交" }));
  fireEvent.click(
    await screen.findByRole("option", { name: /Worktree commit/ }),
  );
  await waitFor(() =>
    expect(mocks.request).toHaveBeenCalledWith("local", {
      method: "git_commits",
      project_id: "umbrella",
      repo_path: ".oh-my-code/worktree/continue/fix-ux",
      head: null,
      offset: 0,
    }),
  );
  expect(mocks.request).toHaveBeenCalledWith("local", {
    method: "git_review",
    project_id: "umbrella",
    scope: "commit",
    base: commit.oid,
    repo_path: ".oh-my-code/worktree/continue/fix-ux",
  });
});

function setupMultiRepoResponses() {
  const list = [
    { path: ".", name: "root", kind: "root" as const },
    { path: "child", name: "child", kind: "repository" as const },
  ];
  mocks.request.mockImplementation(async (_host: string, req: Request) => {
    if (req.method === "git_info") {
      return {
        kind: "git_info",
        info: req.repo_path
          ? {
              ...info,
              default_base: "refs/heads/child-main",
              refs: [
                { name: "child-main", full_name: "refs/heads/child-main" },
              ],
            }
          : { ...info, repositories: list },
      };
    }
    if (req.method === "git_repositories") {
      return { kind: "git_repositories", repositories: list, truncated: false };
    }
    if (req.method === "git_review") {
      return { kind: "git_review", review: { ...review, entries: [] } };
    }
    throw new Error(`unexpected ${req.method}`);
  });
}

it("keeps the repository switcher available when reopening a child repository review", async () => {
  setupMultiRepoResponses();
  const initial = render(<ChangesView {...props} />);
  fireEvent.click(await screen.findByRole("combobox", { name: "Git 仓库" }));
  fireEvent.click(screen.getByRole("option", { name: /child/ }));
  await waitFor(() =>
    expect(mocks.request).toHaveBeenCalledWith(
      "local",
      expect.objectContaining({ method: "git_review", repo_path: "child" }),
    ),
  );
  initial.unmount();
  mocks.request.mockClear();

  render(<ChangesView {...props} />);
  await waitFor(() =>
    expect(mocks.request).toHaveBeenCalledWith(
      "local",
      expect.objectContaining({ method: "git_review", repo_path: "child" }),
    ),
  );
  expect(screen.queryByRole("combobox", { name: "Git 仓库" })).toBeTruthy();
});

it("resets to the newly selected repository default base after switching repositories in a sibling session", async () => {
  const { setSelectedGitRepository } = await import("./gitRepositories");
  setupMultiRepoResponses();
  const view = render(<ChangesView {...props} />);
  await waitFor(() =>
    expect(mocks.request).toHaveBeenCalledWith(
      "local",
      expect.objectContaining({
        method: "git_review",
        base: info.default_base,
      }),
    ),
  );
  view.rerender(<ChangesView {...props} active={false} />);
  act(() => setSelectedGitRepository("local", project, "child"));
  view.rerender(<ChangesView {...props} />);
  await waitFor(() =>
    expect(mocks.request).toHaveBeenCalledWith(
      "local",
      expect.objectContaining({ method: "git_review", repo_path: "child" }),
    ),
  );
  const childReviewCall = mocks.request.mock.calls.find(
    ([, req]) => req.method === "git_review" && req.repo_path === "child",
  );
  expect(childReviewCall?.[1]).toMatchObject({
    base: "refs/heads/child-main",
  });
});

it.each(["timeout", "truncated"] as const)(
  "does not declare a project repository-free after incomplete discovery (%s)",
  async (mode) => {
    mocks.request.mockImplementation(async (_host: string, req: Request) => {
      if (req.method === "git_info") {
        throw Object.assign(new Error("no root"), {
          code: "not_git_repository",
        });
      }
      if (req.method === "git_repositories") {
        if (mode === "timeout") {
          throw Object.assign(new Error("扫描 Git 仓库超时"), {
            code: "request_failed",
          });
        }
        return { kind: "git_repositories", repositories: [], truncated: true };
      }
      throw new Error(`unexpected ${req.method}`);
    });
    render(<ChangesView {...props} />);
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        "local",
        expect.objectContaining({ method: "git_repositories" }),
      ),
    );
    await waitFor(() => expect(screen.queryByText("正在读取变更…")).toBeNull());
    expect(screen.queryByText("此项目及子目录未发现 Git 仓库")).toBeNull();
  },
);

it("preserves exact child repository paths with leading or trailing spaces", async () => {
  const {
    setSelectedGitRepository,
    getSelectedGitRepository,
    normalizeGitRepoPath,
  } = await import("./gitRepositories");
  setSelectedGitRepository("local", project, " child");
  expect(normalizeGitRepoPath(getSelectedGitRepository("local", project))).toBe(
    " child",
  );
});

it("recovers and keeps the repository switcher available after the selected worktree has been removed", async () => {
  const { setSelectedGitRepository, getSelectedGitRepository } =
    await import("./gitRepositories");
  setSelectedGitRepository("local", project, "old-worktree");
  const list = [
    { path: ".", name: "root", kind: "root" as const },
    { path: "other", name: "other", kind: "repository" as const },
  ];
  mocks.request.mockImplementation(async (_host: string, req: Request) => {
    if (req.method === "git_info" && req.repo_path === "old-worktree") {
      throw Object.assign(new Error("子仓库目录不存在"), {
        code: "request_failed",
      });
    }
    if (req.method === "git_info") {
      return { kind: "git_info", info: { ...info, repositories: list } };
    }
    if (req.method === "git_repositories") {
      return { kind: "git_repositories", repositories: list, truncated: false };
    }
    if (req.method === "git_review") {
      return { kind: "git_review", review: { ...review, entries: [] } };
    }
    throw new Error(`unexpected ${req.method}`);
  });
  render(<ChangesView {...props} />);
  expect(
    await screen.findByRole("combobox", { name: "Git 仓库" }),
  ).toBeTruthy();
  await waitFor(() =>
    expect(mocks.request).toHaveBeenCalledWith(
      "local",
      expect.objectContaining({ method: "git_review" }),
    ),
  );
  expect(getSelectedGitRepository("local", project)).toBe(".");
});

it("keeps the repository switcher rendered when git_info fails on an existing child repository", async () => {
  const { setSelectedGitRepository } = await import("./gitRepositories");
  setSelectedGitRepository("local", project, "child");
  const list = [
    { path: ".", name: "root", kind: "root" as const },
    { path: "child", name: "child", kind: "repository" as const },
  ];
  mocks.request.mockImplementation(async (_host: string, req: Request) => {
    if (req.method === "git_info" && req.repo_path === "child") {
      throw Object.assign(new Error("读取 Git 分支超时"), {
        code: "request_failed",
      });
    }
    if (req.method === "git_info") {
      return { kind: "git_info", info: { ...info, repositories: list } };
    }
    if (req.method === "git_repositories") {
      return { kind: "git_repositories", repositories: list, truncated: false };
    }
    if (req.method === "git_review") {
      return { kind: "git_review", review: { ...review, entries: [] } };
    }
    throw new Error(`unexpected ${req.method}`);
  });
  render(<ChangesView {...props} />);
  expect(await screen.findByText(/读取 Git 分支超时/)).toBeTruthy();
  const switcher = await screen.findByRole("combobox", { name: "Git 仓库" });
  fireEvent.click(switcher);
  fireEvent.click(screen.getByRole("option", { name: /root/ }));
  await waitFor(() =>
    expect(mocks.request).toHaveBeenCalledWith(
      "local",
      expect.objectContaining({
        method: "git_review",
        base: info.default_base,
      }),
    ),
  );
});

it("preserves the selected child repository and avoids silent fallback when discovery is truncated", async () => {
  const { setSelectedGitRepository, getSelectedGitRepository } =
    await import("./gitRepositories");
  setSelectedGitRepository("local", project, "still-valid");
  const list = [
    { path: ".", name: "root", kind: "root" as const },
    { path: "other", name: "other", kind: "repository" as const },
  ];
  mocks.request.mockImplementation(async (_host: string, req: Request) => {
    if (req.method === "git_info" && req.repo_path === "still-valid") {
      throw Object.assign(new Error("Git 元数据超出读取上限，请缩小项目范围"), {
        code: "request_failed",
      });
    }
    if (req.method === "git_info") {
      return { kind: "git_info", info: { ...info, repositories: list } };
    }
    if (req.method === "git_repositories") {
      return { kind: "git_repositories", repositories: list, truncated: true };
    }
    if (req.method === "git_review") {
      return { kind: "git_review", review: { ...review, entries: [] } };
    }
    throw new Error(`unexpected ${req.method}`);
  });
  render(<ChangesView {...props} />);
  expect(
    await screen.findByText(/Git 元数据超出读取上限，请缩小项目范围/),
  ).toBeTruthy();
  const switcher = await screen.findByRole("combobox", { name: "Git 仓库" });
  expect(getSelectedGitRepository("local", project)).toBe("still-valid");
  expect(mocks.request).not.toHaveBeenCalledWith(
    "local",
    expect.objectContaining({ method: "git_review" }),
  );

  // User can still explicitly switch to another discovered repository.
  fireEvent.click(switcher);
  fireEvent.click(screen.getByRole("option", { name: /root/ }));
  await waitFor(() =>
    expect(mocks.request).toHaveBeenCalledWith(
      "local",
      expect.objectContaining({ method: "git_review" }),
    ),
  );
  expect(getSelectedGitRepository("local", project)).toBe(".");
});

it("does not silently switch to a partial-scan repository even when the selected child is missing under truncated discovery", async () => {
  const { setSelectedGitRepository, getSelectedGitRepository } =
    await import("./gitRepositories");
  setSelectedGitRepository("local", project, "removed-wt");
  const list = [
    { path: ".", name: "root", kind: "root" as const },
    { path: "other", name: "other", kind: "repository" as const },
  ];
  mocks.request.mockImplementation(async (_host: string, req: Request) => {
    if (req.method === "git_info" && req.repo_path === "removed-wt") {
      throw Object.assign(new Error("子仓库目录不存在"), {
        code: "request_failed",
      });
    }
    if (req.method === "git_repositories") {
      return { kind: "git_repositories", repositories: list, truncated: true };
    }
    throw new Error(`unexpected ${req.method}`);
  });
  render(<ChangesView {...props} />);
  expect(await screen.findByText(/子仓库目录不存在/)).toBeTruthy();
  expect(
    await screen.findByRole("combobox", { name: "Git 仓库" }),
  ).toBeTruthy();
  expect(getSelectedGitRepository("local", project)).toBe("removed-wt");
});

it("keeps the selected child repository instead of switching to a sibling when access is denied", async () => {
  const { setSelectedGitRepository, getSelectedGitRepository } =
    await import("./gitRepositories");
  setSelectedGitRepository("local", project, "group-a/child");
  const list = [
    { path: "group-b", name: "group-b", kind: "repository" as const },
  ];
  mocks.request.mockImplementation(async (_host: string, req: Request) => {
    if (req.method === "git_info" && req.repo_path === "group-a/child") {
      throw Object.assign(new Error("无权访问子仓库目录"), {
        code: "request_failed",
      });
    }
    if (req.method === "git_repositories") {
      return { kind: "git_repositories", repositories: list, truncated: true };
    }
    throw new Error(`unexpected ${req.method}`);
  });
  render(<ChangesView {...props} />);
  expect(await screen.findByText(/无权访问子仓库目录/)).toBeTruthy();
  expect(
    await screen.findByRole("combobox", { name: "Git 仓库" }),
  ).toBeTruthy();
  expect(getSelectedGitRepository("local", project)).toBe("group-a/child");
});
