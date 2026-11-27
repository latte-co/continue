import type { JSONContent } from "@tiptap/core";
import type { Mark, Node as ProseMirrorNode } from "@tiptap/pm/model";
import type {
  CommandPillIconKind,
  ComposerCommandTokenMeta,
} from "./composerActions";
import type { ComposerReference } from "./pasteAttachments";

export type { CommandPillIconKind, ComposerCommandTokenMeta };

const REF_OPEN = "\uE000";
const REF_CLOSE = "\uE001";
const CMD_SKIP = "\uE002";
const REF_TOKEN_GLOBAL = /\uE000(\d+)\uE001/g;

const ORDERED_ITEM_RE = /^([ \t]*)(\d{1,9})\.[ \t](.*)$/;
const TASK_ITEM_RE = /^([ \t]*)([-*+])[ \t]+\[([ xX])\][ \t](.*)$/;
const TASK_ITEM_EMPTY_RE = /^([ \t]*)([-*+])[ \t]+\[([ xX])\][ \t]*$/;
const BULLET_ITEM_RE = /^([ \t]*)([-*+])[ \t](.*)$/;
const HEADING_RE = /^[ \t]{0,3}(#{1,6})[ \t](.*)$/;
const BLOCKQUOTE_RE = /^[ \t]{0,3}>(?:[ \t]?(.*))?$/;
const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_SPACE_TRIGGER_RE =
  /^[ \t]{0,3}(`{3,}|~{3,})([A-Za-z0-9_+-]*)[ \t]+$/;
const HR_RE = /^[ \t]{0,3}(?:---+|\*\*\*+|___+)[ \t]*$/;
const SINGLE_URL_RE = /^https?:\/\/[^\s<>]+$/i;

export function isTableDelimiterLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|") || !trimmed.includes("-")) return false;
  const cells = splitTableRowRaw(trimmed);
  if (cells.length === 0) return false;
  const hasOuterPipes = trimmed.startsWith("|") && trimmed.endsWith("|");
  if (cells.length < 2 && !hasOuterPipes) return false;
  return cells.every((cell) => /^:?-{2,}:?$/.test(cell.trim()));
}

export function splitTableRowRaw(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) {
    trimmed = trimmed.slice(0, -1);
  }
  const cells: string[] = [];
  let current = "";
  let inCode = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "\\" && i + 1 < trimmed.length && !inCode) {
      if (trimmed[i + 1] === "|") {
        current += "|";
        i++;
        continue;
      }
    }
    if (ch === "`") {
      inCode = !inCode;
      current += ch;
      continue;
    }
    if (ch === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

export function isTableHeaderPair(
  headerLine: string,
  delimiterLine: string,
): boolean {
  if (!headerLine.includes("|") || !isTableDelimiterLine(delimiterLine)) {
    return false;
  }
  const headerCells = splitTableRowRaw(headerLine);
  const delimCells = splitTableRowRaw(delimiterLine);
  return headerCells.length >= 1 && headerCells.length === delimCells.length;
}

function hasRecognizedSlashTokenInLine(
  line: string,
  lineOffset: number,
  recognizedCommands: ReadonlyMap<string, ComposerCommandTokenMeta>,
  activeCommandTriggerStart?: number | null,
): boolean {
  let i = 0;
  while (i < line.length) {
    if (line[i] === "`") {
      const closeTick = line.indexOf("`", i + 1);
      if (closeTick > i + 1) {
        i = closeTick + 1;
        continue;
      }
    }
    if (
      line[i] === "/" &&
      (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")
    ) {
      const slashAbs = lineOffset + i;
      let end = i + 1;
      while (end < line.length && line[end] !== " " && line[end] !== "\t") {
        end++;
      }
      const name = line.slice(i + 1, end);
      if (
        name.length > 0 &&
        !name.includes("/") &&
        slashAbs !== activeCommandTriggerStart &&
        recognizedCommands.has(name)
      ) {
        return true;
      }
      i = end;
      continue;
    }
    i++;
  }
  return false;
}

/**
 * Detects whether a composer draft contains rich Markdown syntax or recognized
 * slash command/skill tokens that should activate the WYSIWYG rich editor
 * instead of the plain `<textarea>`.
 */
export function hasRichComposerMarkdown(
  text: string,
  recognizedCommands?: ReadonlyMap<string, ComposerCommandTokenMeta>,
  activeCommandTriggerStart?: number | null,
): boolean {
  if (!text) return false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      ORDERED_ITEM_RE.test(line) ||
      TASK_ITEM_RE.test(line) ||
      BULLET_ITEM_RE.test(line) ||
      HEADING_RE.test(line) ||
      BLOCKQUOTE_RE.test(line) ||
      HR_RE.test(line) ||
      FENCE_SPACE_TRIGGER_RE.test(line)
    ) {
      return true;
    }
    if (FENCE_OPEN_RE.test(line) && i < lines.length - 1) {
      return true;
    }
    if (i + 1 < lines.length && isTableHeaderPair(line, lines[i + 1])) {
      return true;
    }
  }
  if (/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/.test(text)) return true;
  if (/`([^`\n]+)`/.test(text)) return true;
  if (/\*\*([^\n*]+)\*\*/.test(text)) return true;
  if (/~~([^\n~]+)~~/.test(text)) return true;
  if (/(?:^|[^\w*])\*([^\s*][^*\n]*?[^\s*]|[^\s*])\*(?!\*)/.test(text)) {
    return true;
  }
  if (recognizedCommands && recognizedCommands.size > 0) {
    let offset = 0;
    for (const line of lines) {
      if (
        hasRecognizedSlashTokenInLine(
          line,
          offset,
          recognizedCommands,
          activeCommandTriggerStart,
        )
      ) {
        return true;
      }
      offset += line.length + 1;
    }
  }
  return false;
}

function injectReferenceTokens(
  text: string,
  references: ComposerReference[],
  activeCommandTriggerStart?: number | null,
): string {
  const skipSlash =
    activeCommandTriggerStart !== null &&
    activeCommandTriggerStart !== undefined &&
    activeCommandTriggerStart >= 0 &&
    activeCommandTriggerStart < text.length &&
    text[activeCommandTriggerStart] === "/"
      ? activeCommandTriggerStart
      : null;
  if (!references.length && skipSlash === null) return text;
  const sorted = references
    .map((entry, index) => ({
      index,
      offset: Math.max(
        0,
        Math.min(text.length, entry.inlineOffset ?? text.length),
      ),
    }))
    .sort((a, b) => a.offset - b.offset || a.index - b.index);
  let out = "";
  let cursor = 0;
  const appendSlice = (from: number, to: number) => {
    if (skipSlash !== null && skipSlash >= from && skipSlash < to) {
      out += text.slice(from, skipSlash + 1);
      out += CMD_SKIP;
      out += text.slice(skipSlash + 1, to);
    } else {
      out += text.slice(from, to);
    }
  };
  for (const { index, offset } of sorted) {
    appendSlice(cursor, offset);
    out += `${REF_OPEN}${index}${REF_CLOSE}`;
    cursor = offset;
  }
  appendSlice(cursor, text.length);
  return out;
}

function stripReferenceTokens(
  raw: string,
  references: ComposerReference[],
): { text: string; nodes: JSONContent[] } {
  const cleaned = raw.includes(CMD_SKIP) ? raw.replaceAll(CMD_SKIP, "") : raw;
  const nodes: JSONContent[] = [];
  let plain = "";
  let last = 0;
  REF_TOKEN_GLOBAL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REF_TOKEN_GLOBAL.exec(cleaned)) !== null) {
    if (match.index > last) {
      const chunk = cleaned.slice(last, match.index);
      plain += chunk;
      nodes.push({ type: "text", text: chunk });
    }
    const refIndex = Number(match[1]);
    const entry = references[refIndex];
    if (entry) {
      nodes.push({
        type: "referenceChip",
        attrs: {
          path: entry.path,
          name: entry.name,
          directory: entry.directory,
          mimeType: entry.mimeType ?? null,
        },
      });
    }
    last = match.index + match[0].length;
  }
  if (last < cleaned.length) {
    const tail = cleaned.slice(last);
    plain += tail;
    nodes.push({ type: "text", text: tail });
  }
  return { text: plain, nodes };
}

function addMark(nodes: JSONContent[], markType: string): JSONContent[] {
  return nodes.map((node) => {
    if (node.type !== "text") return node;
    const existing = node.marks ?? [];
    if (existing.some((m) => m.type === markType)) return node;
    return { ...node, marks: [...existing, { type: markType }] };
  });
}

function hasSlashWordBoundaryBefore(raw: string, index: number): boolean {
  let k = index - 1;
  while (k >= 0 && raw[k] === REF_CLOSE) {
    const open = raw.lastIndexOf(REF_OPEN, k - 1);
    if (open < 0 || !/^\d+$/.test(raw.slice(open + 1, k))) break;
    k = open - 1;
  }
  return k < 0 || raw[k] === " " || raw[k] === "\t";
}

function hasSlashWordBoundaryAfter(raw: string, index: number): boolean {
  let k = index;
  while (k < raw.length && raw[k] === REF_OPEN) {
    const close = raw.indexOf(REF_CLOSE, k + 1);
    if (close < 0 || !/^\d+$/.test(raw.slice(k + 1, close))) break;
    k = close + 1;
  }
  return k >= raw.length || raw[k] === " " || raw[k] === "\t";
}

export function parseInlineMarkdown(
  raw: string,
  references: ComposerReference[],
  recognizedCommands?: ReadonlyMap<string, ComposerCommandTokenMeta>,
): JSONContent[] {
  if (!raw) return [];
  const out: JSONContent[] = [];
  let i = 0;
  let buffer = "";

  const flush = () => {
    if (!buffer) return;
    out.push(...stripReferenceTokens(buffer, references).nodes);
    buffer = "";
  };

  while (i < raw.length) {
    if (raw[i] === REF_OPEN) {
      const closeIdx = raw.indexOf(REF_CLOSE, i + 1);
      if (closeIdx > i + 1) {
        const idxStr = raw.slice(i + 1, closeIdx);
        if (/^\d+$/.test(idxStr)) {
          flush();
          const entry = references[Number(idxStr)];
          if (entry) {
            out.push({
              type: "referenceChip",
              attrs: {
                path: entry.path,
                name: entry.name,
                directory: entry.directory,
                mimeType: entry.mimeType ?? null,
              },
            });
          }
          i = closeIdx + 1;
          continue;
        }
      }
    }

    // Recognized slash command / skill pill: /name at whitespace boundary
    if (
      recognizedCommands &&
      recognizedCommands.size > 0 &&
      raw[i] === "/" &&
      raw[i + 1] !== CMD_SKIP &&
      hasSlashWordBoundaryBefore(raw, i)
    ) {
      let end = i + 1;
      while (
        end < raw.length &&
        raw[end] !== " " &&
        raw[end] !== "\t" &&
        raw[end] !== REF_OPEN &&
        raw[end] !== CMD_SKIP
      ) {
        end++;
      }
      if (raw[end] !== CMD_SKIP && hasSlashWordBoundaryAfter(raw, end)) {
        const name = raw.slice(i + 1, end);
        const meta =
          name && !name.includes("/")
            ? recognizedCommands.get(name)
            : undefined;
        if (meta) {
          flush();
          out.push({
            type: "commandPill",
            attrs: {
              name: meta.name,
              icon: meta.icon,
              title: meta.title ?? "",
            },
          });
          i = end;
          continue;
        }
      }
    }

    // Inline code: `...`
    if (raw[i] === "`") {
      const closeTick = raw.indexOf("`", i + 1);
      if (closeTick > i + 1) {
        const inner = raw.slice(i + 1, closeTick);
        if (!inner.includes("\n")) {
          flush();
          const stripped = stripReferenceTokens(inner, references);
          for (const node of stripped.nodes) {
            if (node.type === "text" && node.text) {
              out.push({
                type: "text",
                text: node.text,
                marks: [{ type: "code" }],
              });
            } else {
              out.push(node);
            }
          }
          i = closeTick + 1;
          continue;
        }
      }
    }

    // Link: [label](https://...)
    if (raw[i] === "[") {
      const linkMatch = raw
        .slice(i)
        .match(/^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/);
      if (linkMatch) {
        flush();
        const rawLabel = linkMatch[1];
        const href = linkMatch[2];
        const cleanLabel = rawLabel
          .replace(REF_TOKEN_GLOBAL, "")
          .replaceAll(CMD_SKIP, "");
        out.push({
          type: "linkPill",
          attrs: { label: cleanLabel || href, href },
        });
        // Preserve any inline references that happened to sit inside the label
        REF_TOKEN_GLOBAL.lastIndex = 0;
        let refMatch: RegExpExecArray | null;
        while ((refMatch = REF_TOKEN_GLOBAL.exec(rawLabel)) !== null) {
          const entry = references[Number(refMatch[1])];
          if (entry) {
            out.push({
              type: "referenceChip",
              attrs: {
                path: entry.path,
                name: entry.name,
                directory: entry.directory,
                mimeType: entry.mimeType ?? null,
              },
            });
          }
        }
        i += linkMatch[0].length;
        continue;
      }
    }

    // Bold: **...**
    if (raw.startsWith("**", i)) {
      const closeBold = raw.indexOf("**", i + 2);
      if (closeBold > i + 2) {
        const inner = raw.slice(i + 2, closeBold);
        if (!inner.includes("\n")) {
          flush();
          out.push(
            ...addMark(
              parseInlineMarkdown(inner, references, recognizedCommands),
              "bold",
            ),
          );
          i = closeBold + 2;
          continue;
        }
      }
    }

    // Strike: ~~...~~
    if (raw.startsWith("~~", i)) {
      const closeStrike = raw.indexOf("~~", i + 2);
      if (closeStrike > i + 2) {
        const inner = raw.slice(i + 2, closeStrike);
        if (!inner.includes("\n")) {
          flush();
          out.push(
            ...addMark(
              parseInlineMarkdown(inner, references, recognizedCommands),
              "strike",
            ),
          );
          i = closeStrike + 2;
          continue;
        }
      }
    }

    // Italic: *...*
    if (
      raw[i] === "*" &&
      raw[i + 1] !== "*" &&
      raw[i + 1] !== " " &&
      raw[i + 1] !== undefined &&
      (i === 0 || !/[\w*]/.test(raw[i - 1]))
    ) {
      let closeStar = i + 1;
      let found = -1;
      while ((closeStar = raw.indexOf("*", closeStar)) !== -1) {
        if (
          raw[closeStar - 1] !== " " &&
          raw[closeStar - 1] !== "*" &&
          raw[closeStar + 1] !== "*"
        ) {
          found = closeStar;
          break;
        }
        closeStar++;
      }
      if (found > i + 1) {
        const inner = raw.slice(i + 1, found);
        if (!inner.includes("\n")) {
          flush();
          out.push(
            ...addMark(
              parseInlineMarkdown(inner, references, recognizedCommands),
              "italic",
            ),
          );
          i = found + 1;
          continue;
        }
      }
    }

    buffer += raw[i];
    i++;
  }

  flush();
  return out;
}

function paragraphNode(
  raw: string,
  references: ComposerReference[],
  recognizedCommands?: ReadonlyMap<string, ComposerCommandTokenMeta>,
): JSONContent {
  const content = parseInlineMarkdown(raw, references, recognizedCommands);
  return content.length
    ? { type: "paragraph", content }
    : { type: "paragraph" };
}

type ParsedListLine =
  | {
      kind: "taskList";
      indent: number;
      bullet: string;
      checked: boolean;
      body: string;
    }
  | {
      kind: "bulletList";
      indent: number;
      bullet: string;
      body: string;
    }
  | {
      kind: "orderedList";
      indent: number;
      start: number;
      body: string;
    };

function indentWidth(ws: string): number {
  let width = 0;
  for (const ch of ws) width += ch === "\t" ? 2 : 1;
  return width;
}

function matchListLine(line: string): ParsedListLine | null {
  const taskMatch = line.match(TASK_ITEM_RE);
  if (taskMatch) {
    return {
      kind: "taskList",
      indent: indentWidth(taskMatch[1]),
      bullet: taskMatch[2],
      checked: taskMatch[3].toLowerCase() === "x",
      body: taskMatch[4],
    };
  }
  const emptyTask = line.match(TASK_ITEM_EMPTY_RE);
  if (emptyTask && line.endsWith(" ")) {
    return {
      kind: "taskList",
      indent: indentWidth(emptyTask[1]),
      bullet: emptyTask[2],
      checked: emptyTask[3].toLowerCase() === "x",
      body: "",
    };
  }
  const bulletMatch = line.match(BULLET_ITEM_RE);
  if (bulletMatch) {
    return {
      kind: "bulletList",
      indent: indentWidth(bulletMatch[1]),
      bullet: bulletMatch[2],
      body: bulletMatch[3],
    };
  }
  const orderedMatch = line.match(ORDERED_ITEM_RE);
  if (orderedMatch) {
    return {
      kind: "orderedList",
      indent: indentWidth(orderedMatch[1]),
      start: Number(orderedMatch[2]) || 1,
      body: orderedMatch[3],
    };
  }
  return null;
}

function parseListCluster(
  lines: string[],
  startIndex: number,
  references: ComposerReference[],
  recognizedCommands?: ReadonlyMap<string, ComposerCommandTokenMeta>,
): { node: JSONContent; nextIndex: number } {
  const first = matchListLine(lines[startIndex])!;

  function parseAtIndent(
    idx: number,
    baseIndent: number,
    expectedKind: ParsedListLine["kind"],
  ): { node: JSONContent; nextIdx: number } {
    const firstAtLevel = matchListLine(lines[idx])!;
    const items: JSONContent[] = [];
    let cursor = idx;

    while (cursor < lines.length) {
      const parsed = matchListLine(lines[cursor]);
      if (!parsed || parsed.indent < baseIndent) break;
      if (parsed.indent === baseIndent && parsed.kind !== expectedKind) break;
      if (parsed.indent > baseIndent) {
        if (!items.length) break;
        const nested = parseAtIndent(cursor, parsed.indent, parsed.kind);
        items[items.length - 1].content = [
          ...(items[items.length - 1].content ?? [{ type: "paragraph" }]),
          nested.node,
        ];
        cursor = nested.nextIdx;
        continue;
      }

      const itemParagraph = paragraphNode(
        parsed.body,
        references,
        recognizedCommands,
      );
      if (parsed.kind === "taskList") {
        items.push({
          type: "taskItem",
          attrs: { checked: parsed.checked },
          content: [itemParagraph],
        });
      } else {
        items.push({
          type: "listItem",
          content: [itemParagraph],
        });
      }
      cursor++;
    }

    if (expectedKind === "orderedList" && firstAtLevel.kind === "orderedList") {
      return {
        node: {
          type: "orderedList",
          attrs: { start: firstAtLevel.start },
          content: items,
        },
        nextIdx: cursor,
      };
    }
    if (expectedKind === "taskList") {
      return {
        node: {
          type: "taskList",
          content: items,
        },
        nextIdx: cursor,
      };
    }
    return {
      node: {
        type: "bulletList",
        attrs: {
          bullet:
            firstAtLevel.kind === "bulletList" ? firstAtLevel.bullet : "-",
        },
        content: items,
      },
      nextIdx: cursor,
    };
  }

  const result = parseAtIndent(startIndex, first.indent, first.kind);
  return { node: result.node, nextIndex: result.nextIdx };
}

export function parseMarkdownToDoc(
  text: string,
  references: ComposerReference[] = [],
  recognizedCommands?: ReadonlyMap<string, ComposerCommandTokenMeta>,
  activeCommandTriggerStart?: number | null,
): JSONContent {
  const tokenized = injectReferenceTokens(
    text,
    references,
    activeCommandTriggerStart,
  );
  const lines = tokenized.split("\n");
  const blocks: JSONContent[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const cleanCheckLine = line.includes(CMD_SKIP)
      ? line.replaceAll(CMD_SKIP, "")
      : line;

    // 1. Single-line fence space trigger (e.g. "```ts ")
    const spaceFence = cleanCheckLine.match(FENCE_SPACE_TRIGGER_RE);
    if (spaceFence && i === lines.length - 1) {
      const language = spaceFence[2] || "";
      blocks.push({
        type: "codeBlock",
        attrs: { language },
      });
      i++;
      continue;
    }

    // 2. Multi-line fenced code block
    const fenceOpen = cleanCheckLine.match(FENCE_OPEN_RE);
    if (fenceOpen && i < lines.length - 1) {
      const fenceChars = fenceOpen[1];
      const fenceChar = fenceChars[0];
      const language = fenceOpen[2] || "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length) {
        const candidate = lines[i]
          .replace(REF_TOKEN_GLOBAL, "")
          .replaceAll(CMD_SKIP, "");
        const closeRe = new RegExp(
          `^[ \\t]{0,3}${fenceChar}{${fenceChars.length},}[ \\t]*$`,
        );
        if (closeRe.test(candidate)) {
          i++;
          break;
        }
        codeLines.push(candidate);
        i++;
      }
      const codeText = codeLines.join("\n");
      blocks.push({
        type: "codeBlock",
        attrs: { language },
        content: codeText ? [{ type: "text", text: codeText }] : undefined,
      });
      continue;
    }

    // 3. GFM Table
    if (i + 1 < lines.length && isTableHeaderPair(line, lines[i + 1])) {
      const headerCells = splitTableRowRaw(line);
      const colCount = headerCells.length;
      const headerRow: JSONContent = {
        type: "tableRow",
        content: headerCells.map((cell) => ({
          type: "tableHeader",
          content: [paragraphNode(cell, references, recognizedCommands)],
        })),
      };
      const rows: JSONContent[] = [headerRow];
      i += 2;
      while (i < lines.length) {
        const rowLine = lines[i];
        if (
          !rowLine.trim() ||
          !rowLine.includes("|") ||
          FENCE_OPEN_RE.test(rowLine)
        ) {
          break;
        }
        const cells = splitTableRowRaw(rowLine);
        const normalized = Array.from(
          { length: colCount },
          (_, c) => cells[c] ?? "",
        );
        rows.push({
          type: "tableRow",
          content: normalized.map((cell) => ({
            type: "tableCell",
            content: [paragraphNode(cell, references, recognizedCommands)],
          })),
        });
        i++;
      }
      if (rows.length === 1) {
        rows.push({
          type: "tableRow",
          content: Array.from({ length: colCount }, () => ({
            type: "tableCell",
            content: [{ type: "paragraph" }],
          })),
        });
      }
      blocks.push({ type: "table", content: rows });
      continue;
    }

    // 4. Lists (ordered, bullet, task)
    if (matchListLine(line)) {
      const cluster = parseListCluster(
        lines,
        i,
        references,
        recognizedCommands,
      );
      blocks.push(cluster.node);
      i = cluster.nextIndex;
      continue;
    }

    // 5. Heading
    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      const level = Math.min(6, headingMatch[1].length);
      const content = parseInlineMarkdown(
        headingMatch[2],
        references,
        recognizedCommands,
      );
      blocks.push({
        type: "heading",
        attrs: { level },
        content: content.length ? content : undefined,
      });
      i++;
      continue;
    }

    // 6. Horizontal rule
    if (HR_RE.test(cleanCheckLine)) {
      blocks.push({ type: "horizontalRule" });
      i++;
      continue;
    }

    // 7. Blockquote
    const quoteMatch = line.match(BLOCKQUOTE_RE);
    if (quoteMatch && line.trimStart().startsWith(">")) {
      const quoteParagraphs: JSONContent[] = [];
      while (i < lines.length) {
        const m = lines[i].match(BLOCKQUOTE_RE);
        if (!m || !lines[i].trimStart().startsWith(">")) break;
        quoteParagraphs.push(
          paragraphNode(m[1] ?? "", references, recognizedCommands),
        );
        i++;
      }
      blocks.push({
        type: "blockquote",
        content: quoteParagraphs,
      });
      continue;
    }

    // 8. Default Paragraph
    blocks.push(paragraphNode(line, references, recognizedCommands));
    i++;
  }

  return {
    type: "doc",
    content: blocks.length ? blocks : [{ type: "paragraph" }],
  };
}

export interface AnchorPoint {
  pmPos: number;
  mdOffset: number;
  afterPath?: string;
}

export interface SerializedComposerDoc {
  text: string;
  references: ComposerReference[];
  anchors: AnchorPoint[];
  selectionStart: number;
  selectionEnd: number;
  afterPath?: string;
  selectedPaths: string[];
}

function markWrapTokens(marks: readonly Mark[]): {
  open: string;
  close: string;
} {
  let open = "";
  let close = "";
  const hasCode = marks.some((m) => m.type.name === "code");
  if (hasCode) {
    return { open: "`", close: "`" };
  }
  for (const mark of marks) {
    if (mark.type.name === "bold") {
      open += "**";
      close = `**${close}`;
    } else if (mark.type.name === "italic") {
      open += "*";
      close = `*${close}`;
    } else if (mark.type.name === "strike") {
      open += "~~";
      close = `~~${close}`;
    }
  }
  return { open, close };
}

/**
 * Walks a live ProseMirror `doc` in one pass, producing the canonical GFM
 * Markdown string, updated inline reference offsets, and exact bidirectional
 * ProseMirror <-> Markdown cursor anchors.
 */
export function serializeDocWithSelection(
  doc: ProseMirrorNode,
  knownReferences: ComposerReference[],
  selFrom = 0,
  selTo = selFrom,
): SerializedComposerDoc {
  const byPath = new Map(knownReferences.map((entry) => [entry.path, entry]));
  const references: ComposerReference[] = [];
  const anchors: AnchorPoint[] = [];
  const selectedPaths: string[] = [];
  let out = "";

  const pushAnchor = (pmPos: number, afterPath?: string) => {
    anchors.push({ pmPos, mdOffset: out.length, afterPath });
  };

  function serializeInlineContainer(
    parent: ProseMirrorNode,
    parentStartPos: number,
    inTableCell = false,
  ) {
    const innerStart = parentStartPos + 1;
    pushAnchor(innerStart);
    let pos = innerStart;
    for (let i = 0; i < parent.childCount; i++) {
      const child = parent.child(i);
      if (child.isText) {
        const text = child.text ?? "";
        const { open, close } = markWrapTokens(child.marks);
        out += open;
        for (let k = 0; k < text.length; k++) {
          pushAnchor(pos + k);
          const ch = text[k];
          if (inTableCell && ch === "|" && !open.includes("`")) {
            out += "\\|";
          } else if (inTableCell && ch === "\n") {
            out += " ";
          } else {
            out += ch;
          }
        }
        pushAnchor(pos + text.length);
        out += close;
        if (close) pushAnchor(pos + text.length);
        pos += child.nodeSize;
      } else if (child.type.name === "linkPill") {
        pushAnchor(pos);
        const label = String(child.attrs.label ?? "");
        const href = String(child.attrs.href ?? "");
        const safeLabel = inTableCell ? label.replace(/\|/g, "\\|") : label;
        out += `[${safeLabel}](${href})`;
        pushAnchor(pos + child.nodeSize);
        pos += child.nodeSize;
      } else if (child.type.name === "commandPill") {
        pushAnchor(pos);
        const name = String(child.attrs.name ?? "");
        const safeName = inTableCell ? name.replace(/\|/g, "\\|") : name;
        out += `/${safeName}`;
        pushAnchor(pos + child.nodeSize);
        pos += child.nodeSize;
      } else if (child.type.name === "referenceChip") {
        const refPath = String(child.attrs.path ?? "");
        pushAnchor(pos);
        const existing = byPath.get(refPath);
        const entry: ComposerReference = existing
          ? { ...existing, inlineOffset: out.length }
          : {
              path: refPath,
              name: String(
                child.attrs.name ?? refPath.split("/").at(-1) ?? refPath,
              ),
              directory: Boolean(child.attrs.directory),
              mimeType:
                typeof child.attrs.mimeType === "string"
                  ? child.attrs.mimeType
                  : undefined,
              inlineOffset: out.length,
            };
        references.push(entry);
        if (
          selFrom < selTo &&
          pos >= selFrom &&
          pos + child.nodeSize <= selTo
        ) {
          selectedPaths.push(refPath);
        }
        pushAnchor(pos + child.nodeSize, refPath);
        pos += child.nodeSize;
      } else if (child.type.name === "hardBreak") {
        pushAnchor(pos);
        out += inTableCell ? " " : "\n";
        pushAnchor(pos + child.nodeSize);
        pos += child.nodeSize;
      } else {
        pos += child.nodeSize;
      }
    }
  }

  function serializeList(
    listNode: ProseMirrorNode,
    listPos: number,
    depth: number,
  ) {
    const indent = "  ".repeat(depth);
    const kind = listNode.type.name;
    const startNum =
      kind === "orderedList" ? Number(listNode.attrs.start ?? 1) : 1;
    const bullet =
      kind === "bulletList" ? String(listNode.attrs.bullet ?? "-") : "-";

    let itemPos = listPos + 1;
    for (let i = 0; i < listNode.childCount; i++) {
      if (i > 0) out += "\n";
      const item = listNode.child(i);
      pushAnchor(itemPos);
      if (kind === "orderedList") {
        out += `${indent}${startNum + i}. `;
      } else if (kind === "taskList") {
        const checked = Boolean(item.attrs.checked);
        out += `${indent}- [${checked ? "x" : " "}] `;
      } else {
        out += `${indent}${bullet} `;
      }

      let childPos = itemPos + 1;
      for (let c = 0; c < item.childCount; c++) {
        const sub = item.child(c);
        if (c === 0 && sub.type.name === "paragraph") {
          serializeInlineContainer(sub, childPos, false);
        } else if (
          sub.type.name === "orderedList" ||
          sub.type.name === "bulletList" ||
          sub.type.name === "taskList"
        ) {
          out += "\n";
          serializeList(sub, childPos, depth + 1);
        } else if (sub.type.name === "paragraph") {
          out += "\n" + indent + "  ";
          serializeInlineContainer(sub, childPos, false);
        }
        childPos += sub.nodeSize;
      }
      itemPos += item.nodeSize;
    }
  }

  function serializeTable(tableNode: ProseMirrorNode, tablePos: number) {
    let rowPos = tablePos + 1;
    let colCount = 0;
    for (let r = 0; r < tableNode.childCount; r++) {
      const row = tableNode.child(r);
      if (r === 0) colCount = row.childCount;
      if (r > 0) out += "\n";
      out += "| ";
      let cellPos = rowPos + 1;
      for (let c = 0; c < row.childCount; c++) {
        if (c > 0) out += " | ";
        const cell = row.child(c);
        pushAnchor(cellPos);
        let innerPos = cellPos + 1;
        for (let p = 0; p < cell.childCount; p++) {
          const para = cell.child(p);
          if (p > 0) out += " ";
          if (para.type.name === "paragraph") {
            serializeInlineContainer(para, innerPos, true);
          }
          innerPos += para.nodeSize;
        }
        cellPos += cell.nodeSize;
      }
      out += " |";
      if (r === 0 && colCount > 0) {
        out += `\n| ${Array.from({ length: colCount }, () => "---").join(" | ")} |`;
      }
      rowPos += row.nodeSize;
    }
  }

  function serializeBlock(block: ProseMirrorNode, blockPos: number) {
    pushAnchor(blockPos);
    const typeName = block.type.name;
    if (typeName === "paragraph") {
      serializeInlineContainer(block, blockPos, false);
      return;
    }
    if (typeName === "heading") {
      const level = Math.max(1, Math.min(6, Number(block.attrs.level ?? 1)));
      out += `${"#".repeat(level)} `;
      serializeInlineContainer(block, blockPos, false);
      return;
    }
    if (
      typeName === "orderedList" ||
      typeName === "bulletList" ||
      typeName === "taskList"
    ) {
      serializeList(block, blockPos, 0);
      return;
    }
    if (typeName === "codeBlock") {
      const lang = String(block.attrs.language ?? "");
      out += `\`\`\`${lang}\n`;
      const innerStart = blockPos + 1;
      pushAnchor(innerStart);
      let pos = innerStart;
      for (let i = 0; i < block.childCount; i++) {
        const child = block.child(i);
        if (child.isText) {
          const text = child.text ?? "";
          for (let k = 0; k < text.length; k++) {
            pushAnchor(pos + k);
            out += text[k];
          }
          pushAnchor(pos + text.length);
        }
        pos += child.nodeSize;
      }
      out += "\n```";
      return;
    }
    if (typeName === "table") {
      serializeTable(block, blockPos);
      return;
    }
    if (typeName === "blockquote") {
      let innerPos = blockPos + 1;
      for (let i = 0; i < block.childCount; i++) {
        if (i > 0) out += "\n";
        out += "> ";
        const child = block.child(i);
        if (child.type.name === "paragraph") {
          serializeInlineContainer(child, innerPos, false);
        } else {
          serializeBlock(child, innerPos);
        }
        innerPos += child.nodeSize;
      }
      return;
    }
    if (typeName === "horizontalRule") {
      out += "---";
      pushAnchor(blockPos + block.nodeSize);
      return;
    }
  }

  let topPos = 0;
  for (let i = 0; i < doc.childCount; i++) {
    if (i > 0) out += "\n";
    const child = doc.child(i);
    serializeBlock(child, topPos);
    topPos += child.nodeSize;
  }
  pushAnchor(doc.content.size);

  function resolvePmPos(targetPmPos: number): {
    mdOffset: number;
    afterPath?: string;
  } {
    if (!anchors.length) return { mdOffset: 0 };
    let best = anchors[0];
    let bestDist = Math.abs(best.pmPos - targetPmPos);
    for (const anchor of anchors) {
      const dist = Math.abs(anchor.pmPos - targetPmPos);
      if (
        dist < bestDist ||
        (dist === bestDist && anchor.pmPos === targetPmPos && anchor.afterPath)
      ) {
        best = anchor;
        bestDist = dist;
      }
    }
    return { mdOffset: best.mdOffset, afterPath: best.afterPath };
  }

  const startResolved = resolvePmPos(selFrom);
  const endResolved = selTo === selFrom ? startResolved : resolvePmPos(selTo);

  return {
    text: out,
    references,
    anchors,
    selectionStart: Math.min(startResolved.mdOffset, endResolved.mdOffset),
    selectionEnd: Math.max(startResolved.mdOffset, endResolved.mdOffset),
    afterPath: selFrom === selTo ? startResolved.afterPath : undefined,
    selectedPaths,
  };
}

export function resolveDocPosFromMarkdownOffset(
  doc: ProseMirrorNode,
  knownReferences: ComposerReference[],
  mdOffset: number,
  afterPath?: string,
): number {
  const { anchors, text } = serializeDocWithSelection(doc, knownReferences);
  const clamped = Math.max(0, Math.min(text.length, mdOffset));
  if (afterPath) {
    const exactChip = anchors.find(
      (a) => a.mdOffset === clamped && a.afterPath === afterPath,
    );
    if (exactChip) return exactChip.pmPos;
  }
  // Prefer editable inline positions over container boundary anchors
  let best = anchors[0]?.pmPos ?? 0;
  let bestDist = Infinity;
  for (const anchor of anchors) {
    if (afterPath === undefined && anchor.afterPath) continue;
    const dist = Math.abs(anchor.mdOffset - clamped);
    if (dist < bestDist || (dist === 0 && anchor.mdOffset === clamped)) {
      best = anchor.pmPos;
      bestDist = dist;
    }
  }
  return Math.max(0, Math.min(doc.content.size, best));
}

function serializeHtmlInline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? "").replace(/\u00A0/g, " ");
  }
  if (!(node instanceof HTMLElement)) return "";
  const commandName = node.getAttribute("data-command-name")?.trim();
  if (commandName) return `/${commandName}`;
  const tag = node.tagName.toLowerCase();
  if (tag === "br") return "\n";
  if (tag === "code" && node.parentElement?.tagName.toLowerCase() !== "pre") {
    const inner = (node.textContent ?? "").replace(/\r?\n/g, " ").trim();
    return inner ? `\`${inner}\`` : "";
  }
  if (tag === "a") {
    const href = (node.getAttribute("href") ?? "").trim();
    const label = Array.from(node.childNodes)
      .map(serializeHtmlInline)
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (/^https?:\/\/[^\s)]+$/i.test(href) && label) {
      return `[${label}](${href})`;
    }
    return label || href;
  }
  const children = Array.from(node.childNodes)
    .map(serializeHtmlInline)
    .join("");
  if (!children.trim()) return children;
  if (tag === "strong" || tag === "b") return `**${children.trim()}**`;
  if (tag === "em" || tag === "i") return `*${children.trim()}*`;
  if (tag === "del" || tag === "s" || tag === "strike") {
    return `~~${children.trim()}~~`;
  }
  return children;
}

function serializeHtmlTable(table: HTMLTableElement): string {
  const trList = Array.from(table.querySelectorAll("tr"));
  if (!trList.length) return "";
  const grid = trList
    .map((tr) =>
      Array.from(tr.children)
        .filter(
          (el): el is HTMLElement => el.tagName === "TH" || el.tagName === "TD",
        )
        .map((cell) =>
          Array.from(cell.childNodes)
            .map(serializeHtmlInline)
            .join("")
            .replace(/\r?\n+/g, " ")
            .replace(/\|/g, "\\|")
            .trim(),
        ),
    )
    .filter((row) => row.length > 0);
  if (!grid.length) return "";
  const colCount = Math.max(...grid.map((r) => r.length));
  if (colCount === 0) return "";
  const pad = (row: string[]) =>
    Array.from({ length: colCount }, (_, i) => row[i] ?? "");
  const header = `| ${pad(grid[0]).join(" | ")} |`;
  const sep = `| ${Array.from({ length: colCount }, () => "---").join(" | ")} |`;
  const body = grid.slice(1).map((r) => `| ${pad(r).join(" | ")} |`);
  return [header, sep, ...body].join("\n");
}

function serializeHtmlList(list: HTMLElement, depth = 0): string {
  const ordered = list.tagName.toLowerCase() === "ol";
  const start = ordered ? Number(list.getAttribute("start") ?? "1") || 1 : 1;
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  const items = Array.from(list.children).filter(
    (el): el is HTMLLIElement => el.tagName.toLowerCase() === "li",
  );
  items.forEach((li, index) => {
    const inlineParts: string[] = [];
    const nestedLists: string[] = [];
    let checkboxPrefix = "";
    const firstInput = li.querySelector(":scope > input[type='checkbox']");
    if (firstInput instanceof HTMLInputElement) {
      checkboxPrefix = firstInput.checked ? "[x] " : "[ ] ";
    }
    for (const child of Array.from(li.childNodes)) {
      if (
        child instanceof HTMLElement &&
        (child.tagName.toLowerCase() === "ul" ||
          child.tagName.toLowerCase() === "ol")
      ) {
        nestedLists.push(serializeHtmlList(child, depth + 1));
      } else if (!(
        child instanceof HTMLInputElement && child.type === "checkbox"
      )) {
        inlineParts.push(serializeHtmlInline(child));
      }
    }
    const text = inlineParts
      .join("")
      .replace(/\r?\n+/g, " ")
      .trim();
    const prefix = ordered
      ? `${indent}${start + index}. `
      : `${indent}- ${checkboxPrefix}`;
    lines.push(`${prefix}${text}`);
    for (const nested of nestedLists) {
      if (nested) lines.push(nested);
    }
  });
  return lines.join("\n");
}

function serializeHtmlBlocks(container: ParentNode): string[] {
  const blocks: string[] = [];
  let inlineBuffer = "";

  const flushInline = () => {
    const trimmed = inlineBuffer.replace(/[ \t]+\n/g, "\n").trim();
    if (trimmed) blocks.push(trimmed);
    inlineBuffer = "";
  };

  for (const child of Array.from(container.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      inlineBuffer += (child.textContent ?? "").replace(/\u00A0/g, " ");
      continue;
    }
    if (!(child instanceof HTMLElement)) continue;
    const tag = child.tagName.toLowerCase();
    if (
      ["script", "style", "meta", "link", "noscript", "svg", "head"].includes(
        tag,
      )
    ) {
      continue;
    }
    if (tag === "table") {
      flushInline();
      const t = serializeHtmlTable(child as HTMLTableElement);
      if (t) blocks.push(t);
      continue;
    }
    if (tag === "ul" || tag === "ol") {
      flushInline();
      const l = serializeHtmlList(child, 0);
      if (l) blocks.push(l);
      continue;
    }
    if (tag === "pre") {
      flushInline();
      const codeEl = child.querySelector("code");
      const cls = codeEl?.className ?? child.className ?? "";
      const lang = cls.match(/language-([A-Za-z0-9_+-]+)/)?.[1] ?? "";
      const rawCode = (codeEl?.textContent ?? child.textContent ?? "").replace(
        /\r\n?/g,
        "\n",
      );
      const trimmedCode = rawCode.replace(/\n$/, "");
      blocks.push(`\`\`\`${lang}\n${trimmedCode}\n\`\`\``);
      continue;
    }
    if (/^h[1-6]$/.test(tag)) {
      flushInline();
      const level = Number(tag[1]);
      const text = Array.from(child.childNodes)
        .map(serializeHtmlInline)
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (text) blocks.push(`${"#".repeat(level)} ${text}`);
      continue;
    }
    if (tag === "blockquote") {
      flushInline();
      const inner = serializeHtmlBlocks(child).join("\n");
      if (inner) {
        blocks.push(
          inner
            .split("\n")
            .map((l) => `> ${l}`)
            .join("\n"),
        );
      }
      continue;
    }
    if (tag === "hr") {
      flushInline();
      blocks.push("---");
      continue;
    }
    if (
      tag === "p" ||
      tag === "div" ||
      tag === "section" ||
      tag === "article"
    ) {
      flushInline();
      const subBlocks = serializeHtmlBlocks(child);
      blocks.push(...subBlocks);
      continue;
    }
    inlineBuffer += serializeHtmlInline(child);
  }

  flushInline();
  return blocks;
}

export function htmlToComposerMarkdown(html: string): string | null {
  if (!html || typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  if (!body) return null;

  // Convert only when semantic rich HTML tags are actually present; ignore
  // syntax-colored IDE/terminal `<div><span>` wrappers.
  const hasRichElement = Boolean(
    body.querySelector(
      'a[href^="http://"], a[href^="https://"], [data-command-name], table, ul, ol, pre, blockquote, h1, h2, h3, h4, h5, h6, code, strong, em, del',
    ),
  );
  if (!hasRichElement) return null;

  const converted = serializeHtmlBlocks(body).join("\n").trim();
  if (!converted || !hasRichComposerMarkdown(converted)) return null;
  return converted;
}

export function tsvToMarkdownTable(text: string): string | null {
  if (!text.includes("\t") || text.includes("```")) return null;
  const lines = text
    .replace(/\r\n?/g, "\n")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  const rows = lines.map((line) =>
    line.split("\t").map((c) => c.trim().replace(/\|/g, "\\|")),
  );
  const colCount = rows[0].length;
  if (colCount < 2 || colCount > 16) return null;
  if (!rows.every((r) => r.length === colCount)) return null;
  const header = `| ${rows[0].join(" | ")} |`;
  const sep = `| ${Array.from({ length: colCount }, () => "---").join(" | ")} |`;
  const body = rows.slice(1).map((r) => `| ${r.join(" | ")} |`);
  return [header, sep, ...body].join("\n");
}

export function smartPasteTransform(params: {
  clipboardText: string;
  clipboardHtml: string;
  hasHtmlType: boolean;
  currentValue: string;
  selectionStart: number;
  selectionEnd: number;
}): string | null {
  const {
    clipboardText,
    clipboardHtml,
    hasHtmlType,
    currentValue,
    selectionStart,
    selectionEnd,
  } = params;

  const trimmedUrl = clipboardText.trim();
  if (selectionStart < selectionEnd && SINGLE_URL_RE.test(trimmedUrl)) {
    const selected = currentValue.slice(selectionStart, selectionEnd);
    if (
      selected.trim().length > 0 &&
      !/[\r\n[\]]/.test(selected) &&
      !SINGLE_URL_RE.test(selected.trim())
    ) {
      return `[${selected}](${trimmedUrl})`;
    }
  }

  if (hasHtmlType && clipboardHtml && clipboardHtml !== clipboardText) {
    const md = htmlToComposerMarkdown(clipboardHtml);
    if (md) return md;
  }

  const tsvTable = tsvToMarkdownTable(clipboardText);
  if (tsvTable) return tsvTable;

  return null;
}
