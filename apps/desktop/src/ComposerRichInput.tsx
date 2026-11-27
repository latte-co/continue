import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Extension,
  type JSONContent,
  Node as TiptapNode,
  mergeAttributes,
  nodeInputRule,
} from "@tiptap/core";
import CodeBlock from "@tiptap/extension-code-block";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import {
  Table,
  TableCell,
  TableHeader,
  TableRow,
} from "@tiptap/extension-table";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { invoke } from "@tauri-apps/api/core";
import { native } from "./api";
import { composerTrigger } from "./composerActions";
import { dragHasFiles } from "./fileDrag";
import {
  type CommandPillIconKind,
  type ComposerCommandTokenMeta,
  isTableHeaderPair,
  parseInlineMarkdown,
  parseMarkdownToDoc,
  resolveDocPosFromMarkdownOffset,
  serializeDocWithSelection,
  splitTableRowRaw,
} from "./composerMarkdown";
import type {
  InlineReferenceInputHandle,
  InlineSelection,
} from "./InlineReferenceInput";
import type { ComposerReference } from "./pasteAttachments";
import { referenceKind } from "./referenceMessage";

// jsdom does not implement Range client-rect geometry expected by ProseMirror.
if (typeof Range !== "undefined") {
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: function* () {},
      }) as DOMRectList;
  }
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  }
}

function createGlobeSvg(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "13.5");
  svg.setAttribute("height", "13.5");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");

  const circle = document.createElementNS(ns, "circle");
  circle.setAttribute("cx", "12");
  circle.setAttribute("cy", "12");
  circle.setAttribute("r", "10");
  svg.append(circle);

  const path1 = document.createElementNS(ns, "path");
  path1.setAttribute("d", "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20");
  svg.append(path1);

  const path2 = document.createElementNS(ns, "path");
  path2.setAttribute("d", "M2 12h20");
  svg.append(path2);

  return svg;
}

function createReferenceSvg(directory: boolean): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
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

function createCommandSvg(kind: CommandPillIconKind): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");

  const addPath = (d: string) => {
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", d);
    svg.append(p);
  };
  const addRect = (x: string, y: string, w: string, h: string, rx: string) => {
    const r = document.createElementNS(ns, "rect");
    r.setAttribute("x", x);
    r.setAttribute("y", y);
    r.setAttribute("width", w);
    r.setAttribute("height", h);
    r.setAttribute("rx", rx);
    svg.append(r);
  };
  const addCircle = (cx: string, cy: string, rad: string) => {
    const c = document.createElementNS(ns, "circle");
    c.setAttribute("cx", cx);
    c.setAttribute("cy", cy);
    c.setAttribute("r", rad);
    svg.append(c);
  };

  switch (kind) {
    case "skill":
      addPath(
        "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z",
      );
      addPath("m3.3 7 8.7 5 8.7-5");
      addPath("M12 22V12");
      break;
    case "subagents":
      addCircle("12", "18", "3");
      addCircle("6", "6", "3");
      addCircle("18", "6", "3");
      addPath("M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9");
      addPath("M12 12v3");
      break;
    case "model":
      addRect("4", "4", "16", "16", "2");
      addRect("9", "9", "6", "6", "1");
      addPath("M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2");
      break;
    case "effort":
      addPath(
        "M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4",
      );
      break;
    case "side":
      addPath("M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z");
      break;
    default:
      addRect("3", "3", "18", "18", "3");
      addPath("m7 15 3-3-3-3");
      addPath("M13 15h4");
      break;
  }
  return svg;
}

interface RichComposerContext {
  disabled: boolean;
  references: ComposerReference[];
  syncImagePreviews: () => void;
}

const richContextMap = new WeakMap<object, RichComposerContext>();

const LinkPill = TiptapNode.create({
  name: "linkPill",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      label: { default: "" },
      href: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-link-href]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: "composer-link-pill",
        "data-link-href": HTMLAttributes.href,
      }),
      String(HTMLAttributes.label ?? ""),
    ];
  },

  addInputRules() {
    return [
      nodeInputRule({
        find: /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)$/,
        type: this.type,
        getAttributes: (match) => ({
          label: match[1],
          href: match[2],
        }),
      }),
    ];
  },

  addNodeView() {
    return ({ node }) => {
      let currentNode = node;
      const dom = document.createElement("span");
      dom.className = "composer-link-pill";
      dom.contentEditable = "false";

      const icon = createGlobeSvg();
      const textSpan = document.createElement("span");
      textSpan.className = "composer-link-pill-label";
      dom.append(icon, textSpan);

      const syncAttrs = (target: typeof node) => {
        const label = String(target.attrs.label ?? "");
        const href = String(target.attrs.href ?? "");
        dom.dataset.linkHref = href;
        dom.dataset.linkLabel = label;
        dom.title = href;
        dom.setAttribute("aria-label", `${label} (${href})`);
        textSpan.textContent = label;
      };
      syncAttrs(currentNode);

      return {
        dom,
        update(updatedNode) {
          if (updatedNode.type !== currentNode.type) return false;
          currentNode = updatedNode;
          syncAttrs(currentNode);
          return true;
        },
        selectNode() {
          dom.classList.add("is-selected");
        },
        deselectNode() {
          dom.classList.remove("is-selected");
        },
        ignoreMutation() {
          return true;
        },
      };
    };
  },
});

const CommandPill = TiptapNode.create({
  name: "commandPill",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      name: { default: "" },
      icon: { default: "command" },
      title: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-command-name]" }];
  },

  renderText({ node }) {
    return `/${String(node.attrs.name ?? "")}`;
  },

  renderHTML({ HTMLAttributes }) {
    const name = String(HTMLAttributes.name ?? "");
    const icon = String(HTMLAttributes.icon ?? "command");
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: "composer-command-pill",
        "data-command-name": name,
        "data-command-icon": icon,
      }),
      `/${name}`,
    ];
  },

  addNodeView() {
    return ({ node }) => {
      let currentNode = node;
      const dom = document.createElement("span");
      dom.className = "composer-command-pill";
      dom.contentEditable = "false";

      const renderPillDom = (target: typeof node) => {
        dom.replaceChildren();
        const name = String(target.attrs.name ?? "");
        const iconKind = (target.attrs.icon ??
          "command") as CommandPillIconKind;
        const title = String(target.attrs.title ?? "");
        dom.dataset.commandName = name;
        dom.dataset.commandIcon = iconKind;
        dom.title =
          title && title !== name ? `${title} (/${name})` : `/${name}`;

        const iconEl = createCommandSvg(iconKind);
        const textSpan = document.createElement("span");
        textSpan.className = "composer-command-pill-label";
        textSpan.textContent = name;
        dom.append(iconEl, textSpan);
      };
      renderPillDom(currentNode);

      return {
        dom,
        update(updatedNode) {
          if (updatedNode.type !== currentNode.type) return false;
          currentNode = updatedNode;
          renderPillDom(currentNode);
          return true;
        },
        selectNode() {
          dom.classList.add("is-selected");
        },
        deselectNode() {
          dom.classList.remove("is-selected");
        },
        ignoreMutation() {
          return true;
        },
      };
    };
  },
});

const ReferenceChip = TiptapNode.create({
  name: "referenceChip",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      path: { default: "" },
      name: { default: "" },
      directory: { default: false },
      mimeType: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-reference-path]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: "composer-inline-reference",
        "data-reference-path": HTMLAttributes.path,
      }),
      String(HTMLAttributes.name ?? ""),
    ];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let currentNode = node;
      const ctx = richContextMap.get(editor);
      const chip = document.createElement("span");
      chip.className = "composer-inline-reference";
      chip.contentEditable = "false";

      const renderChipDom = (targetNode: typeof node) => {
        chip.replaceChildren();
        const path = String(targetNode.attrs.path ?? "");
        const name = String(targetNode.attrs.name ?? path);
        const directory = Boolean(targetNode.attrs.directory);
        const mimeType =
          typeof targetNode.attrs.mimeType === "string"
            ? targetNode.attrs.mimeType
            : undefined;
        chip.dataset.referencePath = path;
        chip.title = path;

        const kind = document.createElement("small");
        kind.textContent = "引用";
        chip.append(kind);

        const entry: ComposerReference = richContextMap
          .get(editor)
          ?.references.find((r) => r.path === path) ?? {
          path,
          name,
          directory,
          mimeType,
        };

        if (!directory && referenceKind(entry) === "image") {
          const imgTarget = document.createElement("span");
          imgTarget.className = "composer-inline-image";
          imgTarget.dataset.imagePreviewPath = path;
          chip.append(imgTarget);
        } else {
          chip.append(createReferenceSvg(directory));
          const nameEl = document.createElement("span");
          nameEl.className = "composer-inline-reference-name";
          nameEl.textContent = name;
          chip.append(nameEl);
        }

        const remove = document.createElement("button");
        remove.type = "button";
        remove.disabled = richContextMap.get(editor)?.disabled ?? false;
        remove.dataset.removeReference = path;
        remove.setAttribute("aria-label", `移除引用 ${path}`);
        remove.textContent = "×";
        remove.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (richContextMap.get(editor)?.disabled) return;
          const pos = typeof getPos === "function" ? getPos() : undefined;
          if (typeof pos === "number") {
            editor
              .chain()
              .focus()
              .deleteRange({ from: pos, to: pos + currentNode.nodeSize })
              .run();
          }
        });
        chip.append(remove);
        ctx?.syncImagePreviews();
      };

      renderChipDom(currentNode);

      return {
        dom: chip,
        update(updatedNode) {
          if (updatedNode.type !== currentNode.type) return false;
          currentNode = updatedNode;
          renderChipDom(currentNode);
          return true;
        },
        ignoreMutation() {
          return true;
        },
        destroy() {
          richContextMap.get(editor)?.syncImagePreviews();
        },
      };
    };
  },
});

const ComposerCodeBlock = CodeBlock.extend({
  renderHTML({ node, HTMLAttributes }) {
    const lang = String(node.attrs.language ?? "").trim();
    return [
      "pre",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        class: "composer-md-codeblock",
        "data-language": lang || "代码",
      }),
      ["code", lang ? { class: `language-${lang}` } : {}, 0],
    ];
  },
});

const ConfiguredStarterKit = StarterKit.configure({
  trailingNode: false,
  link: false,
  underline: false,
  dropcursor: false,
  codeBlock: false,
});
const ConfiguredTaskItem = TaskItem.configure({ nested: true });
const ConfiguredTable = Table.configure({ resizable: false });

interface Props {
  value: string;
  references: ComposerReference[];
  recognizedCommands?: ReadonlyMap<string, ComposerCommandTokenMeta>;
  activeCommandTriggerStart?: number | null;
  label: string;
  placeholder: string;
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

function countDocCommandPills(doc: ProseMirrorNode): number {
  let count = 0;
  doc.descendants((node) => {
    if (node.type.name === "commandPill") count++;
  });
  return count;
}

function countJsonCommandPills(node: JSONContent): number {
  let count = node.type === "commandPill" ? 1 : 0;
  if (node.content) {
    for (const child of node.content) count += countJsonCommandPills(child);
  }
  return count;
}

function signature(
  text: string,
  references: ComposerReference[],
  recognizedCommands?: ReadonlyMap<string, ComposerCommandTokenMeta>,
  activeCommandTriggerStart?: number | null,
): string {
  const matchedCommands: [string, string, string][] = [];
  if (recognizedCommands && recognizedCommands.size > 0 && text.includes("/")) {
    const regex = /(?:^|[ \t\n])\/([^\s/]+)/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      const meta = recognizedCommands.get(m[1]);
      if (meta) matchedCommands.push([meta.name, meta.icon, meta.title ?? ""]);
    }
  }
  const normalizedTriggerStart =
    activeCommandTriggerStart !== null &&
    activeCommandTriggerStart !== undefined &&
    activeCommandTriggerStart >= 0 &&
    activeCommandTriggerStart < text.length &&
    text[activeCommandTriggerStart] === "/"
      ? activeCommandTriggerStart
      : null;
  return JSON.stringify([
    text,
    references.map((entry) => [
      entry.path,
      entry.name,
      entry.directory,
      entry.mimeType,
      Math.max(0, Math.min(text.length, entry.inlineOffset ?? text.length)),
    ]),
    matchedCommands,
    normalizedTriggerStart,
  ]);
}

export const ComposerRichInput = forwardRef<InlineReferenceInputHandle, Props>(
  function ComposerRichInput(props, handle) {
    const shellRef = useRef<HTMLDivElement>(null);
    const propsRef = useRef(props);
    propsRef.current = props;

    const composingRef = useRef(false);
    const syncingExternalRef = useRef(false);
    const lastSerializedSig = useRef(
      signature(
        props.value,
        props.references,
        props.recognizedCommands,
        props.activeCommandTriggerStart,
      ),
    );
    const lastSelectionRef = useRef<InlineSelection>({
      start: props.value.length,
      end: props.value.length,
    });
    const [imageTargets, setImageTargets] = useState<
      { entry: ComposerReference; target: HTMLElement }[]
    >([]);
    const imageTargetsRef = useRef<
      { entry: ComposerReference; target: HTMLElement }[]
    >([]);

    const collectImageTargets = () => {
      const shell = shellRef.current;
      if (!shell) return;
      const nodes = Array.from(
        shell.querySelectorAll<HTMLElement>("[data-image-preview-path]"),
      );
      const byPath = new Map(
        propsRef.current.references.map((entry) => [entry.path, entry]),
      );
      const next = nodes
        .map((target) => {
          const entry = byPath.get(target.dataset.imagePreviewPath ?? "");
          return entry ? { entry, target } : null;
        })
        .filter(
          (item): item is { entry: ComposerReference; target: HTMLElement } =>
            item !== null,
        );
      const prev = imageTargetsRef.current;
      if (
        prev.length === next.length &&
        prev.every(
          (p, idx) =>
            p.target === next[idx].target &&
            p.entry.path === next[idx].entry.path,
        )
      ) {
        return;
      }
      imageTargetsRef.current = next;
      setImageTargets(next);
    };

    const ComposerKeyboard = useRef(
      Extension.create({
        name: "composerKeyboard",
        priority: 1000,
        addKeyboardShortcuts() {
          return {
            Backspace: ({ editor }) => {
              const { selection } = editor.state;
              if (
                selection instanceof NodeSelection &&
                (selection.node.type.name === "commandPill" ||
                  selection.node.type.name === "referenceChip" ||
                  selection.node.type.name === "linkPill")
              ) {
                editor.view.dispatch(
                  editor.state.tr.delete(selection.from, selection.to),
                );
                return true;
              }
              if (!selection.empty) return false;
              const before = selection.$from.nodeBefore;
              if (
                before &&
                (before.type.name === "commandPill" ||
                  before.type.name === "referenceChip")
              ) {
                editor.view.dispatch(
                  editor.state.tr.delete(
                    selection.from - before.nodeSize,
                    selection.from,
                  ),
                );
                return true;
              }
              return false;
            },
            Delete: ({ editor }) => {
              const { selection } = editor.state;
              if (
                selection instanceof NodeSelection &&
                (selection.node.type.name === "commandPill" ||
                  selection.node.type.name === "referenceChip" ||
                  selection.node.type.name === "linkPill")
              ) {
                editor.view.dispatch(
                  editor.state.tr.delete(selection.from, selection.to),
                );
                return true;
              }
              if (!selection.empty) return false;
              const after = selection.$from.nodeAfter;
              if (
                after &&
                (after.type.name === "commandPill" ||
                  after.type.name === "referenceChip")
              ) {
                editor.view.dispatch(
                  editor.state.tr.delete(
                    selection.from,
                    selection.from + after.nodeSize,
                  ),
                );
                return true;
              }
              return false;
            },
            Enter: () => {
              // Plain Enter is strictly owned by Composer (submit or autocomplete menu)
              return true;
            },
            "Shift-Enter": ({ editor }) => {
              const { state } = editor;
              const { $from } = state.selection;

              // 1. Inside codeBlock: trailing blank line exits below; otherwise newline
              for (let d = $from.depth; d > 0; d--) {
                const ancestor = $from.node(d);
                if (ancestor.type.name === "codeBlock") {
                  const codeText = ancestor.textContent;
                  const atEnd = $from.parentOffset === ancestor.content.size;
                  if (atEnd && codeText.endsWith("\n")) {
                    const blockEnd = $from.after(d);
                    const tr = state.tr
                      .delete($from.pos - 1, $from.pos)
                      .insert(
                        blockEnd - 1,
                        state.schema.nodes.paragraph.create(),
                      );
                    tr.setSelection(TextSelection.create(tr.doc, blockEnd));
                    editor.view.dispatch(tr);
                    return true;
                  }
                  return editor.commands.newlineInCode();
                }
              }

              // 2. Inside Table: empty last row exits table; otherwise add row below
              for (let d = $from.depth; d > 0; d--) {
                const ancestor = $from.node(d);
                if (ancestor.type.name === "tableRow") {
                  const tableDepth = d - 1;
                  const tableNode = $from.node(tableDepth);
                  const rowIndex = $from.index(tableDepth);
                  const rowEmpty = ancestor.textContent.trim().length === 0;
                  if (
                    rowEmpty &&
                    rowIndex === tableNode.childCount - 1 &&
                    tableNode.childCount > 1
                  ) {
                    editor.commands.deleteRow();
                    const currentState = editor.state;
                    const $pos = currentState.selection.$from;
                    for (let td = $pos.depth; td > 0; td--) {
                      if ($pos.node(td).type.name === "table") {
                        const afterTable = $pos.after(td);
                        const tr = currentState.tr.insert(
                          afterTable,
                          currentState.schema.nodes.paragraph.create(),
                        );
                        tr.setSelection(
                          TextSelection.create(tr.doc, afterTable + 1),
                        );
                        editor.view.dispatch(tr);
                        return true;
                      }
                    }
                    return true;
                  }
                  editor.commands.addRowAfter();
                  editor.commands.goToNextCell();
                  return true;
                }
              }

              // 3. Inside TaskItem or ListItem: auto-continue or exit empty item
              for (let d = $from.depth; d > 0; d--) {
                const ancestor = $from.node(d);
                if (
                  ancestor.type.name === "taskItem" ||
                  ancestor.type.name === "listItem"
                ) {
                  const firstChild = ancestor.firstChild;
                  const isEmptyItem =
                    ancestor.childCount === 1 &&
                    firstChild?.type.name === "paragraph" &&
                    firstChild.content.size === 0;
                  if (isEmptyItem) {
                    return editor.commands.liftListItem(ancestor.type.name);
                  }
                  return editor.commands.splitListItem(ancestor.type.name);
                }
              }

              // 4. Inside Blockquote: empty paragraph exits blockquote
              for (let d = $from.depth; d > 0; d--) {
                if ($from.node(d).type.name === "blockquote") {
                  if ($from.parent.content.size === 0) {
                    return editor.commands.lift("blockquote");
                  }
                  return editor.commands.splitBlock();
                }
              }

              // 5. Paragraph fence trigger: ```lang + Shift+Enter -> codeBlock
              if ($from.parent.type.name === "paragraph") {
                const lineText = $from.parent.textContent;
                const fenceMatch = lineText.match(
                  /^[ \t]{0,3}(?:```|~~~)([A-Za-z0-9_+-]*)[ \t]*$/,
                );
                if (fenceMatch) {
                  const language = fenceMatch[1] || "";
                  return editor
                    .chain()
                    .deleteRange({
                      from: $from.start(),
                      to: $from.end(),
                    })
                    .setCodeBlock({ language })
                    .run();
                }

                // 6. Paragraph GFM table trigger: | a | b | + | --- | --- | + Shift+Enter
                if ($from.depth === 1) {
                  const docIndex = $from.index(0);
                  if (docIndex >= 1) {
                    const prevBlock = state.doc.child(docIndex - 1);
                    if (
                      prevBlock.type.name === "paragraph" &&
                      isTableHeaderPair(prevBlock.textContent, lineText)
                    ) {
                      const headers = splitTableRowRaw(prevBlock.textContent);
                      const prevStart = $from.before() - prevBlock.nodeSize;
                      const currEnd = $from.after();
                      const tableJson = {
                        type: "table",
                        content: [
                          {
                            type: "tableRow",
                            content: headers.map((h) => ({
                              type: "tableHeader",
                              content: [
                                {
                                  type: "paragraph",
                                  content: parseInlineMarkdown(
                                    h,
                                    propsRef.current.references,
                                    propsRef.current.recognizedCommands,
                                  ),
                                },
                              ],
                            })),
                          },
                          {
                            type: "tableRow",
                            content: headers.map(() => ({
                              type: "tableCell",
                              content: [{ type: "paragraph" }],
                            })),
                          },
                        ],
                      };
                      const tableNode = state.schema.nodeFromJSON(tableJson);
                      const tr = state.tr.replaceWith(
                        prevStart,
                        currEnd,
                        tableNode,
                      );
                      const firstRowSize = tableNode.child(0).nodeSize;
                      const targetPos = prevStart + 1 + firstRowSize + 2;
                      tr.setSelection(
                        TextSelection.near(
                          tr.doc.resolve(
                            Math.min(targetPos, tr.doc.content.size),
                          ),
                        ),
                      );
                      editor.view.dispatch(tr);
                      return true;
                    }
                  }
                }
              }

              // 7. Heading or plain paragraph: split into new paragraph below
              return editor.commands.splitBlock();
            },
            Tab: ({ editor }) => {
              if (propsRef.current.autocomplete["aria-expanded"]) {
                return false;
              }
              const { $from } = editor.state.selection;
              for (let d = $from.depth; d > 0; d--) {
                const name = $from.node(d).type.name;
                if (name === "tableRow") {
                  if (!editor.commands.goToNextCell()) {
                    editor.commands.addRowAfter();
                    editor.commands.goToNextCell();
                  }
                  return true;
                }
                if (name === "listItem" || name === "taskItem") {
                  return editor.commands.sinkListItem(name);
                }
              }
              return false;
            },
            "Shift-Tab": ({ editor }) => {
              const { $from } = editor.state.selection;
              for (let d = $from.depth; d > 0; d--) {
                const name = $from.node(d).type.name;
                if (name === "tableRow") {
                  return editor.commands.goToPreviousCell();
                }
                if (name === "listItem" || name === "taskItem") {
                  return editor.commands.liftListItem(name);
                }
              }
              return false;
            },
            ArrowDown: ({ editor }) => {
              if (propsRef.current.autocomplete["aria-expanded"]) {
                return false;
              }
              const { state } = editor;
              const { $from } = state.selection;
              for (let d = $from.depth; d > 0; d--) {
                const node = $from.node(d);
                if (node.type.name === "table") {
                  const rowDepth = d + 1;
                  if (
                    rowDepth <= $from.depth &&
                    $from.index(d) === node.childCount - 1 &&
                    $from.after(d) === state.doc.content.size
                  ) {
                    const afterPos = $from.after(d);
                    const tr = state.tr.insert(
                      afterPos,
                      state.schema.nodes.paragraph.create(),
                    );
                    tr.setSelection(TextSelection.create(tr.doc, afterPos + 1));
                    editor.view.dispatch(tr);
                    return true;
                  }
                }
              }
              return false;
            },
          };
        },
      }),
    ).current;

    const BulletListPreservingMarker = useRef(
      Extension.create({
        name: "bulletListMarkerAttr",
        addGlobalAttributes() {
          return [
            {
              types: ["bulletList"],
              attributes: {
                bullet: {
                  default: "-",
                  parseHTML: (el) => el.getAttribute("data-bullet") || "-",
                  renderHTML: (attrs) => ({
                    "data-bullet": attrs.bullet || "-",
                  }),
                },
              },
            },
          ];
        },
      }),
    ).current;

    const extensionsRef = useRef([
      ConfiguredStarterKit,
      ComposerCodeBlock,
      BulletListPreservingMarker,
      TaskList,
      ConfiguredTaskItem,
      ConfiguredTable,
      TableRow,
      TableHeader,
      TableCell,
      LinkPill,
      CommandPill,
      ReferenceChip,
      ComposerKeyboard,
    ]);
    const initialContentRef = useRef<JSONContent | null>(null);
    if (initialContentRef.current === null) {
      initialContentRef.current = parseMarkdownToDoc(
        props.value,
        props.references,
        props.recognizedCommands,
        props.activeCommandTriggerStart,
      );
    }
    const editor = useEditor(
      {
        immediatelyRender: true,
        editable: !props.disabled,
        extensions: extensionsRef.current,
        content: initialContentRef.current,
        onUpdate: ({ editor: instance }) => {
          if (syncingExternalRef.current || composingRef.current) return;
          const { from, to } = instance.state.selection;
          const serialized = serializeDocWithSelection(
            instance.state.doc,
            propsRef.current.references,
            from,
            to,
          );
          const caret: InlineSelection = {
            start: serialized.selectionStart,
            end: serialized.selectionEnd,
            afterPath: serialized.afterPath,
            selectedPaths: serialized.selectedPaths,
          };
          const afterCommandPill =
            instance.state.selection.empty &&
            instance.state.selection.$from.nodeBefore?.type.name ===
              "commandPill";
          const triggerOffset = afterCommandPill ? -1 : caret.start;
          const nextTrigger = composerTrigger(serialized.text, triggerOffset);
          const nextActiveCmdStart =
            nextTrigger?.kind === "commands" ? nextTrigger.start : null;
          lastSelectionRef.current = caret;
          const nextSig = signature(
            serialized.text,
            serialized.references,
            propsRef.current.recognizedCommands,
            nextActiveCmdStart,
          );
          const hasPendingCommandConversion =
            !!propsRef.current.recognizedCommands?.size &&
            serialized.text.includes("/") &&
            countDocCommandPills(instance.state.doc) !==
              countJsonCommandPills(
                parseMarkdownToDoc(
                  serialized.text,
                  serialized.references,
                  propsRef.current.recognizedCommands,
                  nextActiveCmdStart,
                ),
              );
          lastSerializedSig.current = hasPendingCommandConversion
            ? ""
            : nextSig;
          collectImageTargets();
          if (!propsRef.current.disabled) {
            propsRef.current.onEdit(
              serialized.text,
              serialized.references,
              caret,
            );
            propsRef.current.onInputState(serialized.text, triggerOffset);
          }
        },
        onSelectionUpdate: ({ editor: instance }) => {
          if (syncingExternalRef.current || composingRef.current) return;
          const { from, to } = instance.state.selection;
          const serialized = serializeDocWithSelection(
            instance.state.doc,
            propsRef.current.references,
            from,
            to,
          );
          lastSelectionRef.current = {
            start: serialized.selectionStart,
            end: serialized.selectionEnd,
            afterPath: serialized.afterPath,
            selectedPaths: serialized.selectedPaths,
          };
        },
      },
      [extensionsRef.current],
    );

    if (editor) {
      richContextMap.set(editor, {
        disabled: props.disabled,
        references: props.references,
        syncImagePreviews: collectImageTargets,
      });
    }

    const incomingSig = signature(
      props.value,
      props.references,
      props.recognizedCommands,
      props.activeCommandTriggerStart,
    );

    useLayoutEffect(() => {
      collectImageTargets();
      if (!shellRef.current) return;
      shellRef.current
        .querySelectorAll<HTMLButtonElement>("button[data-remove-reference]")
        .forEach((button) => {
          button.disabled = props.disabled;
        });
    }, [props.disabled, incomingSig]);

    const ariaExpanded = props.autocomplete["aria-expanded"];
    const ariaControls = props.autocomplete["aria-controls"];
    const ariaActiveDescendant = props.autocomplete["aria-activedescendant"];

    useEffect(() => {
      if (!editor) return;
      const editable = !props.disabled;
      if (editor.isEditable !== editable) {
        editor.setEditable(editable, false);
      }
    }, [editor, props.disabled]);

    useLayoutEffect(() => {
      if (!editor) return;
      const dom = editor.view.dom;
      dom.classList.add("composer-inline-input", "composer-rich-input");
      const syncAttr = (name: string, val: string | undefined) => {
        if (val === undefined) {
          if (dom.hasAttribute(name)) dom.removeAttribute(name);
        } else if (dom.getAttribute(name) !== val) {
          dom.setAttribute(name, val);
        }
      };
      syncAttr("role", "textbox");
      syncAttr("aria-multiline", "true");
      syncAttr("aria-autocomplete", "list");
      syncAttr("aria-label", props.label);
      syncAttr("aria-disabled", String(props.disabled));
      syncAttr("aria-expanded", String(ariaExpanded));
      syncAttr("aria-controls", ariaControls);
      syncAttr("aria-activedescendant", ariaActiveDescendant);
      syncAttr("data-placeholder", props.placeholder);
    }, [
      editor,
      props.disabled,
      props.label,
      props.placeholder,
      ariaExpanded,
      ariaControls,
      ariaActiveDescendant,
    ]);

    useLayoutEffect(() => {
      if (!editor || composingRef.current) return;
      if (incomingSig === lastSerializedSig.current) return;
      syncingExternalRef.current = true;
      try {
        const focused = editor.isFocused;
        const nextDoc = parseMarkdownToDoc(
          props.value,
          props.references,
          props.recognizedCommands,
          props.activeCommandTriggerStart,
        );
        editor.commands.setContent(nextDoc, { emitUpdate: false });
        lastSerializedSig.current = incomingSig;
        collectImageTargets();
        if (focused) {
          const pmPos = resolveDocPosFromMarkdownOffset(
            editor.state.doc,
            props.references,
            lastSelectionRef.current.start,
            lastSelectionRef.current.afterPath,
          );
          const tr = editor.state.tr.setSelection(
            TextSelection.near(editor.state.doc.resolve(pmPos)),
          );
          editor.view.dispatch(tr);
        }
      } finally {
        syncingExternalRef.current = false;
      }
    }, [editor, incomingSig]);

    useImperativeHandle(
      handle,
      () => ({
        focus: () => {
          if (!editor) return;
          editor.commands.focus();
        },
        selection: () => {
          if (!editor) return lastSelectionRef.current;
          const { from, to } = editor.state.selection;
          const serialized = serializeDocWithSelection(
            editor.state.doc,
            propsRef.current.references,
            from,
            to,
          );
          const sel: InlineSelection = {
            start: serialized.selectionStart,
            end: serialized.selectionEnd,
            afterPath: serialized.afterPath,
            selectedPaths: serialized.selectedPaths,
          };
          lastSelectionRef.current = sel;
          return sel;
        },
        setCaret: (offset: number, afterPath?: string) => {
          if (!editor) return;
          const pmPos = resolveDocPosFromMarkdownOffset(
            editor.state.doc,
            propsRef.current.references,
            offset,
            afterPath,
          );
          editor.commands.focus();
          const $pos = editor.state.doc.resolve(pmPos);
          const tr = editor.state.tr.setSelection(TextSelection.near($pos));
          editor.view.dispatch(tr);
          lastSelectionRef.current = {
            start: offset,
            end: offset,
            afterPath,
            selectedPaths: [],
          };
        },
      }),
      [editor],
    );

    return (
      <>
        <div
          ref={shellRef}
          className="composer-rich-shell"
          onPasteCapture={(event) => {
            if (props.disabled) return;
            props.onPaste(event);
          }}
          onDragOver={(event) => {
            if (!props.disabled && !dragHasFiles(event.dataTransfer)) {
              event.preventDefault();
            }
          }}
          onKeyDownCapture={(event) => {
            if (props.disabled) return;
            const target = event.target as Element | null;
            if (target?.closest("button")) return;
            if (
              composingRef.current ||
              event.nativeEvent.isComposing ||
              event.keyCode === 229
            ) {
              return;
            }
            if (props.autocomplete["aria-expanded"]) {
              if (
                event.key === "Escape" ||
                event.key === "ArrowDown" ||
                event.key === "ArrowUp" ||
                (event.key === "Enter" && !event.shiftKey) ||
                (event.key === "Tab" &&
                  !event.shiftKey &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  !event.altKey)
              ) {
                event.stopPropagation();
                props.onKeyDown(event);
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.stopPropagation();
              props.onKeyDown(event);
            }
          }}
          onKeyUp={(event) => {
            if (!editor || composingRef.current) return;
            if (
              [
                "ArrowLeft",
                "ArrowRight",
                "ArrowUp",
                "ArrowDown",
                "Home",
                "End",
              ].includes(event.key)
            ) {
              const { from, to } = editor.state.selection;
              const serialized = serializeDocWithSelection(
                editor.state.doc,
                props.references,
                from,
                to,
              );
              lastSelectionRef.current = {
                start: serialized.selectionStart,
                end: serialized.selectionEnd,
                afterPath: serialized.afterPath,
                selectedPaths: serialized.selectedPaths,
              };
              const afterCommandPill =
                editor.state.selection.empty &&
                editor.state.selection.$from.nodeBefore?.type.name ===
                  "commandPill";
              props.onInputState(
                serialized.text,
                afterCommandPill ? -1 : serialized.selectionStart,
              );
            }
          }}
          onClick={(event) => {
            if (!editor || composingRef.current) return;
            const target = event.target as Element | null;
            const cmdPill = target?.closest<HTMLElement>("[data-command-name]");
            if (cmdPill) {
              event.preventDefault();
              const pos = editor.view.posAtDOM(cmdPill, 0);
              if (pos >= 0 && pos < editor.state.doc.content.size) {
                const node = editor.state.doc.nodeAt(pos);
                if (node?.type.name === "commandPill") {
                  editor.view.dispatch(
                    editor.state.tr.setSelection(
                      NodeSelection.create(editor.state.doc, pos),
                    ),
                  );
                  editor.commands.focus();
                  return;
                }
              }
            }
            const pill = target?.closest<HTMLElement>("[data-link-href]");
            if (pill) {
              event.preventDefault();
              const href = pill.dataset.linkHref;
              if ((event.metaKey || event.ctrlKey) && href) {
                if (native) {
                  void invoke("open_external_url", { url: href }).catch(
                    () => undefined,
                  );
                } else {
                  window.open(href, "_blank", "noopener,noreferrer");
                }
                return;
              }
              const pos = editor.view.posAtDOM(pill, 0);
              if (pos >= 0 && pos < editor.state.doc.content.size) {
                const node = editor.state.doc.nodeAt(pos);
                if (node?.type.name === "linkPill") {
                  editor.view.dispatch(
                    editor.state.tr.setSelection(
                      NodeSelection.create(editor.state.doc, pos),
                    ),
                  );
                  editor.commands.focus();
                  return;
                }
              }
            }
            const { from, to } = editor.state.selection;
            const serialized = serializeDocWithSelection(
              editor.state.doc,
              props.references,
              from,
              to,
            );
            lastSelectionRef.current = {
              start: serialized.selectionStart,
              end: serialized.selectionEnd,
              afterPath: serialized.afterPath,
              selectedPaths: serialized.selectedPaths,
            };
            const afterCommandPill =
              editor.state.selection.empty &&
              editor.state.selection.$from.nodeBefore?.type.name ===
                "commandPill";
            props.onInputState(
              serialized.text,
              afterCommandPill ? -1 : serialized.selectionStart,
            );
          }}
          onCompositionStart={() => {
            composingRef.current = true;
            props.onCompositionStart();
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            if (!editor) return;
            const { from, to } = editor.state.selection;
            const serialized = serializeDocWithSelection(
              editor.state.doc,
              props.references,
              from,
              to,
            );
            const caret: InlineSelection = {
              start: serialized.selectionStart,
              end: serialized.selectionEnd,
              afterPath: serialized.afterPath,
              selectedPaths: serialized.selectedPaths,
            };
            const afterCommandPill =
              editor.state.selection.empty &&
              editor.state.selection.$from.nodeBefore?.type.name ===
                "commandPill";
            const triggerOffset = afterCommandPill ? -1 : caret.start;
            const nextTrigger = composerTrigger(serialized.text, triggerOffset);
            const nextActiveCmdStart =
              nextTrigger?.kind === "commands" ? nextTrigger.start : null;
            lastSelectionRef.current = caret;
            const nextSig = signature(
              serialized.text,
              serialized.references,
              props.recognizedCommands,
              nextActiveCmdStart,
            );
            const hasPendingCommandConversion =
              !!props.recognizedCommands?.size &&
              serialized.text.includes("/") &&
              countDocCommandPills(editor.state.doc) !==
                countJsonCommandPills(
                  parseMarkdownToDoc(
                    serialized.text,
                    serialized.references,
                    props.recognizedCommands,
                    nextActiveCmdStart,
                  ),
                );
            lastSerializedSig.current = hasPendingCommandConversion
              ? ""
              : nextSig;
            props.onCompositionEnd(serialized.text, triggerOffset);
            if (!props.disabled) {
              props.onEdit(serialized.text, serialized.references, caret);
            }
          }}
        >
          <EditorContent editor={editor} />
        </div>
        {imageTargets.map(({ entry, target }) =>
          createPortal(props.renderImage(entry), target, entry.path),
        )}
      </>
    );
  },
);
