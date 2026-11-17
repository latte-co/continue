// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import {
  annotationError,
  annotationMarker,
  annotationMessage,
  annotationPrompt,
  annotationRange,
  selectedAnnotation,
  userMessageContent,
  type Annotation,
  MAX_QUOTE,
} from "./annotations";
import { referencePrompt } from "./referenceMessage";

const entry: Annotation = {
  id: "one",
  quote: "相同文字😀",
  comment: "请解释",
  source: { message: 3, start: 0, end: 6 },
};
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});
it("round-trips annotations with attachments and preserves the visible user message", () => {
  const refs = [{ name: "note.md", path: "note.md", directory: false }];
  const prompt = referencePrompt(
    annotationPrompt("请看这些问题", [entry]),
    refs,
  );
  expect(userMessageContent(prompt)).toEqual({
    text: "请看这些问题",
    annotations: [entry],
    references: refs.map((r) => ({
      ...r,
      attachmentKind: undefined,
      mimeType: undefined,
    })),
  });
  expect(annotationMessage(annotationPrompt("", [entry])).text).toBe(
    "请逐条回应以下注释。",
  );
  expect(annotationPrompt("ordinary", [])).toBe("ordinary");
});
it.each([
  "{broken",
  JSON.stringify({ version: 2, annotations: [entry] }),
  JSON.stringify({
    version: 1,
    annotations: [{ ...entry, source: { message: 3, start: 0, end: 5 } }],
  }),
  JSON.stringify({ version: 1, annotations: [entry, entry] }),
  JSON.stringify({
    version: 1,
    annotations: [{ ...entry, quote: "", comment: "" }],
  }),
  JSON.stringify({ version: 1, annotations: [entry], extra: true }),
  JSON.stringify({
    version: 1,
    annotations: Array.from({ length: 21 }, (_, i) => ({
      ...entry,
      id: String(i),
    })),
  }),
  "x".repeat(128 * 1024 + 1),
])("preserves unknown or malformed manifests verbatim", (manifest) => {
  const text = "用户原文" + annotationMarker + manifest;
  expect(annotationMessage(text)).toEqual({ text, annotations: [] });
});
it("bounds individual and aggregate context before sending", () => {
  expect(annotationError([entry])).toBeNull();
  expect(() =>
    annotationPrompt("", [{ ...entry, comment: "x".repeat(4001) }]),
  ).toThrow();
  const large = {
    ...entry,
    quote: "q".repeat(MAX_QUOTE),
    comment: "c".repeat(4000),
    source: { message: 3, start: 0, end: MAX_QUOTE },
  };
  expect(
    annotationError(
      Array.from({ length: 20 }, (_, i) => ({ ...large, id: String(i) })),
    ),
  ).toContain("总内容过长");
});

it("counts multibyte context against the UTF-8 budget instead of character count", () => {
  const large = {
    ...entry,
    quote: "中".repeat(8000),
    comment: "评".repeat(4000),
    source: { message: 3, start: 0, end: 8000 },
  };
  expect(annotationError([large])).toBeNull();
  expect(
    annotationError(
      Array.from({ length: 3 }, (_, i) => ({ ...large, id: String(i) })),
    ),
  ).toContain("总内容过长");
});
it("captures across rich-text nodes, retaining the exact occurrence and Unicode offsets", () => {
  const root = document.createElement("div");
  root.innerHTML =
    "<p>相同文字😀</p><p>前缀<strong>相同</strong><code>文字😀</code> 后缀</p>";
  document.body.append(root);
  const range = document.createRange();
  range.setStart(root.querySelector("strong")!.firstChild!, 0);
  range.setEnd(root.querySelector("code")!.firstChild!, 4);
  window.getSelection()!.addRange(range);
  const selected = selectedAnnotation(root, 7)!;
  expect(selected.quote).toBe(entry.quote);
  expect(selected.source).toEqual({ message: 7, start: 8, end: 14 });
  const restored = annotationRange(root, selected)!;
  expect(restored.startContainer).toBe(
    root.querySelector("strong")!.firstChild,
  );
  expect(restored.toString()).toBe(entry.quote);
  root.querySelector("strong")!.textContent = "不同";
  expect(annotationRange(root, selected)).toBeNull();
});
it("rejects collapsed, cross-message, UI controls and oversized selections", () => {
  const root = document.createElement("div");
  root.innerHTML = '<p>hello</p><div class="code-block-heading">复制代码</div>';
  const other = document.createElement("p");
  other.textContent = "other";
  document.body.append(root, other);
  const selection = window.getSelection()!;
  expect(selectedAnnotation(root, 1)).toBeNull();
  const range = document.createRange();
  range.selectNodeContents(root);
  selection.addRange(range);
  expect(selectedAnnotation(root, 1)).toBeNull();
  range.setEnd(other.firstChild!, 3);
  expect(selectedAnnotation(root, 1)).toBeNull();
  root.textContent = "x".repeat(MAX_QUOTE + 1);
  selection.removeAllRanges();
  range.selectNodeContents(root);
  selection.addRange(range);
  expect(selectedAnnotation(root, 1)).toBeNull();
});
