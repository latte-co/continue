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
import { dragHasFiles } from "./fileDrag";
import { referenceKind } from "./referenceMessage";
import type { ComposerReference } from "./pasteAttachments";

export interface InlineSelection {
  start: number;
  end: number;
  afterPath?: string;
  selectedPaths?: string[];
}

export interface InlineReferenceInputHandle {
  focus: () => void;
  selection: () => InlineSelection | null;
  setCaret: (offset: number, afterPath?: string) => void;
}

interface Props {
  value: string;
  references: ComposerReference[];
  label: string;
  disabled: boolean;
  autocomplete: {
    "aria-autocomplete": "list";
    "aria-controls"?: string;
    "aria-expanded": boolean;
    "aria-activedescendant"?: string;
  };
  onEdit: (
    text: string,
    references: ComposerReference[],
    caret: InlineSelection | null,
  ) => void;
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

function chipAt(node: Node) {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest<HTMLElement>("[data-reference-path]");
}

function emptyText(node: Node) {
  return node.nodeType === Node.TEXT_NODE && !node.textContent;
}

function neighboringNode(node: Node | null, backward: boolean) {
  while (node && emptyText(node))
    node = backward ? node.previousSibling : node.nextSibling;
  return node;
}

function breakLength(node: Node) {
  if (!(node instanceof HTMLBRElement) || node.hasAttribute("data-tail-break"))
    return 0;
  // WebKit leaves a lone BR behind when the user empties the editor.
  return neighboringNode(node.previousSibling, true) ||
    neighboringNode(node.nextSibling, false)
    ? 1
    : 0;
}

function textLength(node: Node): number {
  if (chipAt(node)) return 0;
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0;
  if (node.nodeName === "BR") return breakLength(node);
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
      const found = visit(child);
      if (found !== null) return count + found;
      count += textLength(child);
    }
    return null;
  }
  return visit(root) ?? textLength(root);
}

function liveRange() {
  const current = window.getSelection();
  return current?.rangeCount ? current.getRangeAt(0) : null;
}

function insideEditor(root: HTMLElement, range: Range) {
  return (
    root.contains(range.startContainer) &&
    root.contains(range.endContainer) &&
    !chipAt(range.startContainer) &&
    !chipAt(range.endContainer)
  );
}

function adjacentNode(root: HTMLElement, range: Range, backward: boolean) {
  const node = range.startContainer;
  if (node === root)
    return neighboringNode(
      root.childNodes[range.startOffset - (backward ? 1 : 0)] ?? null,
      backward,
    );
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const edge = backward ? 0 : node.textContent?.length;
  return range.startOffset === edge
    ? neighboringNode(
        backward ? node.previousSibling : node.nextSibling,
        backward,
      )
    : null;
}

function selection(root: HTMLElement, range: Range): InlineSelection {
  const previous = adjacentNode(root, range, true);
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

function selectRange(range: Range) {
  const current = window.getSelection();
  current?.removeAllRanges();
  current?.addRange(range);
}

function setCaret(root: HTMLElement, offset: number, afterPath?: string) {
  const range = document.createRange();
  const after = afterPath
    ? Array.from(
        root.querySelectorAll<HTMLElement>("[data-reference-path]"),
      ).find((node) => node.dataset.referencePath === afterPath)
    : undefined;
  if (after && offsetAt(root, after, 0) === offset) range.setStartAfter(after);
  else {
    let remaining = offset;
    function place(node: Node): boolean {
      if (chipAt(node)) return false;
      if (node.nodeType === Node.TEXT_NODE) {
        const length = node.textContent?.length ?? 0;
        if (remaining <= length) {
          range.setStart(node, remaining);
          return true;
        }
        remaining -= length;
      } else if (node.nodeName === "BR") {
        if (remaining === 0 || remaining === breakLength(node)) {
          if (remaining === 0) range.setStartBefore(node);
          else range.setStartAfter(node);
          return true;
        }
        remaining -= breakLength(node);
      }
      return Array.from(node.childNodes).some(place);
    }
    if (!place(root)) {
      range.selectNodeContents(root);
      range.collapse(false);
    }
  }
  range.collapse(true);
  selectRange(range);
}

function syncTailBreak(root: HTMLElement) {
  const tail = root.querySelector("br[data-tail-break]");
  let last = neighboringNode(root.lastChild, true);
  if (last && last === tail) last = neighboringNode(last.previousSibling, true);
  const needsBreak =
    last?.nodeType === Node.TEXT_NODE && last.textContent?.endsWith("\n");
  if (!needsBreak) {
    tail?.remove();
  } else if (!tail) {
    const br = document.createElement("br");
    br.dataset.tailBreak = "";
    root.append(br);
  } else if (tail !== root.lastChild) {
    root.append(tail);
  }
}

function dropRange(root: HTMLElement, x: number, y: number) {
  let range: Range | null;
  if (document.caretPositionFromPoint) {
    const point = document.caretPositionFromPoint(x, y);
    if (!point) return null;
    range = document.createRange();
    range.setStart(point.offsetNode, point.offset);
    range.collapse(true);
  } else if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(x, y);
  } else {
    range = liveRange()?.cloneRange() ?? null;
  }
  if (!range || !root.contains(range.startContainer)) return null;
  const chip = chipAt(range.startContainer);
  if (chip) {
    const { left, width } = chip.getBoundingClientRect();
    if (x < left + width / 2) range.setStartBefore(chip);
    else range.setStartAfter(chip);
    range.collapse(true);
  }
  return insideEditor(root, range) ? range : null;
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
  syncTailBreak(root);
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
    else if (breakLength(node)) text += "\n";
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
  const composing = useRef(false);
  const lastSelection = useRef<InlineSelection>({
    start: props.value.length,
    end: props.value.length,
  });
  const [previews, setPreviews] = useState<
    { entry: ComposerReference; target: HTMLElement }[]
  >([]);
  function rememberSelection() {
    const element = root.current;
    const range = liveRange();
    if (element && range?.intersectsNode(element)) {
      if (!insideEditor(element, range)) return null;
      lastSelection.current = selection(element, range);
    }
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
    // React's beforeinput event does not expose every native editing command.
    const beforeInput = (event: InputEvent) => {
      const range = liveRange();
      if (
        event.inputType?.startsWith("format") ||
        (range?.intersectsNode(element) && !insideEditor(element, range))
      )
        event.preventDefault();
    };
    element.addEventListener("beforeinput", beforeInput);
    return () => element.removeEventListener("beforeinput", beforeInput);
  }, []);
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
    if (focused && caret) setCaret(element, caret.start, caret.afterPath);
  }, [props.value, props.references, props.disabled]);
  function edited(finishedComposition = false) {
    const element = root.current;
    if (!element || composing.current) return;
    const next = read(element, props.references);
    const caret = rememberSelection();
    if (finishedComposition)
      props.onCompositionEnd(next.text, caret?.start ?? next.text.length);
    if (props.disabled) return;
    syncTailBreak(element);
    if (previews.some(({ target }) => !element.contains(target)))
      setPreviews(previews.filter(({ target }) => element.contains(target)));
    domSignature.current = signature(next.text, next.references);
    props.onEdit(next.text, next.references, caret);
    if (caret && !finishedComposition)
      props.onInputState(next.text, caret.start);
  }
  function removeChip(element: HTMLElement, chip: HTMLElement) {
    const range = document.createRange();
    range.setStartBefore(chip);
    range.collapse(true);
    chip.remove();
    element.focus();
    selectRange(range);
    edited();
  }
  function insertText(range: Range, text: string) {
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selectRange(range);
    edited();
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
        {...props.autocomplete}
        contentEditable={!props.disabled}
        suppressContentEditableWarning
        onInput={(event) => {
          if (event.currentTarget.contains(event.target as Node)) edited();
        }}
        onClick={(event) => {
          const element = event.currentTarget;
          const target = event.target as Element;
          if (!element.contains(target)) return;
          const button = target.closest<HTMLButtonElement>("button");
          if (button) {
            const chip = chipAt(button);
            if (!props.disabled && button.dataset.removeReference && chip)
              removeChip(element, chip);
            return;
          }
          const caret = rememberSelection();
          if (caret) props.onInputState(props.value, caret.start);
        }}
        onMouseUp={rememberSelection}
        onPaste={(event) => {
          if (event.currentTarget.contains(event.target as Node))
            props.onPaste(event);
        }}
        onCut={(event) => {
          const range = liveRange();
          if (range && !insideEditor(event.currentTarget, range))
            event.preventDefault();
        }}
        onDragOver={(event) => {
          if (!props.disabled && !dragHasFiles(event.dataTransfer))
            event.preventDefault();
        }}
        onDrop={(event) => {
          if (dragHasFiles(event.dataTransfer)) return;
          event.preventDefault();
          if (props.disabled || composing.current) return;
          const text = event.dataTransfer.getData("text/plain");
          if (!text) return;
          const element = event.currentTarget;
          const range = dropRange(element, event.clientX, event.clientY);
          if (!range) return;
          element.focus();
          insertText(range, text.replace(/\r\n?/g, "\n"));
        }}
        onKeyDown={(event) => {
          if (props.disabled) return;
          const element = event.currentTarget;
          const target = event.target as Element;
          if (!element.contains(target) || target.closest("button")) return;
          if (
            composing.current ||
            event.nativeEvent.isComposing ||
            event.keyCode === 229
          )
            return;
          if (
            (event.metaKey || event.ctrlKey) &&
            !event.altKey &&
            ["b", "i", "u"].includes(event.key.toLowerCase())
          ) {
            event.preventDefault();
            return;
          }
          const range = liveRange();
          if (event.key === "Backspace" || event.key === "Delete") {
            if (range && !insideEditor(element, range)) {
              event.preventDefault();
              return;
            }
            if (range?.collapsed) {
              const neighbor = adjacentNode(
                element,
                range,
                event.key === "Backspace",
              );
              if (
                neighbor instanceof HTMLElement &&
                neighbor.dataset.referencePath
              ) {
                event.preventDefault();
                removeChip(element, neighbor);
                return;
              }
            }
          }
          if (event.key === "Enter" && event.shiftKey) {
            event.preventDefault();
            if (range && insideEditor(element, range)) insertText(range, "\n");
            return;
          }
          props.onKeyDown(event);
        }}
        onKeyUp={(event) => {
          if (event.target !== event.currentTarget || composing.current) return;
          const caret = rememberSelection();
          if (
            caret &&
            ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
          )
            props.onInputState(props.value, caret.start);
        }}
        onCompositionStart={(event) => {
          if (event.target !== event.currentTarget) return;
          composing.current = true;
          props.onCompositionStart();
        }}
        onCompositionEnd={(event) => {
          if (event.target !== event.currentTarget) return;
          composing.current = false;
          edited(true);
        }}
      />
      {previews.map(({ entry, target }) =>
        createPortal(props.renderImage(entry), target, entry.path),
      )}
    </>
  );
});
