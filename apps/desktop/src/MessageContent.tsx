import { ImageGalleryBoundary } from "./ImageGallery";
import { WebLink } from "./LinkHandling";
import { copyText } from "./clipboard";
import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type ExtraProps,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Check,
  Code2,
  Copy,
  ExternalLink,
  Eye,
  FileText,
  FolderOpen,
  Save,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { message } from "./api";
import {
  classifyInlineCode,
  classifyLinkHref,
  codeText,
  type InlineReference,
} from "./inlineReferences";
import { InlineRefMenu, type InlineRefMenuItem } from "./InlineRefMenu";
import { InlineRefTooltip } from "./InlineRefTooltip";
import { MarkdownImage, markdownImageTarget } from "./MessageImage";
import { MessageActionsContext, type MessageActions } from "./messageActions";
import type { SourceData } from "./sourceLoader";
import { webLink } from "./browserLinks";

export function CopyButton({
  text,
  label,
  iconOnly = false,
}: {
  text: string;
  label: string;
  iconOnly?: boolean;
}) {
  const [state, setState] = useState("");
  useEffect(() => setState(""), [text]);
  return (
    <span className="copy-action">
      <button
        aria-label={state === "已复制" ? state : label}
        title={state || label}
        onClick={() => {
          void copyText(text).then(
            () => setState("已复制"),
            (e) => setState(`复制失败：${message(e)}`),
          );
        }}
      >
        {state === "已复制" ? <Check size={14} /> : <Copy size={14} />}
        {!iconOnly && (state === "已复制" ? state : label)}
      </button>
      {state.startsWith("复制失败") && <span role="alert">{state}</span>}
    </span>
  );
}
function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children).find(isValidElement);
  const props = code?.props as
    { className?: string; children?: ReactNode } | undefined;
  const raw = codeText(props?.children).replace(/\n$/, "");
  return (
    <div className="code-block">
      <div className="code-block-heading">
        <span>{props?.className?.replace("language-", "") || "代码"}</span>
        <CopyButton label="复制代码" text={raw} />
      </div>
      <pre>
        <code className={props?.className}>{raw}</code>
      </pre>
    </div>
  );
}
const absolutePath = (root: string | undefined, relative: string) => {
  if (!root) return relative;
  return `${root.replace(/\/$/, "")}/${relative.replace(/^\.\//, "").replace(/^\//, "")}`;
};
const baseName = (path: string) =>
  path.split("/").filter(Boolean).at(-1) ?? path.replace(/\/$/, "");
function textual(data: SourceData) {
  const sniff = data.bytes.subarray(0, Math.min(data.bytes.length, 8192));
  if (sniff.includes(0)) throw new Error("二进制文件不支持复制内容");
  return new TextDecoder().decode(data.bytes);
}
async function copyProjectContent(
  actions: MessageActions,
  path: string,
  report: (text: string) => void,
) {
  if (!actions.readProjectFile) {
    report("当前视图不支持读取文件内容");
    return;
  }
  try {
    const data = await actions.readProjectFile(path);
    await copyText(textual(data));
  } catch (e) {
    report(message(e));
  }
}
async function saveAs(
  actions: MessageActions,
  kind: "projectPath" | "externalPath",
  path: string,
  name: string,
  report: (text: string) => void,
) {
  try {
    if (kind === "projectPath") {
      if (!actions.readProjectFile) return;
      const data = await actions.readProjectFile(path);
      await invoke("save_file_as", { name, data: Array.from(data.bytes) });
      return;
    }
    await invoke("save_local_file_as", { path, name });
  } catch (e) {
    report(message(e));
  }
}
type PathReference = Extract<
  InlineReference,
  { kind: "projectPath" | "externalPath" }
>;
/** An absolute path inside the current project, as the file tab's relative form. */
function projectRelative(
  root: string | undefined,
  external: string,
): string | null {
  if (!root) return null;
  const base = root.replace(/\/$/, "");
  return external.startsWith(`${base}/`)
    ? external.slice(base.length + 1)
    : null;
}
function openInlineReference(
  reference: PathReference,
  actions: MessageActions,
  report: (text: string) => void,
) {
  if (reference.kind === "projectPath") {
    actions.openFile?.(reference.path);
    return;
  }
  // Absolute paths inside the current project open in the workspace file tab;
  // only paths outside any project fall back to the guarded system opener.
  const relative = projectRelative(actions.projectRoot, reference.path);
  if (relative && actions.openFile) {
    actions.openFile(relative);
    return;
  }
  if (!actions.localHost) {
    // Remote absolutes are copy-only; left click runs the only available
    // action instead of dead-ending.
    void copyText(reference.path).catch((e) => report(message(e)));
    return;
  }
  void invoke("open_path", { path: reference.path }).catch((e) =>
    report(message(e)),
  );
}
/** Context-menu actions shared by reference chips and markdown file links. */
function inlineRefMenuItems(
  reference: PathReference,
  actions: MessageActions,
  report: (text: string) => void,
): InlineRefMenuItem[] {
  const directory = reference.path.endsWith("/");
  const file = !directory;
  const items: InlineRefMenuItem[] = [];
  // The open action exists only where something can actually open: the file
  // tab for project paths (or absolutes inside the root), or the guarded
  // system opener for other local absolutes. Remote paths stay copy-only.
  const openable =
    reference.kind === "projectPath" ||
    actions.localHost ||
    (actions.openFile !== undefined &&
      projectRelative(actions.projectRoot, reference.path) !== null);
  if (openable)
    items.push({
      key: "open",
      icon: directory ? <FolderOpen size={16} /> : <FileText size={16} />,
      label: "打开文件",
      run: () => openInlineReference(reference, actions, report),
    });
  if (actions.localHost) {
    // Without a project root the resolved editor target would be the bare
    // relative path and always fail, so hide the item instead.
    const resolvable =
      reference.kind === "externalPath" || actions.projectRoot !== undefined;
    const target =
      reference.kind === "projectPath"
        ? absolutePath(actions.projectRoot, reference.path)
        : reference.path;
    if (resolvable)
      items.push({
        key: "vscode",
        icon: <Code2 size={16} />,
        label: "在 VS Code 中打开",
        run: () =>
          void invoke("open_in_vscode", { path: target }).catch((e) =>
            report(message(e)),
          ),
      });
  }
  const canSaveAs =
    file &&
    (reference.kind === "projectPath"
      ? actions.readProjectFile !== undefined
      : actions.localHost);
  if (canSaveAs) {
    items.push(
      { key: "sep-1", separator: true },
      {
        key: "save-as",
        icon: <Save size={16} />,
        label: "另存为...",
        run: () =>
          void saveAs(
            actions,
            reference.kind,
            reference.path,
            baseName(reference.path),
            report,
          ),
      },
    );
  }
  items.push({
    key: "copy-path",
    icon: <Copy size={16} />,
    label: "复制路径",
    run: () => void copyText(reference.path).catch((e) => report(message(e))),
  });
  if (
    file &&
    (reference.kind === "projectPath"
      ? actions.readProjectFile !== undefined
      : actions.localHost)
  ) {
    items.push({
      key: "copy-content",
      icon: <FileText size={16} />,
      label: "复制文件内容",
      run: () => {
        if (reference.kind === "projectPath") {
          void copyProjectContent(actions, reference.path, report);
          return;
        }
        void invoke<string>("read_local_text", { path: reference.path })
          .then((text) => copyText(text))
          .catch((e) => report(message(e)));
      },
    });
  }
  if (reference.kind === "externalPath" && actions.localHost) {
    items.push(
      { key: "sep-2", separator: true },
      {
        key: "reveal",
        icon: <Eye size={16} />,
        label: "在访达中显示",
        run: () =>
          void invoke("reveal_path", { path: reference.path }).catch((e) =>
            report(message(e)),
          ),
      },
    );
  }
  return items;
}
function InlineCodeRef({ children }: { children?: ReactNode }) {
  const actions = useContext(MessageActionsContext);
  const raw = codeText(children);
  const reference = classifyInlineCode(raw);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  // Same hover contract as the sidebar hover cards: 350ms delay, dismissed by
  // leaving, scrolling, resizing, Escape, and any menu or click. `pending`
  // gates the dismissal listeners so idle chips carry none of them.
  const [hover, setHover] = useState<DOMRect | null>(null);
  const [pending, setPending] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tipId = useId();
  function cancelHover() {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setPending(false);
    setHover(null);
  }
  function scheduleHover(target: HTMLButtonElement) {
    if (point) return;
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      setPending(false);
      if (target.isConnected) setHover(target.getBoundingClientRect());
    }, 350);
    setPending(true);
  }
  useEffect(() => () => cancelHover(), []);
  useEffect(() => {
    if (point) cancelHover();
  }, [point]);
  // Scrolling while the timer is still pending must not pop the tooltip at a
  // stale anchor afterwards, so dismissal listeners stay mounted through the
  // pending phase, not only while the tooltip is visible.
  useEffect(() => {
    if (!hover && !pending) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelHover();
    };
    window.addEventListener("keydown", key);
    window.addEventListener("resize", cancelHover);
    window.addEventListener("scroll", cancelHover, true);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", cancelHover);
      window.removeEventListener("scroll", cancelHover, true);
    };
  }, [hover, pending]);
  if (reference.kind === "text") return <code>{children}</code>;
  if (reference.kind === "url")
    return (
      <code className="inline-code-ref">
        <WebLink href={reference.url} className="inline-ref-link">
          <ExternalLink size={12} />
          {raw}
        </WebLink>
      </code>
    );
  // Outside the conversation (markdown previews, settings) the chips degrade
  // back to plain code instead of dead ends.
  const provided =
    actions.openFile !== undefined || actions.localHost !== undefined;
  if (reference.kind === "projectPath" && !actions.openFile)
    return <code>{children}</code>;
  if (reference.kind === "externalPath" && !provided)
    return <code>{children}</code>;
  const report = actions.reportError ?? (() => undefined);
  const directory = reference.path.endsWith("/");
  const local = reference.kind === "externalPath";
  const title = local
    ? actions.localHost
      ? "打开文件，右键查看更多操作"
      : "点击复制路径，右键查看更多操作"
    : "在工作区中打开，右键查看更多操作";
  const open = () => openInlineReference(reference, actions, report);
  // Codex-style hover: reveal the full path (resolved against the project
  // root when known) plus a muted hint matching the available actions.
  const tipPath =
    reference.kind === "projectPath" && actions.projectRoot
      ? absolutePath(actions.projectRoot, reference.path)
      : reference.path;
  const tipPrimary = reference.line
    ? `${tipPath} (${reference.line.includes("-") ? "lines" : "line"} ${reference.line})`
    : tipPath;
  const tipHint =
    reference.kind === "projectPath"
      ? "左键在工作区打开 · 右键更多操作"
      : actions.localHost
        ? "左键打开 · 右键更多操作"
        : "点击复制路径 · 右键更多操作";
  const items = inlineRefMenuItems(reference, actions, report);
  return (
    <code className="inline-code-ref">
      <button
        className="inline-ref-button"
        aria-label={title}
        aria-describedby={hover && !point ? tipId : undefined}
        onClick={() => {
          cancelHover();
          open();
        }}
        onMouseEnter={(event) => scheduleHover(event.currentTarget)}
        onMouseLeave={cancelHover}
        onFocus={(event) => scheduleHover(event.currentTarget)}
        onBlur={cancelHover}
        onContextMenu={(event) => {
          event.preventDefault();
          cancelHover();
          setPoint({ x: event.clientX, y: event.clientY });
        }}
      >
        {directory ? <FolderOpen size={12} /> : <FileText size={12} />}
        {raw}
      </button>
      {point && (
        <InlineRefMenu
          point={point}
          label={`文件操作：${baseName(reference.path)}`}
          items={items}
          close={() => setPoint(null)}
        />
      )}
      {hover && !point && (
        <InlineRefTooltip
          anchor={hover}
          id={tipId}
          primary={tipPrimary}
          secondary={tipHint}
        />
      )}
    </code>
  );
}
/**
 * Markdown link targets: http(s) keep browser semantics; local path targets
 * open in the workspace file tab and carry the same context menu as reference
 * chips. Anything else renders as plain text instead of a dead blue link.
 */
function MarkdownLink({
  href,
  children,
  node,
}: {
  href?: string;
  children?: ReactNode;
} & ExtraProps) {
  const actions = useContext(MessageActionsContext);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  // A local image is itself an interactive preview. Keep it outside the
  // destination control (including images nested in emphasis/strong markup).
  const containsImage = (element: NonNullable<ExtraProps["node"]>): boolean =>
    (element.tagName === "img" &&
      markdownImageTarget(
        typeof element.properties.src === "string"
          ? element.properties.src
          : undefined,
      ).kind === "local") ||
    element.children.some(
      (child) => child.type === "element" && containsImage(child),
    );
  if (node && containsImage(node))
    return (
      <span className="markdown-linked-image">
        {children}
        <MarkdownLink href={href}>{href}</MarkdownLink>
      </span>
    );
  if (href && webLink(href)) return <WebLink href={href}>{children}</WebLink>;
  const reference = href ? classifyLinkHref(href) : ({ kind: "text" } as const);
  const provided =
    actions.openFile !== undefined || actions.localHost !== undefined;
  const inert = <span className="markdown-link-inert">{children}</span>;
  if (reference.kind !== "projectPath" && reference.kind !== "externalPath")
    return inert;
  if (reference.kind === "projectPath" && !actions.openFile) return inert;
  if (reference.kind === "externalPath" && !provided) return inert;
  const report = actions.reportError ?? (() => undefined);
  return (
    <>
      <button
        type="button"
        className="markdown-file-link"
        title={reference.path}
        onClick={() => openInlineReference(reference, actions, report)}
        onContextMenu={(event) => {
          event.preventDefault();
          setPoint({ x: event.clientX, y: event.clientY });
        }}
      >
        {children}
      </button>
      {point && (
        <InlineRefMenu
          point={point}
          label={`文件操作：${baseName(reference.path)}`}
          items={inlineRefMenuItems(reference, actions, report)}
          close={() => setPoint(null)}
        />
      )}
    </>
  );
}
/**
 * The default transform blanks file:// targets before custom components run,
 * which would make the local-path branch unreachable. Pass them through for
 * the path classifier; everything else keeps the default sanitization, so
 * unknown or dangerous schemes still never become links.
 */
function preserveLocalTargets(url: string): string {
  return /^file:\/\//i.test(url.trim()) ? url : defaultUrlTransform(url);
}

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
}

const BR_TAG_ONLY_RE = /^(?:<br\s*\/?>\s*)+$/i;
const BR_TAG_COUNT_RE = /<br\s*\/?>/gi;

function replaceInlineBreakTags(node: MdastNode) {
  if (!Array.isArray(node.children)) return;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (
      child.type === "html" &&
      typeof child.value === "string" &&
      BR_TAG_ONLY_RE.test(child.value.trim())
    ) {
      const count = child.value.match(BR_TAG_COUNT_RE)?.length ?? 1;
      const breaks: MdastNode[] = Array.from({ length: count }, () => ({
        type: "break",
      }));
      node.children.splice(i, 1, ...breaks);
      i += breaks.length - 1;
      continue;
    }
    replaceInlineBreakTags(child);
  }
}

/**
 * Turn literal `<br>` / `<br/>` / `<br />` tags (commonly emitted by agents inside
 * single-line GFM table cells) into real Markdown `break` nodes without enabling
 * `rehype-raw` or allowing arbitrary HTML tags. `code` and `inlineCode` nodes have
 * no `children` array and remain untouched.
 */
function remarkBreakTags() {
  return (tree: MdastNode) => {
    replaceInlineBreakTags(tree);
  };
}

type HastNode = NonNullable<ExtraProps["node"]>;
type HastChild = HastNode["children"][number];

function lineVisualUnits(line: string): number {
  const normalized = line.replace(/\s+/g, " ").trim();
  let units = 0;
  for (const ch of normalized) {
    const code = ch.codePointAt(0) ?? 0;
    units += code > 0xff ? 1.85 : 1;
  }
  return units;
}

function maxCellLineUnits(cell: HastNode | undefined): {
  maxUnits: number;
  hasWide: boolean;
} {
  if (!cell) return { maxUnits: 0, hasWide: false };
  const lines = [""];
  let hasWide = false;
  const walk = (item: HastChild) => {
    if (item.type === "text") {
      for (const ch of item.value) {
        if ((ch.codePointAt(0) ?? 0) > 0xff) {
          hasWide = true;
          break;
        }
      }
      const parts = item.value.split("\n");
      lines[lines.length - 1] += parts[0];
      for (let i = 1; i < parts.length; i++) lines.push(parts[i]);
      return;
    }
    if (item.type === "element") {
      if (item.tagName === "br") {
        lines.push("");
        return;
      }
      for (const child of item.children) walk(child);
    }
  };
  for (const child of cell.children) walk(child);
  let maxUnits = 0;
  for (const line of lines) {
    const u = lineVisualUnits(line);
    if (u > maxUnits) maxUnits = u;
  }
  return { maxUnits, hasWide };
}

function countTableColumns(tableNode: HastNode | undefined): number {
  if (!tableNode) return 0;
  for (const section of tableNode.children) {
    if (section.type !== "element") continue;
    for (const row of section.children) {
      if (row.type === "element" && row.tagName === "tr") {
        return row.children.filter(
          (cell) =>
            cell.type === "element" &&
            (cell.tagName === "th" || cell.tagName === "td"),
        ).length;
      }
    }
  }
  return 0;
}

const TableColCountContext = createContext<number>(3);

function computeCellSizing(
  node: HastNode | undefined,
  isHeader: boolean,
  colCount: number,
): { minWidth?: string; nowrap?: boolean } {
  const { maxUnits: units, hasWide } = maxCellLineUnits(node);
  const dense = colCount >= 5;
  if (isHeader) {
    if (units === 0) return {};
    // Keep short headers (`#`, `组别`, `门控`, `权重`, `Criterion ID`) on a single line
    // at their natural compact width instead of inflating narrow metadata columns.
    if (units <= (hasWide ? 9.5 : 16)) {
      return { nowrap: true };
    }
    if (!hasWide) return { minWidth: "8rem" };
    return { minWidth: dense ? "7.5rem" : "9.5rem" };
  }
  // Pure ASCII/numeric cells (`8`, `Blocker`, `classical`) already have natural word
  // min-content width and never collapse into 1-char vertical strips.
  if (!hasWide) return {};
  if (units <= 8) return { minWidth: "4.5rem" };
  if (units <= 22) return { minWidth: dense ? "6rem" : "8rem" };
  if (units <= 40) return { minWidth: dense ? "8rem" : "9.5rem" };
  if (units <= 90) return { minWidth: dense ? "11rem" : "12.5rem" };
  return { minWidth: dense ? "13.5rem" : "15rem" };
}

function MarkdownTable({
  children,
  node,
  ...props
}: ComponentPropsWithoutRef<"table"> & ExtraProps) {
  const colCount = countTableColumns(node);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState<{
    left: boolean;
    right: boolean;
  }>({ left: false, right: false });

  const syncScrollState = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setScrollState((prev) =>
      prev.left === left && prev.right === right ? prev : { left, right },
    );
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return undefined;
    syncScrollState();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(syncScrollState);
    observer.observe(el);
    const table = el.firstElementChild;
    if (table) observer.observe(table);
    return () => observer.disconnect();
  }, [syncScrollState, colCount]);

  return (
    <TableColCountContext.Provider value={colCount}>
      <div
        className="markdown-table-wrap"
        data-scroll-left={scrollState.left || undefined}
        data-scroll-right={scrollState.right || undefined}
      >
        <div
          ref={scrollerRef}
          className="markdown-table-scroller"
          onScroll={syncScrollState}
        >
          <table
            {...props}
            data-dense-cols={colCount >= 5 ? "true" : undefined}
          >
            {children}
          </table>
        </div>
      </div>
    </TableColCountContext.Provider>
  );
}

function MarkdownTableHeaderCell({
  children,
  node,
  style,
  ...props
}: ComponentPropsWithoutRef<"th"> & ExtraProps) {
  const colCount = useContext(TableColCountContext);
  const { minWidth, nowrap } = computeCellSizing(node, true, colCount);
  const mergedStyle: CSSProperties | undefined =
    minWidth || nowrap
      ? {
          ...style,
          ...(minWidth ? { minWidth } : {}),
          ...(nowrap ? { whiteSpace: "nowrap" } : {}),
        }
      : style;
  return (
    <th {...props} style={mergedStyle}>
      {children}
    </th>
  );
}

function isBrElement(child: ReactNode): boolean {
  return isValidElement(child) && child.type === "br";
}

function hasNonWhitespaceNode(segment: ReactNode[]): boolean {
  return segment.some(
    (item) => typeof item !== "string" || item.trim().length > 0,
  );
}

function MarkdownTableCell({
  children,
  node,
  style,
  ...props
}: ComponentPropsWithoutRef<"td"> & ExtraProps) {
  const colCount = useContext(TableColCountContext);
  const { minWidth } = computeCellSizing(node, false, colCount);
  const mergedStyle: CSSProperties | undefined = minWidth
    ? { ...style, minWidth }
    : style;
  const items = Children.toArray(children);
  if (!items.some(isBrElement)) {
    return (
      <td {...props} style={mergedStyle}>
        {children}
      </td>
    );
  }
  const segments: ReactNode[][] = [[]];
  for (const item of items) {
    if (isBrElement(item)) {
      segments.push([]);
    } else {
      segments[segments.length - 1].push(item);
    }
  }
  const nonEmpty = segments.filter(hasNonWhitespaceNode);
  return (
    <td {...props} style={mergedStyle}>
      {nonEmpty.map((segment, index) => (
        <div key={index} className="markdown-cell-block">
          {segment}
        </div>
      ))}
    </td>
  );
}

export function MessageContent({ text }: { text: string }) {
  return (
    <ImageGalleryBoundary>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreakTags]}
        urlTransform={preserveLocalTargets}
        components={{
          pre: CodeBlock,
          a: MarkdownLink,
          code: InlineCodeRef,
          img: MarkdownImage,
          table: MarkdownTable,
          th: MarkdownTableHeaderCell,
          td: MarkdownTableCell,
        }}
      >
        {text}
      </ReactMarkdown>
    </ImageGalleryBoundary>
  );
}
export function MessageActionsProvider({
  value,
  children,
}: {
  value: MessageActions;
  children: ReactNode;
}) {
  return (
    <MessageActionsContext.Provider value={value}>
      {children}
    </MessageActionsContext.Provider>
  );
}
