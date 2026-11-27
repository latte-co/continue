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
it("edits inline inside the summary popover, keeps Escape working after item removal, and restores composer focus on clear", async () => {
  function Harness() {
    const [entries, setEntries] = useState([
      { ...base, comment: "" },
      { ...base, id: "two", quote: "第二处原文", comment: "第二条" },
    ]);
    const composer = useState<HTMLTextAreaElement | null>(null);
    return (
      <>
        <AnnotationSummary
          entries={entries}
          onSave={(a) => {
            setEntries(entries.map((e) => (e.id === a.id ? a : e)));
            return null;
          }}
          onRemove={(id) => setEntries(entries.filter((a) => a.id !== id))}
          onClear={() => setEntries([])}
          onFocusComposer={() => composer[0]?.focus()}
        />
        <textarea
          aria-label="任务输入"
          ref={(node) => {
            composer[1](node);
          }}
        />
      </>
    );
  }
  const view = render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "2 条注释" }));
  expect(screen.getAllByText("所选文本：")).toHaveLength(2);
  expect(screen.getAllByText("用户评论：")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "编辑注释 2" }));
  // Inline editing keeps the list popover, selected quote, and sibling entries visible.
  expect(screen.getByRole("dialog", { name: "消息注释" })).toBeTruthy();
  expect(screen.getByText("第二处原文")).toBeTruthy();
  expect(screen.getAllByText("所选文本：")).toHaveLength(2);
  const inlineInput = screen.getByRole("textbox", { name: "编辑注释 2 评论" });
  expect(document.activeElement).toBe(inlineInput);
  fireEvent.change(inlineInput, { target: { value: "已取消" } });
  fireEvent.keyDown(inlineInput, { key: "Escape" });
  await act(async () => {});
  expect(screen.getByRole("dialog", { name: "消息注释" })).toBeTruthy();
  expect(screen.getByText("第二条")).toBeTruthy();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "编辑注释 2" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "编辑注释 2" }));
  fireEvent.change(screen.getByRole("textbox", { name: "编辑注释 2 评论" }), {
    target: { value: "新建议" },
  });
  fireEvent.click(screen.getByRole("button", { name: "提交注释" }));
  // Saving inline updates the row in place without closing the list popover.
  expect(screen.getByRole("dialog", { name: "消息注释" })).toBeTruthy();
  expect(screen.getByText("新建议")).toBeTruthy();
  const deleteFirst = screen.getByRole("button", { name: "删除注释 1" });
  act(() => deleteFirst.focus());
  fireEvent.click(deleteFirst);
  await act(async () => {});
  // Focus stays inside the dialog after deleting a focused row, so Escape on activeElement closes it.
  expect(
    screen
      .getByRole("dialog", { name: "消息注释" })
      .contains(document.activeElement),
  ).toBe(true);
  fireEvent.keyDown(document.activeElement!, { key: "Escape", bubbles: true });
  await act(async () => {});
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "1 条注释" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "移除全部注释" }));
  await act(async () => {});
  expect(screen.queryByRole("button", { name: /条注释/ })).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "任务输入" }),
  );
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
it("preserves comments when validation fails and traps Tab inside the popover", () => {
  render(<AnnotationSummary entries={[base]} onSave={() => "内容过长"} />);
  fireEvent.click(screen.getByRole("button", { name: "1 条注释" }));
  fireEvent.click(screen.getByRole("button", { name: "编辑注释 1" }));
  const input = screen.getByRole("textbox", { name: "编辑注释 1 评论" });
  fireEvent.change(input, { target: { value: "保留编辑" } });
  fireEvent.click(screen.getByRole("button", { name: "提交注释" }));
  expect(screen.getByRole("alert").textContent).toBe("内容过长");
  expect((input as HTMLTextAreaElement).value).toBe("保留编辑");
  const submit = screen.getByRole("button", { name: "提交注释" });
  act(() => submit.focus());
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

it("stacks annotation highlights above opaque code-block backgrounds and clips horizontally scrolled code highlights", () => {
  // Simulate a fenced code block whose horizontal scroll shifts part of the annotated token past <pre>'s right edge.
  Range.prototype.getClientRects = () =>
    [
      {
        left: 140,
        right: 360,
        top: 290,
        bottom: 308,
        width: 220,
        height: 18,
        x: 140,
        y: 290,
        toJSON: () => ({}),
      },
    ] as unknown as DOMRectList;

  const codeText = "```ts\nconst highlightedToken = 42;\n```";
  const quote = "highlightedToken";
  const view = render(
    <AnnotatedMessage
      text={codeText}
      message={2}
      entries={[]}
      enabled
      onSave={() => null}
      onRemove={vi.fn()}
    />,
  );
  const container = view.container.querySelector(
    ".annotated-message",
  ) as HTMLElement;
  const body = view.container.querySelector(".annotation-body") as HTMLElement;
  const pre = view.container.querySelector("pre") as HTMLElement;
  const start = body.textContent!.indexOf(quote);
  expect(start).toBeGreaterThanOrEqual(0);
  const codeAnnotation: Annotation = {
    id: "code-1",
    quote,
    comment: "检查变量",
    source: { message: 2, start, end: start + quote.length },
  };
  pre.style.overflowX = "auto";
  Object.defineProperty(pre, "clientWidth", { configurable: true, value: 180 });
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
    left: 100,
    right: 328,
    top: 280,
    bottom: 340,
    width: 228,
    height: 60,
    x: 100,
    y: 280,
    toJSON: () => ({}),
  } as DOMRect);
  vi.spyOn(body, "getBoundingClientRect").mockReturnValue({
    left: 100,
    right: 300,
    top: 280,
    bottom: 340,
    width: 200,
    height: 60,
    x: 100,
    y: 280,
    toJSON: () => ({}),
  } as DOMRect);
  vi.spyOn(pre, "getBoundingClientRect").mockReturnValue({
    left: 110,
    right: 290,
    top: 285,
    bottom: 330,
    width: 180,
    height: 45,
    x: 110,
    y: 285,
    toJSON: () => ({}),
  } as DOMRect);

  view.rerender(
    <AnnotatedMessage
      text={codeText}
      message={2}
      entries={[codeAnnotation]}
      enabled
      onSave={() => null}
      onRemove={vi.fn()}
    />,
  );
  const highlight = view.container.querySelector(
    ".annotation-highlight",
  ) as HTMLElement;
  const marker = view.container.querySelector(
    "button.annotation-marker",
  ) as HTMLElement;
  expect(highlight).toBeTruthy();
  expect(marker).toBeTruthy();

  const rootStyle = window.getComputedStyle(container);
  const bodyZ = Number(window.getComputedStyle(body).zIndex);
  const highlightZ = Number(window.getComputedStyle(highlight).zIndex);
  const markerZ = Number(window.getComputedStyle(marker).zIndex);
  expect(rootStyle.isolation).toBe("isolate");
  expect(highlightZ).toBeGreaterThan(bodyZ);
  expect(markerZ).toBeGreaterThan(highlightZ);

  expect(highlight.style.left).toBe("40px");
  // Clipped to <pre>'s right edge (290 - 140 = 150px) instead of overflowing to 328 - 140 = 188px.
  expect(highlight.style.width).toBe("150px");
});

it("clips the code-block portion of a cross-scroller selection without clipping surrounding prose", () => {
  const mixedText = "```ts\nconst highlightedToken = 42;\n```\n\n后续说明段落";
  const view = render(
    <AnnotatedMessage
      text={mixedText}
      message={2}
      entries={[]}
      enabled
      onSave={() => null}
      onRemove={vi.fn()}
    />,
  );
  const container = view.container.querySelector(
    ".annotated-message",
  ) as HTMLElement;
  const body = view.container.querySelector(".annotation-body") as HTMLElement;
  const pre = view.container.querySelector("pre") as HTMLElement;
  const start = body.textContent!.indexOf("highlightedToken");
  const end = body.textContent!.indexOf("段落");
  const quote = body.textContent!.slice(start, end);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  pre.style.overflowX = "auto";
  Range.prototype.getClientRects = function (this: Range) {
    if (pre.contains(this.startContainer)) {
      return [
        {
          left: 140,
          right: 360,
          top: 290,
          bottom: 308,
          width: 220,
          height: 18,
          x: 140,
          y: 290,
          toJSON: () => ({}),
        },
      ] as unknown as DOMRectList;
    }
    return [
      {
        left: 105,
        right: 315,
        top: 340,
        bottom: 358,
        width: 210,
        height: 18,
        x: 105,
        y: 340,
        toJSON: () => ({}),
      },
    ] as unknown as DOMRectList;
  };

  vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
    left: 100,
    right: 328,
    top: 280,
    bottom: 380,
    width: 228,
    height: 100,
    x: 100,
    y: 280,
    toJSON: () => ({}),
  } as DOMRect);
  vi.spyOn(body, "getBoundingClientRect").mockReturnValue({
    left: 100,
    right: 320,
    top: 280,
    bottom: 380,
    width: 220,
    height: 100,
    x: 100,
    y: 280,
    toJSON: () => ({}),
  } as DOMRect);
  vi.spyOn(pre, "getBoundingClientRect").mockReturnValue({
    left: 110,
    right: 290,
    top: 285,
    bottom: 325,
    width: 180,
    height: 40,
    x: 110,
    y: 285,
    toJSON: () => ({}),
  } as DOMRect);

  const crossAnnotation: Annotation = {
    id: "cross-1",
    quote,
    comment: "跨代码块与段落",
    source: { message: 2, start, end },
  };
  view.rerender(
    <AnnotatedMessage
      text={mixedText}
      message={2}
      entries={[crossAnnotation]}
      enabled
      onSave={() => null}
      onRemove={vi.fn()}
    />,
  );

  const highlights = Array.from(
    view.container.querySelectorAll(".annotation-highlight"),
  ) as HTMLElement[];
  expect(highlights).toHaveLength(2);
  // Code segment clipped to <pre> [110, 290]: left = 140 - 100 = 40px, width = 290 - 140 = 150px.
  expect(highlights[0].style.left).toBe("40px");
  expect(highlights[0].style.width).toBe("150px");
  // Prose segment outside <pre> clipped only to .annotation-body [100, 320]: left = 105 - 100 = 5px, width = 210px.
  expect(highlights[1].style.left).toBe("5px");
  expect(highlights[1].style.width).toBe("210px");
});

it("offers Add to main conversation alongside Add annotation when addToMainChat is provided", () => {
  const save = vi.fn().mockReturnValue(null);
  const addToMain = vi.fn();
  render(
    <AnnotatedMessage
      text="终值与 Stage1 排行的差异"
      message={2}
      entries={[]}
      enabled
      onSave={save}
      onRemove={vi.fn()}
      addToMainChat={addToMain}
    />,
  );
  select(screen.getByText("终值与 Stage1 排行的差异"));
  const annotate = screen.getByRole("menuitem", { name: "添加注释" });
  const toMain = screen.getByRole("menuitem", { name: "添加到主对话" });
  act(() => annotate.focus());
  fireEvent.keyDown(annotate, { key: "ArrowRight" });
  expect(document.activeElement).toBe(toMain);

  fireEvent.click(toMain);
  expect(addToMain).toHaveBeenCalledWith("终值与 Stage1 排行的差异");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(window.getSelection()?.toString()).toBe("");

  select(screen.getByText("终值与 Stage1 排行的差异"));
  fireEvent.click(screen.getByRole("menuitem", { name: "添加注释" }));
  fireEvent.click(screen.getByRole("button", { name: "提交注释" }));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      quote: "终值与 Stage1 排行的差异",
      comment: "",
    }),
  );
});
