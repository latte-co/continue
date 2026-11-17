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
  Range.prototype.getBoundingClientRect = () => rect;
  Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
});
function select(node: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(node);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  fireEvent.mouseUp(node);
}
const base: Annotation = {
  id: "one",
  quote: "原文",
  comment: "建议",
  source: { message: 2, start: 0, end: 2 },
};
it("selects, cancels without saving, supports IME, and returns only an explicit saved comment", () => {
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
  const input = screen.getByRole("textbox", { name: "用户评论" });
  expect(document.activeElement).toBe(input);
  expect(
    (screen.getByRole("button", { name: "保存" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(input, { target: { value: "  修改这里  " } });
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: "Enter", metaKey: true });
  expect(save).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(save).not.toHaveBeenCalled();
  select(screen.getByText("原文"));
  fireEvent.click(screen.getByRole("menuitem", { name: "添加注释" }));
  fireEvent.change(screen.getByRole("textbox", { name: "用户评论" }), {
    target: { value: "修改这里" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      quote: "原文",
      comment: "修改这里",
      source: { message: 2, start: 4, end: 6 },
    }),
  );
});
it("edits, removes and clears draft comments, while history exposes no mutation actions", () => {
  function Harness() {
    const [entries, setEntries] = useState([
      base,
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
  fireEvent.click(screen.getByRole("button", { name: "编辑注释 2" }));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "新建议" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
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
  render(<AnnotationSummary entries={[base]} />);
  fireEvent.click(screen.getByRole("button", { name: "1 条注释" }));
  expect(screen.getByText("建议")).toBeTruthy();
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
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(screen.getByRole("alert").textContent).toBe("内容过长");
  expect((input as HTMLTextAreaElement).value).toBe("保留编辑");
  act(() => screen.getByRole("button", { name: "保存" }).focus());
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
  fireEvent.click(link);
  expect(activation).not.toHaveBeenCalled();
  expect(screen.getByRole("menuitem", { name: "添加注释" })).toBeTruthy();
  parent.removeEventListener("click", activation);
});
