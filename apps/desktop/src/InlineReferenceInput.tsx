import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { referenceKind } from "./referenceMessage";
import type { ComposerReference } from "./pasteAttachments";

export interface InlineReferenceInputHandle {
  focus: () => void;
  selection: () => {
    start: number;
    end: number;
    afterPath?: string;
    selectedPaths?: string[];
  };
  setCaret: (offset: number, afterPath?: string) => void;
}

interface Props {
  value: string;
  references: ComposerReference[];
  label: string;
  disabled: boolean;
  onEdit: (text: string, references: ComposerReference[]) => void;
  onRemove: (path: string) => void;
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onInputState: (text: string, offset: number) => void;
  onCompositionStart: () => void;
  onCompositionEnd: (text: string, offset: number) => void;
  renderImage: (entry: ComposerReference) => ReactNode;
}

function position(entry: ComposerReference, length: number) {
  return Math.max(0, Math.min(length, entry.inlineOffset ?? length));
}

function signature(text: string, references: ComposerReference[]) {
  return JSON.stringify([
    text,
    references.map((entry) => [
      entry.path,
      entry.name,
      entry.directory,
      entry.mimeType,
      position(entry, text.length),
    ]),
  ]);
}

function textLength(node: Node): number {
  if (node instanceof Element && node.hasAttribute("data-reference-path"))
    return 0;
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0;
  if (node.nodeName === "BR") return 1;
  return Array.from(node.childNodes).reduce(
    (total, child) => total + textLength(child),
    0,
  );
}

function offsetAt(root: HTMLElement, target: Node, offset: number): number {
  function visit(node: Node): number | null {
    if (node === target) {
      if (node.nodeType === Node.TEXT_NODE) return offset;
      return Array.from(node.childNodes)
        .slice(0, offset)
        .reduce((total, child) => total + textLength(child), 0);
    }
    let count = 0;
    for (const child of node.childNodes) {
      if (
        child instanceof Element &&
        child.hasAttribute("data-reference-path")
      ) {
        if (child.contains(target)) return count;
      } else {
        const found = visit(child);
        if (found !== null) return count + found;
      }
      count += textLength(child);
    }
    return null;
  }
  return visit(root) ?? textLength(root);
}

function selection(root: HTMLElement) {
  const current = window.getSelection();
  if (!current?.rangeCount || !root.contains(current.anchorNode)) {
    const end = textLength(root);
    return { start: end, end };
  }
  const range = current.getRangeAt(0);
  let previous: Node | null =
    range.startContainer === root
      ? (root.childNodes[range.startOffset - 1] ?? null)
      : range.startContainer.nodeType === Node.TEXT_NODE &&
          range.startOffset === 0
        ? range.startContainer.previousSibling
        : null;
  while (previous?.nodeType === Node.TEXT_NODE && !previous.textContent)
    previous = previous.previousSibling;
  return {
    start: offsetAt(root, range.startContainer, range.startOffset),
    end: offsetAt(root, range.endContainer, range.endOffset),
    afterPath:
      previous instanceof HTMLElement
        ? previous.dataset.referencePath
        : undefined,
    selectedPaths: range.collapsed
      ? []
      : Array.from(root.querySelectorAll<HTMLElement>("[data-reference-path]"))
          .filter((node) => range.intersectsNode(node))
          .map((node) => node.dataset.referencePath!),
  };
}

function setCaret(root: HTMLElement, offset: number, afterPath?: string) {
  const range = document.createRange();
  const after = afterPath
    ? Array.from(
        root.querySelectorAll<HTMLElement>("[data-reference-path]"),
      ).find((node) => node.dataset.referencePath === afterPath)
    : undefined;
  if (after) range.setStartAfter(after);
  else {
    let remaining = offset;
    let placed = false;
    const walk = (node: Node): void => {
      if (
        placed ||
        (node instanceof Element && node.hasAttribute("data-reference-path"))
      )
        return;
      if (node.nodeType === Node.TEXT_NODE) {
        const length = node.textContent?.length ?? 0;
        if (remaining <= length) {
          range.setStart(node, remaining);
          placed = true;
        } else remaining -= length;
        return;
      }
      for (const child of node.childNodes) walk(child);
    };
    walk(root);
    if (!placed) range.selectNodeContents(root);
  }
  range.collapse(true);
  const current = window.getSelection();
  current?.removeAllRanges();
  current?.addRange(range);
}

function icon(directory: boolean) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute(
    "d",
    directory
      ? "M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z"
      : "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8M8 17h8",
  );
  svg.append(path);
  return svg;
}

function render(
  root: HTMLElement,
  text: string,
  references: ComposerReference[],
  disabled: boolean,
) {
  root.replaceChildren();
  const previews: { entry: ComposerReference; target: HTMLElement }[] = [];
  const sorted = references
    .map((entry, index) => ({
      entry,
      index,
      offset: position(entry, text.length),
    }))
    .sort((a, b) => a.offset - b.offset || a.index - b.index);
  let cursor = 0;
  for (const { entry, offset } of sorted) {
    root.append(document.createTextNode(text.slice(cursor, offset)));
    const chip = document.createElement("span");
    chip.className = "composer-inline-reference";
    chip.contentEditable = "false";
    chip.dataset.referencePath = entry.path;
    chip.title = entry.path;
    const kind = document.createElement("small");
    kind.textContent = "引用";
    chip.append(kind);
    if (!entry.directory && referenceKind(entry) === "image") {
      const target = document.createElement("span");
      target.className = "composer-inline-image";
      chip.append(target);
      previews.push({ entry, target });
    } else {
      chip.append(icon(entry.directory));
      const name = document.createElement("span");
      name.className = "composer-inline-reference-name";
      name.textContent = entry.name;
      chip.append(name);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.disabled = disabled;
    remove.dataset.removeReference = entry.path;
    remove.setAttribute("aria-label", `移除引用 ${entry.path}`);
    remove.textContent = "×";
    chip.append(remove);
    root.append(chip);
    cursor = offset;
  }
  root.append(document.createTextNode(text.slice(cursor)));
  return previews;
}

function read(root: HTMLElement, known: ComposerReference[]) {
  const byPath = new Map(known.map((entry) => [entry.path, entry]));
  const references: ComposerReference[] = [];
  let text = "";
  function visit(node: Node) {
    if (node instanceof HTMLElement && node.dataset.referencePath) {
      const entry = byPath.get(node.dataset.referencePath);
      if (entry) references.push({ ...entry, inlineOffset: text.length });
    } else if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? "";
    else if (node.nodeName === "BR") text += "\n";
    else for (const child of node.childNodes) visit(child);
  }
  for (const child of root.childNodes) visit(child);
  return { text, references };
}

export const InlineReferenceInput = forwardRef<
  InlineReferenceInputHandle,
  Props
>(function InlineReferenceInput(props, handle) {
  const root = useRef<HTMLDivElement>(null);
  const domSignature = useRef("");
  const lastSelection = useRef<{
    start: number;
    end: number;
    afterPath?: string;
    selectedPaths?: string[];
  }>({ start: props.value.length, end: props.value.length });
  const [previews, setPreviews] = useState<
    { entry: ComposerReference; target: HTMLElement }[]
  >([]);
  function rememberSelection() {
    const element = root.current;
    const current = window.getSelection();
    if (element && current?.rangeCount && element.contains(current.anchorNode))
      lastSelection.current = selection(element);
    return lastSelection.current;
  }
  useImperativeHandle(handle, () => ({
    focus: () => {
      if (root.current) {
        root.current.focus();
        setCaret(
          root.current,
          lastSelection.current.start,
          lastSelection.current.afterPath,
        );
      }
    },
    selection: rememberSelection,
    setCaret: (offset, afterPath) => {
      if (root.current) {
        root.current.focus();
        setCaret(root.current, offset, afterPath);
        rememberSelection();
      }
    },
  }));
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const next = signature(props.value, props.references);
    if (domSignature.current === next) {
      element
        .querySelectorAll<HTMLButtonElement>("button[data-remove-reference]")
        .forEach((button) => {
          button.disabled = props.disabled;
        });
      return;
    }
    const focused = document.activeElement === element;
    const caret = focused ? rememberSelection() : lastSelection.current;
    setPreviews(render(element, props.value, props.references, props.disabled));
    domSignature.current = next;
    if (focused) setCaret(element, caret.start, caret.afterPath);
  }, [props.value, props.references, props.disabled]);
  function edited() {
    const element = root.current;
    if (!element || props.disabled) return;
    const next = read(element, props.references);
    domSignature.current = signature(next.text, next.references);
    rememberSelection();
    props.onEdit(next.text, next.references);
    props.onInputState(next.text, selection(element).start);
  }
  return (
    <>
      <div
        ref={root}
        className="composer-inline-input"
        role="textbox"
        aria-label={props.label}
        aria-multiline="true"
        aria-disabled={props.disabled}
        contentEditable={!props.disabled}
        suppressContentEditableWarning
        onInput={edited}
        onClick={(event) => {
          const target = event.target as HTMLElement;
          const remove = target.closest<HTMLButtonElement>(
            "button[data-remove-reference]",
          );
          if (remove?.dataset.removeReference) {
            props.onRemove(remove.dataset.removeReference);
            return;
          }
          const element = root.current;
          if (element) {
            rememberSelection();
            props.onInputState(
              read(element, props.references).text,
              selection(element).start,
            );
          }
        }}
        onMouseUp={rememberSelection}
        onPaste={props.onPaste}
        onKeyDown={(event) => {
          if (props.disabled) return;
          if ((event.target as HTMLElement).closest("button")) return;
          if (
            (event.key === "Backspace" || event.key === "Delete") &&
            !event.nativeEvent.isComposing
          ) {
            const element = root.current;
            const range = window.getSelection()?.rangeCount
              ? window.getSelection()!.getRangeAt(0)
              : null;
            if (
              element &&
              range?.collapsed &&
              element.contains(range.startContainer)
            ) {
              const backward = event.key === "Backspace";
              const node = range.startContainer;
              let neighbor: Node | null = null;
              if (node === element)
                neighbor =
                  element.childNodes[range.startOffset + (backward ? -1 : 0)] ??
                  null;
              else if (node.nodeType === Node.TEXT_NODE) {
                const length = node.textContent?.length ?? 0;
                if (
                  (backward && range.startOffset === 0) ||
                  (!backward && range.startOffset === length)
                )
                  neighbor = backward ? node.previousSibling : node.nextSibling;
              }
              while (
                neighbor?.nodeType === Node.TEXT_NODE &&
                !neighbor.textContent?.length
              )
                neighbor = backward
                  ? neighbor.previousSibling
                  : neighbor.nextSibling;
              if (
                neighbor instanceof HTMLElement &&
                neighbor.dataset.referencePath
              ) {
                event.preventDefault();
                const offset = selection(element).start;
                neighbor.remove();
                edited();
                setCaret(element, offset);
                return;
              }
            }
          }
          if (
            event.key === "Enter" &&
            event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            const range = window.getSelection()?.getRangeAt(0);
            if (range && root.current?.contains(range.startContainer)) {
              range.deleteContents();
              const newline = document.createTextNode("\n");
              range.insertNode(newline);
              range.setStartAfter(newline);
              range.collapse(true);
              window.getSelection()?.removeAllRanges();
              window.getSelection()?.addRange(range);
              edited();
            }
            return;
          }
          props.onKeyDown(event);
        }}
        onKeyUp={(event) => {
          rememberSelection();
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            const element = root.current;
            if (element)
              props.onInputState(
                read(element, props.references).text,
                selection(element).start,
              );
          }
        }}
        onCompositionStart={props.onCompositionStart}
        onCompositionEnd={() => {
          const element = root.current;
          if (element)
            props.onCompositionEnd(
              read(element, props.references).text,
              selection(element).start,
            );
        }}
      />
      {previews.map(({ entry, target }) =>
        createPortal(props.renderImage(entry), target, entry.path),
      )}
    </>
  );
});
