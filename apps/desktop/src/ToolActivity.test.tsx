// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolGroup, ToolRow } from "./ToolActivity";
import type { ToolActivity } from "./activity";
import type { ContentEncoding } from "./protocol";

const streamEventContent = vi.fn();
vi.mock("./eventContent", () => ({
  streamEventContent: (...args: unknown[]) => streamEventContent(...args),
  reassembleFullContent: (encoding: ContentEncoding, content: string) =>
    encoding === "text"
      ? content
      : JSON.stringify(JSON.parse(content), null, 2),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const previewed: ToolActivity = {
  key: 2,
  type: "tool",
  name: "Bash",
  input: { command: "python3 dump.py" },
  output: "预览头部…（内容过大，已截断）",
  load: { seq: 2, size: 679_286 },
  status: "completed",
};

describe("ToolRow load-full streaming", () => {
  it("offers the full payload for previewed results and streams chunks into the output", async () => {
    streamEventContent.mockImplementation(
      async (
        _target: unknown,
        onChunk: (p: {
          accumulated: string;
          received: number;
          total: number;
        }) => void,
      ) => {
        onChunk({
          accumulated: "前 512KiB",
          received: 524_288,
          total: 679_286,
        });
        onChunk({
          accumulated: "前 512KiB·尾部",
          received: 679_286,
          total: 679_286,
        });
        return { encoding: "text", content: "前 512KiB·尾部" };
      },
    );
    render(
      <ToolRow
        tool={previewed}
        loadContext={{ hostId: "h", sessionId: "s" }}
      />,
    );
    const button = screen.getByText(/加载完整内容/);
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText(/100%/)).toBeTruthy());
    expect(streamEventContent).toHaveBeenCalledWith(
      { hostId: "h", sessionId: "s", seq: 2 },
      expect.any(Function),
    );
    expect(screen.getByText("前 512KiB·尾部")).toBeTruthy();
    expect(screen.queryByText(/加载完整内容/)).toBeNull();
  });

  it("keeps the preview and surfaces an error when streaming fails", async () => {
    streamEventContent.mockRejectedValue(new Error("事件内容游标无效"));
    render(
      <ToolRow
        tool={previewed}
        loadContext={{ hostId: "h", sessionId: "s" }}
      />,
    );
    fireEvent.click(screen.getByText(/加载完整内容/));
    await waitFor(() =>
      expect(screen.getByText(/加载失败：事件内容游标无效/)).toBeTruthy(),
    );
    expect(screen.getByText(/预览头部/)).toBeTruthy();
    expect(screen.getByText(/加载完整内容/)).toBeTruthy();
  });

  it("renders no affordance without load identity or context", () => {
    const { rerender } = render(<ToolRow tool={previewed} />);
    expect(screen.queryByText(/加载完整内容/)).toBeNull();
    rerender(
      <ToolRow
        tool={{ ...previewed, load: undefined }}
        loadContext={{ hostId: "h", sessionId: "s" }}
      />,
    );
    expect(screen.queryByText(/加载完整内容/)).toBeNull();
  });
});

describe("ToolRow mid-stream failure", () => {
  it("restores the preview and the retry affordance after a later chunk fails", async () => {
    streamEventContent.mockImplementation(
      async (
        _target: unknown,
        onChunk: (p: {
          encoding: "text";
          accumulated: string;
          received: number;
          total: number;
        }) => void,
      ) => {
        onChunk({
          encoding: "text",
          accumulated: "第一块",
          received: 4,
          total: 679_286,
        });
        throw new Error("服务已重启");
      },
    );
    render(
      <ToolRow
        tool={previewed}
        loadContext={{ hostId: "h", sessionId: "s" }}
      />,
    );
    fireEvent.click(screen.getByText(/加载完整内容/));
    await waitFor(() =>
      expect(screen.getByText(/加载失败：服务已重启/)).toBeTruthy(),
    );
    // Progress display ended, preview came back, and the retry button is
    // available again.
    expect(screen.queryByText(/正在流式加载/)).toBeNull();
    expect(screen.getByText(/预览头部/)).toBeTruthy();
    const retry = screen.getByText(/加载完整内容/);
    expect((retry as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("ToolRow and ToolGroup semantic presentation", () => {
  it("renders Bash prompt and Edit diff wells without raw JSON input headers, and scopes failure styling to status badge", () => {
    const failedBash: ToolActivity = {
      key: 10,
      type: "tool",
      name: "Bash",
      input: {
        command: "cargo test --locked",
        description: "Run workspace tests",
      },
      output: "exit code 1",
      status: "failed",
    };
    const { container, rerender } = render(<ToolRow tool={failedBash} />);
    const row = container.querySelector(".activity-row")!;
    expect(row.classList.contains("failure")).toBe(false);
    expect(screen.getByText("失败").classList.contains("failure")).toBe(true);
    expect(screen.getByText("cargo test --locked")).toBeTruthy();
    expect(screen.queryByText("输入")).toBeNull();

    const editTool: ToolActivity = {
      key: 11,
      type: "tool",
      name: "Edit",
      input: {
        file_path: "/repo/apps/desktop/src/App.tsx",
        old_string: "const oldVal = 1;",
        new_string: "const newVal = 2;\nconst extra = 3;",
      },
      output: "updated",
      status: "completed",
    };
    rerender(<ToolRow tool={editTool} />);
    expect(screen.getByText("已编辑")).toBeTruthy();
    expect(screen.getByText("const newVal = 2;")).toBeTruthy();
    expect(screen.queryByText(/old_string/)).toBeNull();

    rerender(
      <ToolGroup
        tools={[
          { ...editTool, key: 1 },
          { ...editTool, key: 2 },
          { ...editTool, key: 3 },
          { ...editTool, key: 4 },
        ]}
      />,
    );
    expect(screen.getByText("· 4 步")).toBeTruthy();
  });

  it("expands truncated 101-line Write inputs, reveals saved non-chunked Edit results, and avoids completed phrasing on unconfirmed ToolGroups", () => {
    const lines = Array.from({ length: 101 }, (_, i) => `write-line-${i + 1}`);
    const largeWrite: ToolActivity = {
      key: 30,
      type: "tool",
      name: "Write",
      input: {
        file_path: "/repo/generated.ts",
        content: lines.join("\n"),
      },
      output: "Wrote 101 lines (trailing newline normalized)",
      status: "completed",
    };

    const { rerender } = render(<ToolRow tool={largeWrite} />);
    expect(screen.getByText("write-line-80")).toBeTruthy();
    expect(screen.queryByText("write-line-101")).toBeNull();
    expect(screen.getByText(/已折叠其余 21 行变更预览/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "查看完整输入" }));
    expect(screen.getByText("write-line-101")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "收起完整输入" }));
    expect(screen.queryByText("write-line-101")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "查看结果" }));
    expect(
      screen.getByText("Wrote 101 lines (trailing newline normalized)"),
    ).toBeTruthy();

    rerender(
      <ToolGroup
        tools={[
          { ...largeWrite, key: 31, output: undefined, status: "unconfirmed" },
          { ...largeWrite, key: 32, output: undefined, status: "unconfirmed" },
        ]}
      />,
    );
    expect(screen.getByText("发起写入 2 次")).toBeTruthy();
    expect(screen.getAllByText("结果待确认")).toHaveLength(3);
    expect(screen.queryByText(/编辑了/)).toBeNull();
  });

  it("exposes full saved Edit input (including long context and replace_all) and separates multi-hunk Edit previews", () => {
    const beforeLines = Array.from({ length: 101 }, (_, i) => `ctx-${i + 1}`);
    const singleMidAfter = [...beforeLines];
    singleMidAfter[50] = "ctx-51-updated";

    const editWithReplaceAll: ToolActivity = {
      key: 40,
      type: "tool",
      name: "Edit",
      input: {
        file_path: "/repo/src/config.ts",
        old_string: beforeLines.join("\n"),
        new_string: singleMidAfter.join("\n"),
        replace_all: true,
      },
      output: "Replaced 3 occurrences",
      status: "completed",
    };

    const { rerender } = render(<ToolRow tool={editWithReplaceAll} />);
    expect(screen.getByText("全部替换")).toBeTruthy();
    expect(screen.getByText("ctx-51-updated")).toBeTruthy();
    expect(screen.queryByText(/ctx-1\\n/)).toBeNull();
    expect(screen.queryByText(/"replace_all": true/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "查看完整输入" }));
    const rawInputPre = screen.getByText(/"replace_all": true/);
    expect(rawInputPre.textContent).toContain("ctx-1\\n");
    expect(rawInputPre.textContent).toContain("ctx-101");

    fireEvent.click(screen.getByRole("button", { name: "收起完整输入" }));
    expect(screen.queryByText(/"replace_all": true/)).toBeNull();

    const twoHunkAfter = [...beforeLines];
    twoHunkAfter[1] = "ctx-2-updated";
    twoHunkAfter[99] = "ctx-100-updated";
    rerender(
      <ToolRow
        tool={{
          key: 41,
          type: "tool",
          name: "Edit",
          input: {
            file_path: "/repo/src/multi.ts",
            old_string: beforeLines.join("\n"),
            new_string: twoHunkAfter.join("\n"),
          },
          status: "completed",
        }}
      />,
    );
    expect(screen.getByText("ctx-2-updated")).toBeTruthy();
    expect(screen.getByText("ctx-100-updated")).toBeTruthy();
    expect(screen.getByText("⋯")).toBeTruthy();
    expect(screen.queryByText("ctx-50")).toBeNull();
    expect(screen.getAllByText("+2").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("-2").length).toBeGreaterThanOrEqual(1);
  });

  it("preserves kept middle blocks beyond 512 edits, labels budget-exceeded fallbacks as simplified, and caps Edit diff DOM at 80 lines when expanding raw input", () => {
    const kept = Array.from({ length: 900 }, (_, i) => `kept-line-${i + 1}`);
    const inserted = Array.from({ length: 511 }, (_, i) => `ins-line-${i + 1}`);
    const { container, rerender } = render(
      <ToolRow
        tool={{
          key: 50,
          type: "tool",
          name: "Edit",
          input: {
            file_path: "/repo/src/preserved.ts",
            old_string: [...kept, "final-old"].join("\n"),
            new_string: [...inserted, ...kept, "final-new"].join("\n"),
          },
          status: "completed",
        }}
      />,
    );
    const firstDiffLine = container.querySelector(".activity-diff-line")!;
    expect(firstDiffLine.classList.contains("is-add")).toBe(true);
    expect(firstDiffLine.textContent).toContain("ins-line-1");
    expect(screen.queryByText("差异已简化")).toBeNull();
    expect(screen.getAllByText("+512").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("-1").length).toBeGreaterThanOrEqual(1);

    // Moving 1 comment from top to bottom of 300 kept lines renders +1/-1, not +300/-300
    const body300 = Array.from({ length: 300 }, (_, i) => `  row: ${i % 5},`);
    rerender(
      <ToolRow
        tool={{
          key: 505,
          type: "tool",
          name: "Edit",
          input: {
            file_path: "/repo/src/moved.ts",
            old_string: ["// relocated-note", ...body300].join("\n"),
            new_string: [...body300, "// relocated-note"].join("\n"),
          },
          status: "completed",
        }}
      />,
    );
    expect(screen.queryByText("差异已简化")).toBeNull();
    expect(screen.getAllByText("+1").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("-1").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("+300")).toBeNull();

    // 2,000-line interleaved replacement: expanding raw input must NOT inflate .activity-diff-line beyond 80 rows
    const replace2000Old = Array.from({ length: 2000 }, (_, i) =>
      i % 2 === 0 ? "}" : `old-bulk-${i + 1}`,
    );
    const replace2000New = Array.from({ length: 2000 }, (_, i) =>
      i % 2 === 0 ? "}" : `new-bulk-${i + 1}`,
    );
    rerender(
      <ToolRow
        tool={{
          key: 51,
          type: "tool",
          name: "Edit",
          input: {
            file_path: "/repo/src/massive.ts",
            old_string: replace2000Old.join("\n"),
            new_string: replace2000New.join("\n"),
          },
          status: "completed",
        }}
      />,
    );
    expect(container.querySelectorAll(".activity-diff-line")).toHaveLength(80);
    expect(screen.getAllByText("差异已简化").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector(".ui-diff-stat")).toBeNull();
    expect(
      screen.getByText(/变更超出精确比对上限，以下按整段旧值与新值简化展示/),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "查看完整输入" }));
    expect(container.querySelectorAll(".activity-diff-line")).toHaveLength(80);
    const rawPre = screen.getByText(/new-bulk-2000/);
    expect(rawPre.textContent).toContain("old-bulk-2000");
  });
});
