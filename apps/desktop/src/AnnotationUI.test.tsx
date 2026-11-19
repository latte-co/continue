// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AnnotatedMessage, AnnotationSummary } from "./AnnotationUI";
import type { Annotation } from "./annotations";
import { useState } from "react";
import { MessageActionsProvider } from "./MessageContent";
import { copyText } from "./clipboard";
vi.mock("./clipboard", () => ({
  copyText: vi.fn().mockResolvedValue(undefined),
}));
const rect = {
  left: 100,
  right: 240,
  top: 280,
  bottom: 300,
  width: 140,
  height: 20,
  x: 100,
  y: 280,
  toJSON: () => ({}),
};
beforeEach(() => {
  vi.mocked(copyText).mockResolvedValue(undefined);
  Range.prototype.getBoundingClientRect = () => rect;
  Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
});
function select(node: HTMLElement) {
  fireEvent.pointerDown(node);
  fireEvent.mouseDown(node, { clientX: 0, clientY: 0 });
  const range = document.createRange();
  range.selectNodeContents(node);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  fireEvent.mouseUp(node, { clientX: 20, clientY: 0 });
}
const base: Annotation = {
  id: "one",
  quote: "原文",
  comment: "建议",
  source: { message: 2, start: 0, end: 2 },
};
it("selects, allows submitting without a comment, cancels without saving, and supports IME", () => {
  const save = vi.fn().mockReturnValue(null);
  render(
    <AnnotatedMessage
      text="这是一段**原文**。"
      message={2}
      entries={[]}
      enabled
      onSave={save}
      onRemove={vi.fn()}
    />,
  );
  select(screen.getByText("原文"));
  fireEvent.click(screen.getByRole("menuitem", { name: "添加注释" }));
  const input = screen.getByRole("textbox", { name: "添加可选评论" });
  expect(document.activeElement).toBe(input);
  expect(
    (screen.getByRole("button", { name: "提交注释" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  fireEvent.change(input, { target: { value: "  修改这里  " } });
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.keyDown(input, { key: "Enter", metaKey: true });
  expect(save).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(save).not.toHaveBeenCalled();

  // Submitting without typing a user comment saves a quote-only annotation.
  select(screen.getByText("原文"));
  fireEvent.click(screen.getByRole("menuitem", { name: "添加注释" }));
  expect(
    document.querySelector(".annotation-marker-pending")?.textContent,
  ).toBe("1");
  fireEvent.click(screen.getByRole("button", { name: "提交注释" }));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      quote: "原文",
      comment: "",
      source: { message: 2, start: 4, end: 6 },
    }),
  );

  // Submitting with a comment via Enter trims and saves it; Shift+Enter inserts a newline without submitting.
  save.mockClear();
  select(screen.getByText("原文"));
  fireEvent.click(screen.getByRole("menuitem", { name: "添加注释" }));
  const nextInput = screen.getByRole("textbox", { name: "添加可选评论" });
  fireEvent.change(nextInput, {
    target: { value: "  修改这里  " },
  });
  fireEvent.keyDown(nextInput, { key: "Enter", shiftKey: true });
  expect(save).not.toHaveBeenCalled();
  fireEvent.keyDown(nextInput, { key: "Enter" });
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      quote: "原文",
      comment: "修改这里",
      source: { message: 2, start: 4, end: 6 },
    }),
  );
});
it("edits, removes and clears draft comments, omits empty comment labels, and hides mutation actions in history", () => {
  function Harness() {
    const [entries, setEntries] = useState([
      { ...base, comment: "" },
      { ...base, id: "two", comment: "第二条" },
    ]);
    return (
      <AnnotationSummary
        entries={entries}
        onSave={(a) => {
          setEntries(entries.map((e) => (e.id === a.id ? a : e)));
          return null;
        }}
        onRemove={(id) => setEntries(entries.filter((a) => a.id !== id))}
        onClear={() => setEntries([])}
      />
    );
  }
  const view = render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "2 条注释" }));
  expect(screen.getAllByText("所选文本：")).toHaveLength(2);
  expect(screen.getAllByText("用户评论：")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "编辑注释 2" }));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "新建议" },
  });
  fireEvent.click(screen.getByRole("button", { name: "提交注释" }));
  fireEvent.click(screen.getByRole("button", { name: "2 条注释" }));
  expect(screen.getByText("新建议")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "删除注释 1" }));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "1 条注释" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "移除全部注释" }));
  expect(screen.queryByRole("button", { name: /条注释/ })).toBeNull();
  view.unmount();
  render(
    <AnnotationSummary
      entries={[
        { ...base, comment: "" },
        { ...base, id: "two", comment: "建议" },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "2 条注释" }));
  expect(screen.getByText("建议")).toBeTruthy();
  expect(screen.getAllByText("用户评论：")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: /编辑|删除|移除/ })).toBeNull();
});
it("dismisses stale selection on scroll and hide, and reuses the side-chat callback", () => {
  const side = vi.fn();
  const props = {
    text: "原文",
    message: 2,
    entries: [],
    enabled: true,
    onSave: vi.fn(),
    onRemove: vi.fn(),
    askInSideChat: side,
  };
  const view = render(<AnnotatedMessage {...props} />);
  select(screen.getByText("原文"));
  fireEvent.scroll(window);
  expect(screen.queryByRole("menu")).toBeNull();
  select(screen.getByText("原文"));
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
  select(screen.getByText("原文"));
  fireEvent.click(screen.getByRole("menuitem", { name: "在侧边聊天中提问" }));
  expect(side).toHaveBeenCalledWith("原文");
  select(screen.getByText("原文"));
  fireEvent.click(screen.getByRole("menuitem", { name: "添加注释" }));
  view.rerender(<AnnotatedMessage {...props} enabled={false} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(props.onSave).not.toHaveBeenCalled();
});
it("preserves comments when validation fails and traps Tab inside the editor", () => {
  render(<AnnotationSummary entries={[base]} onSave={() => "内容过长"} />);
  fireEvent.click(screen.getByRole("button", { name: "1 条注释" }));
  fireEvent.click(screen.getByRole("button", { name: "编辑注释 1" }));
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "保留编辑" } });
  fireEvent.click(screen.getByRole("button", { name: "提交注释" }));
  expect(screen.getByRole("alert").textContent).toBe("内容过长");
  expect((input as HTMLTextAreaElement).value).toBe("保留编辑");
  act(() => screen.getByRole("button", { name: "提交注释" }).focus());
  fireEvent.keyDown(document, { key: "Tab" });
  expect(document.activeElement).toBe(input);
});

it("keeps same-line annotation markers individually accessible and rejects a changed anchor", () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    rect as DOMRect,
  );
  const entries = [base, { ...base, id: "two", comment: "另一条" }];
  const view = render(
    <AnnotatedMessage
      text="原文"
      message={2}
      entries={entries}
      enabled
      onSave={vi.fn()}
      onRemove={vi.fn()}
    />,
  );
  const first = screen.getByRole("button", { name: "编辑注释 1" });
  const second = screen.getByRole("button", { name: "编辑注释 2" });
  expect(first.style.top).not.toBe(second.style.top);
  view.rerender(
    <AnnotatedMessage
      text="改变"
      message={2}
      entries={entries}
      enabled
      onSave={vi.fn()}
      onRemove={vi.fn()}
    />,
  );
  expect(screen.queryByRole("button", { name: "编辑注释 1" })).toBeNull();
});

it("supports keyboard selection and rejects a stale selection after it moves to another message", () => {
  render(
    <>
      <AnnotatedMessage
        text="原文"
        message={2}
        entries={[]}
        enabled
        onSave={vi.fn()}
        onRemove={vi.fn()}
        askInSideChat={vi.fn()}
      />
      <p>外部文字</p>
    </>,
  );
  const node = screen.getByText("原文");
  const range = document.createRange();
  range.selectNodeContents(node);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  fireEvent.keyUp(node, { key: "Shift" });
  const add = screen.getByRole("menuitem", { name: "添加注释" });
  act(() => add.focus());
  fireEvent.keyDown(add, { key: "ArrowRight" });
  expect(document.activeElement).toBe(
    screen.getByRole("menuitem", { name: "在侧边聊天中提问" }),
  );
  range.selectNodeContents(screen.getByText("外部文字"));
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  expect(screen.queryByRole("menu")).toBeNull();
});

it("does not navigate a linked caption on selection", () => {
  render(
    <AnnotatedMessage
      text="阅读 [说明](https://example.com)"
      message={2}
      entries={[]}
      enabled
      onSave={vi.fn()}
      onRemove={vi.fn()}
    />,
  );
  const link = screen.getByRole("link", { name: "说明" });
  const activation = vi.fn();
  // Bubble evidence avoids opening any actual browser tab in the test.
  const parent = link.closest("article")!;
  parent.addEventListener("click", activation);
  select(link);
  fireEvent.click(link, { detail: 1 });
  expect(activation).not.toHaveBeenCalled();
  expect(screen.getByRole("menuitem", { name: "添加注释" })).toBeTruthy();
  parent.removeEventListener("click", activation);
});

it.each(["escape", "outside", "save"])(
  "keeps copy, file and keyboard actions usable after %s",
  async (action) => {
    vi.mocked(copyText).mockClear();
    const openFile = vi.fn();
    render(
      <MessageActionsProvider value={{ openFile }}>
        <AnnotatedMessage
          text={"原文\n\n`src/main.rs`\n\n```rs\nlet a = 1;\n```"}
          message={2}
          entries={[]}
          enabled
          onSave={() => null}
          onRemove={vi.fn()}
        />
      </MessageActionsProvider>,
    );
    select(screen.getByText("原文"));
    if (action === "escape") fireEvent.keyDown(document, { key: "Escape" });
    else {
      fireEvent.click(screen.getByRole("menuitem", { name: "添加注释" }));
      if (action === "outside") {
        fireEvent.pointerDown(document.querySelector(".annotation-backdrop")!);
      } else {
        fireEvent.change(screen.getByRole("textbox"), {
          target: { value: "建议" },
        });
        fireEvent.click(screen.getByRole("button", { name: "提交注释" }));
      }
      expect(window.getSelection()?.toString()).toBe("");
    }
    // Recreate a retained prose selection to cover browsers that keep it across
    // button focus and keyboard activation.
    const range = document.createRange();
    range.selectNodeContents(screen.getByText("原文"));
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.click(screen.getByRole("button", { name: "复制代码" }), {
      detail: 1,
    });
    expect(copyText).toHaveBeenCalledWith("let a = 1;");
    const file = screen.getByRole("button", {
      name: "在工作区中打开，右键查看更多操作",
    });
    fireEvent.pointerDown(file);
    fireEvent.mouseDown(file);
    fireEvent.mouseUp(file);
    fireEvent.click(file, { detail: 1 });
    act(() => file.focus());
    fireEvent.keyDown(file, { key: "Enter" });
    fireEvent.click(file, { detail: 0 });
    expect(openFile).toHaveBeenCalledTimes(2);
    await act(async () => {});
  },
);

it("suppresses only a selecting gesture's release, not a second click or keyboard activation", () => {
  const openFile = vi.fn();
  render(
    <MessageActionsProvider value={{ openFile }}>
      <AnnotatedMessage
        text="`src/main.rs`"
        message={2}
        entries={[]}
        enabled
        onSave={() => null}
        onRemove={vi.fn()}
      />
    </MessageActionsProvider>,
  );
  const control = screen.getByRole("button");
  // Select only text, avoiding the decorative icon in the caption.
  fireEvent.mouseDown(control, { clientX: 0 });
  const range = document.createRange();
  range.selectNodeContents(control.lastChild!);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  fireEvent.mouseUp(control, { clientX: 20 });
  fireEvent.click(control, { detail: 1 });
  expect(openFile).not.toHaveBeenCalled();
  fireEvent.click(control, { detail: 1 });
  expect(openFile).toHaveBeenCalledTimes(1);
  // A fresh ordinary click on the same caption with the old selection still
  // present is not a new selecting gesture.
  fireEvent.pointerDown(control);
  fireEvent.mouseDown(control, { clientX: 10 });
  fireEvent.mouseUp(control, { clientX: 10 });
  fireEvent.click(control, { detail: 1 });
  expect(openFile).toHaveBeenCalledTimes(2);
  fireEvent.mouseDown(control, { clientX: 0 });
  fireEvent.mouseUp(control, { clientX: 20 });
  fireEvent.keyDown(control, { key: "Enter" });
  fireEvent.click(control, { detail: 0 });
  expect(openFile).toHaveBeenCalledTimes(3);
});

it.each(["outside", "提交注释", "Escape"])(
  "restores a surviving annotation marker after %s",
  async (action) => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      rect as DOMRect,
    );
    render(
      <AnnotatedMessage
        text="原文"
        message={2}
        entries={[base]}
        enabled
        onSave={() => null}
        onRemove={vi.fn()}
      />,
    );
    const marker = screen.getByRole("button", { name: "编辑注释 1" });
    fireEvent.click(marker);
    if (action === "Escape")
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    else if (action === "outside")
      fireEvent.pointerDown(document.querySelector(".annotation-backdrop")!);
    else fireEvent.click(screen.getByRole("button", { name: action }));
    await act(async () => {});
    expect(document.activeElement).toBe(marker);
  },
);

it("does not steal focus from the activated side-chat composer", async () => {
  const side = vi.fn(() =>
    screen.getByRole("textbox", { name: "侧聊" }).focus(),
  );
  render(
    <>
      <AnnotatedMessage
        text="原文"
        message={2}
        entries={[]}
        enabled
        onSave={() => null}
        onRemove={vi.fn()}
        askInSideChat={side}
      />
      <textarea aria-label="侧聊" />
    </>,
  );
  select(screen.getByText("原文"));
  fireEvent.click(screen.getByRole("menuitem", { name: "在侧边聊天中提问" }));
  await act(async () => {});
  expect(side).toHaveBeenCalledWith("原文");
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "侧聊" }),
  );
  expect(window.getSelection()?.toString()).toBe("");
});
