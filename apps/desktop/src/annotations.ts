import { referenceMessage } from "./referenceMessage";

export interface Annotation {
  id: string;
  quote: string;
  comment: string;
  /** Offsets in the rendered message's textContent, never a fuzzy text match. */
  source: { message: number; start: number; end: number };
}

export const MAX_ANNOTATIONS = 20;
export const MAX_QUOTE = 8000;
export const MAX_COMMENT = 4000;
const MAX_MANIFEST = 96 * 1024;
export const annotationMarker = "\n\n会话注释（所选原文与用户评论）：\n";

function validAnnotation(value: unknown): value is Annotation {
  if (!value || typeof value !== "object") return false;
  const a = value as Annotation;
  return (
    Object.keys(a).every((key) =>
      ["id", "quote", "comment", "source"].includes(key),
    ) &&
    typeof a.id === "string" &&
    a.id.length > 0 &&
    a.id.length <= 128 &&
    typeof a.quote === "string" &&
    !!a.quote.trim() &&
    a.quote.length <= MAX_QUOTE &&
    typeof a.comment === "string" &&
    !!a.comment.trim() &&
    a.comment.length <= MAX_COMMENT &&
    !!a.source &&
    typeof a.source === "object" &&
    Object.keys(a.source).every((key) =>
      ["message", "start", "end"].includes(key),
    ) &&
    Number.isSafeInteger(a.source.message) &&
    a.source.message >= 0 &&
    Number.isSafeInteger(a.source.start) &&
    a.source.start >= 0 &&
    Number.isSafeInteger(a.source.end) &&
    a.source.end > a.source.start &&
    a.source.end - a.source.start === a.quote.length
  );
}

export function annotationError(entries: Annotation[]): string | null {
  if (entries.length > MAX_ANNOTATIONS)
    return `最多添加 ${MAX_ANNOTATIONS} 条注释`;
  if (!entries.every(validAnnotation))
    return "请填写评论，并缩短过长的原文或评论。";
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
    return "注释标识重复，请重新添加。";
  if (
    new TextEncoder().encode(
      JSON.stringify({ version: 1, annotations: entries }),
    ).length > MAX_MANIFEST
  )
    return "注释总内容过长，请减少后再保存。";
  return null;
}

/** Travels through the existing durable Send/queue ledger on every Agent and host. */
export function annotationPrompt(text: string, entries: Annotation[]) {
  if (!entries.length) return text;
  const error = annotationError(entries);
  if (error) throw new Error(error);
  return `${text.trim() || "请逐条回应以下注释。"}${annotationMarker}${JSON.stringify({ version: 1, annotations: entries })}`;
}

/** Only collapse a complete, bounded, versioned manifest. Preserve unknown prose. */
export function annotationMessage(text: string): {
  text: string;
  annotations: Annotation[];
} {
  const original = { text, annotations: [] };
  const index = text.lastIndexOf(annotationMarker);
  if (index < 0) return original;
  const raw = text.slice(index + annotationMarker.length);
  if (
    raw.length > MAX_MANIFEST ||
    new TextEncoder().encode(raw).length > MAX_MANIFEST
  )
    return original;
  try {
    const value = JSON.parse(raw);
    if (
      !value ||
      value.version !== 1 ||
      Object.keys(value).some(
        (key) => !["version", "annotations"].includes(key),
      ) ||
      !Array.isArray(value.annotations) ||
      !value.annotations.length ||
      annotationError(value.annotations)
    )
      return original;
    return { text: text.slice(0, index), annotations: value.annotations };
  } catch {
    return original;
  }
}

export function userMessageContent(text: string) {
  const content = referenceMessage(text);
  return { ...content, ...annotationMessage(content.text) };
}

export function annotationRange(
  root: HTMLElement,
  entry: Annotation,
): Range | null {
  const { start, end } = entry.source;
  if (root.textContent?.slice(start, end) !== entry.quote) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && start < offset + length) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset += length;
  }
  return null;
}

export function selectedAnnotation(
  root: HTMLElement,
  message: number,
): Annotation | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed)
    return null;
  const range = selection.getRangeAt(0);
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  )
    return null;
  // Copy headings, image controls and menus are UI, not reply text.
  if (
    Array.from(
      root.querySelectorAll(
        ".code-block-heading, .copy-action, img, [role=dialog], [aria-hidden=true]",
      ),
    ).some((node) => range.intersectsNode(node))
  )
    return null;
  const raw = range.toString();
  const quote = raw.trim();
  if (!quote || quote.length > MAX_QUOTE) return null;
  const before = range.cloneRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length + raw.length - raw.trimStart().length;
  return {
    id: crypto.randomUUID(),
    quote,
    comment: "",
    source: { message, start, end: start + quote.length },
  };
}
