import { useState } from "react";
import {
  Bot,
  ChevronRight,
  CircleAlert,
  CirclePause,
  FilePenLine,
  FileSearch,
  FileText,
  Folder,
  LoaderCircle,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import {
  diffStringLines,
  toolDisplayParts,
  toolGroupLabel,
  toolInputDiffStat,
  toolLabel,
  type ToolActivity,
} from "./activity";
import { reassembleFullContent, streamEventContent } from "./eventContent";
import type { ContentEncoding, JsonValue } from "./protocol";
import { Badge, Button, DiffStat } from "./ui";

/** Identity a previewed tool output needs to stream its full payload. */
export interface ToolLoadContext {
  hostId: string;
  sessionId: string;
}

function formatBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

interface ToolStream {
  encoding: ContentEncoding;
  text: string;
  received: number;
  total: number;
  done: boolean;
}

function outputText(value: JsonValue): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function strField(input: JsonValue | undefined, key: string): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  return typeof input[key] === "string" ? input[key] : "";
}

function numField(
  input: JsonValue | undefined,
  key: string,
): number | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return undefined;
  return typeof input[key] === "number" ? input[key] : undefined;
}

function ToolIcon({ tool }: { tool: ToolActivity }) {
  if (["waiting", "denied", "expired"].includes(tool.status))
    return (
      <CirclePause size={14} className="activity-icon activity-icon--warning" />
    );
  if (tool.status === "failed")
    return (
      <CircleAlert size={14} className="activity-icon activity-icon--danger" />
    );
  if (tool.status === "pending")
    return <LoaderCircle size={14} className="spin activity-icon" />;
  const kind = tool.name.toLowerCase();
  if (kind === "bash") return <Terminal size={14} className="activity-icon" />;
  if (["edit", "multiedit", "write"].includes(kind))
    return <FilePenLine size={14} className="activity-icon" />;
  if (["glob", "grep"].includes(kind))
    return <Search size={14} className="activity-icon" />;
  if (kind === "read") return <FileText size={14} className="activity-icon" />;
  if (["task", "agent", "subagent"].includes(kind))
    return <Bot size={14} className="activity-icon" />;
  return <Wrench size={14} className="activity-icon" />;
}

function GroupIcon({
  tools,
  pending,
}: {
  tools: ToolActivity[];
  pending: boolean;
}) {
  if (pending) return <LoaderCircle size={14} className="spin activity-icon" />;
  const succeeded = tools.filter((t) => t.status === "completed");
  const basis = succeeded.length > 0 ? succeeded : tools;
  const kinds = new Set(basis.map((t) => t.name.toLowerCase()));
  if (kinds.has("edit") || kinds.has("multiedit") || kinds.has("write"))
    return <FilePenLine size={14} className="activity-icon" />;
  if (kinds.size === 1 && kinds.has("bash"))
    return <Terminal size={14} className="activity-icon" />;
  if ([...kinds].every((k) => k === "read" || k === "glob" || k === "grep"))
    return <FileSearch size={14} className="activity-icon" />;
  return <Wrench size={14} className="activity-icon" />;
}

function Status({
  status,
  hidePending = false,
}: {
  status: ToolActivity["status"];
  hidePending?: boolean;
}) {
  if (status === "completed" || (hidePending && status === "pending"))
    return null;
  return (
    <span
      className={`activity-status${status === "failed" ? " failure" : ""}${
        status === "waiting" ? " warning" : ""
      }`}
    >
      {status === "waiting"
        ? "等待确认"
        : status === "denied"
          ? "已拒绝"
          : status === "expired"
            ? "审批已过期"
            : status === "pending"
              ? "执行中"
              : status === "failed"
                ? "失败"
                : "结果待确认"}
    </span>
  );
}

/**
 * The output section of one tool result: the stored preview until a load-full
 * stream replaces it. A failure after the first chunk resets to the preview
 * so the retry affordance stays available and no half-loaded progress lingers.
 */
export function FullToolOutput({
  output,
  load,
  loadContext,
  pending,
}: {
  output?: JsonValue;
  load?: ToolActivity["load"];
  loadContext?: ToolLoadContext;
  pending?: boolean;
}) {
  const [stream, setStream] = useState<ToolStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function loadFull() {
    if (!loadContext || !load || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await streamEventContent(
        { ...loadContext, seq: load.seq },
        ({ encoding, accumulated, received, total }) =>
          setStream({
            encoding,
            text: accumulated,
            received,
            total,
            done: false,
          }),
      );
      setStream({
        encoding: outcome.encoding,
        text: outcome.content,
        received: load.size,
        total: load.size,
        done: true,
      });
    } catch (cause) {
      // End the progress display and drop the partial stream so the preview
      // and its load button come back for an explicit retry.
      setStream(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {stream ? (
        <>
          {!stream.done && (
            <div className="activity-load-progress">
              正在流式加载{" "}
              {Math.min(
                100,
                Math.round((stream.received / stream.total) * 100),
              )}
              %（{formatBytes(stream.received)} / {formatBytes(stream.total)}）
            </div>
          )}
          {stream.encoding === "text" || stream.done ? (
            <pre>
              {stream.done
                ? stream.encoding === "text"
                  ? stream.text
                  : reassembleFullContent("json", stream.text)
                : stream.text}
            </pre>
          ) : (
            <p>结构化内容接收中…</p>
          )}
        </>
      ) : output !== undefined ? (
        <pre>{outputText(output)}</pre>
      ) : (
        <p className="activity-empty-note">
          {pending ? "等待工具返回结果…" : "未收到工具结果。"}
        </p>
      )}
      {load && loadContext && !stream && (
        <button
          type="button"
          className="activity-load"
          disabled={busy}
          onClick={loadFull}
        >
          {busy
            ? "加载中…"
            : `加载完整内容（已省略至预览，共 ${formatBytes(load.size)}）`}
        </button>
      )}
      {error && <p className="activity-load-error">加载失败：{error}</p>}
    </>
  );
}

interface DiffLine {
  kind: "add" | "del" | "ctx" | "sep";
  lineNo?: number;
  text: string;
}

const MAX_DIFF_PREVIEW_LINES = 80;

function buildEditPreviewLines(
  tool: ToolActivity,
  maxLines = MAX_DIFF_PREVIEW_LINES,
): {
  lines: DiffLine[];
  total: number;
  truncated: number;
  approximate: boolean;
} | null {
  const kind = tool.name.toLowerCase();
  const input = tool.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const raw: DiffLine[] = [];
  let approximate = false;
  const pushHunk = (oldStr: string, newStr: string) => {
    const { ops, approximate: hunkApprox } = diffStringLines(oldStr, newStr);
    if (hunkApprox) approximate = true;
    const keep = new Uint8Array(ops.length);
    let hasEdit = false;
    for (let i = 0; i < ops.length; i++) {
      if (ops[i].kind !== "equal") {
        hasEdit = true;
        const start = Math.max(0, i - 2);
        const end = Math.min(ops.length - 1, i + 2);
        for (let j = start; j <= end; j++) keep[j] = 1;
      }
    }
    if (!hasEdit) return;
    for (let i = 1; i < ops.length - 1; i++) {
      if (!keep[i] && keep[i - 1] && keep[i + 1]) keep[i] = 1;
    }

    let skipping = false;
    for (let i = 0; i < ops.length; i++) {
      if (!keep[i]) {
        skipping = true;
        continue;
      }
      if (skipping && raw.length > 0 && raw.at(-1)?.kind !== "sep") {
        raw.push({ kind: "sep", text: "⋯" });
      }
      skipping = false;
      const op = ops[i];
      if (op.kind === "equal") {
        raw.push({ kind: "ctx", lineNo: op.newLineNo, text: op.text });
      } else {
        raw.push({ kind: op.kind, lineNo: op.lineNo, text: op.text });
      }
    }
  };

  if (kind === "write" && typeof input.content === "string") {
    const lines = input.content ? input.content.split("\n") : [];
    lines.forEach((text, index) =>
      raw.push({ kind: "add", lineNo: index + 1, text }),
    );
  } else if (kind === "edit") {
    const oldStr = typeof input.old_string === "string" ? input.old_string : "";
    const newStr = typeof input.new_string === "string" ? input.new_string : "";
    if (!oldStr && !newStr) return null;
    pushHunk(oldStr, newStr);
  } else if (kind === "multiedit" && Array.isArray(input.edits)) {
    input.edits.forEach((entry, idx) => {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        if (idx > 0 && raw.length > 0) raw.push({ kind: "sep", text: "⋯" });
        pushHunk(
          typeof entry.old_string === "string" ? entry.old_string : "",
          typeof entry.new_string === "string" ? entry.new_string : "",
        );
      }
    });
  } else {
    return null;
  }

  if (raw.length === 0) return null;
  const truncated = Math.max(0, raw.length - maxLines);
  return {
    lines: raw.slice(0, maxLines),
    total: raw.length,
    truncated,
    approximate,
  };
}

function normalizeDirectoryPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const unified = trimmed.replace(/\\/g, "/");
  if (unified === "/" || /^[A-Za-z]:\/$/.test(unified)) return unified;
  return unified.replace(/\/+$/, "");
}

/**
 * Formats a Bash working directory for the header bar, returning `null` when
 * omitted or identical to `projectPath` so routine root commands stay quiet.
 */
export function formatCommandDirectory(
  rawCwd: string,
  rawProjectPath?: string,
): { display: string; full: string } | null {
  const full = rawCwd.trim();
  const cwd = normalizeDirectoryPath(full);
  if (!cwd || cwd === "." || cwd === "./") return null;

  const root = rawProjectPath ? normalizeDirectoryPath(rawProjectPath) : "";
  if (root) {
    if (cwd === root) return null;
    const prefix = root.endsWith("/") ? root : `${root}/`;
    if (cwd.startsWith(prefix)) {
      return { display: cwd.slice(prefix.length), full };
    }
  }

  if (
    !cwd.startsWith("/") &&
    !cwd.startsWith("~") &&
    !/^[A-Za-z]:\//.test(cwd)
  ) {
    return { display: cwd.replace(/^\.\//, ""), full };
  }

  if (cwd.startsWith("~/")) {
    const parts = cwd.slice(2).split("/").filter(Boolean);
    if (parts.length > 3) {
      return { display: `~/…/${parts.slice(-2).join("/")}`, full };
    }
    return { display: cwd, full };
  }

  const driveMatch = cwd.match(/^([A-Za-z]:)\/(.*)$/);
  if (driveMatch) {
    const [, drive, rest] = driveMatch;
    const parts = rest.split("/").filter(Boolean);
    if (parts.length > 3) {
      return { display: `${drive}/…/${parts.slice(-2).join("/")}`, full };
    }
    return { display: cwd, full };
  }

  const parts = cwd.split("/").filter(Boolean);
  if (parts.length > 3) {
    return { display: `/${parts[0]}/…/${parts.slice(-2).join("/")}`, full };
  }
  return { display: cwd, full };
}

export function ToolDetailBody({
  tool,
  loadContext,
  projectPath,
  onOpenSubagents,
  inputOnly = false,
  hideToggles = false,
}: {
  tool: ToolActivity;
  loadContext?: ToolLoadContext;
  projectPath?: string;
  onOpenSubagents?: () => void;
  inputOnly?: boolean;
  hideToggles?: boolean;
}) {
  const [showFullInput, setShowFullInput] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const kind = tool.name.toLowerCase();

  if (kind === "task" || kind === "agent" || kind === "subagent") {
    const prompt = strField(tool.input, "prompt");
    const agentType =
      strField(tool.input, "subagent_type") || strField(tool.input, "type");
    const summaryTitle =
      strField(tool.input, "description") || strField(tool.input, "role");
    return (
      <div className="activity-well activity-well--code">
        {(agentType || summaryTitle || onOpenSubagents) && (
          <div className="activity-well-header">
            <span
              className="activity-well-path"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {agentType && <Badge>{agentType}</Badge>}
              {summaryTitle && <span>{summaryTitle}</span>}
            </span>
            {onOpenSubagents && (
              <Button size="xs" variant="subtle" onClick={onOpenSubagents}>
                在子智能体面板中查看
              </Button>
            )}
          </div>
        )}
        {prompt && (
          <div className="activity-generic-section">
            <div className="activity-output-label">任务指令</div>
            <pre>{prompt}</pre>
          </div>
        )}
        {!inputOnly && (
          <div className="activity-code-body">
            <FullToolOutput
              output={tool.output}
              load={tool.load}
              loadContext={loadContext}
              pending={tool.status === "pending"}
            />
          </div>
        )}
      </div>
    );
  }

  if (kind === "bash") {
    const command = strField(tool.input, "command");
    const cwd = strField(tool.input, "cwd") || strField(tool.input, "workdir");
    const directory = formatCommandDirectory(cwd, projectPath);
    return (
      <div className="activity-well activity-well--terminal">
        {directory && (
          <div className="activity-well-header">
            <span
              className="activity-well-path activity-terminal-cwd"
              title={directory.full}
            >
              <Folder size={12.5} aria-hidden="true" />
              <span>{directory.display}</span>
            </span>
          </div>
        )}
        {command && (
          <div className="activity-terminal-prompt">
            <span className="activity-prompt-sigil" aria-hidden="true">
              $
            </span>
            <code>{command}</code>
          </div>
        )}
        {!inputOnly && (
          <div className="activity-terminal-stdout">
            {tool.status === "failed" && tool.output !== undefined && (
              <div className="activity-output-label">错误输出</div>
            )}
            <FullToolOutput
              output={tool.output}
              load={tool.load}
              loadContext={loadContext}
              pending={tool.status === "pending"}
            />
          </div>
        )}
      </div>
    );
  }

  if (kind === "edit" || kind === "multiedit" || kind === "write") {
    const isEditKind = kind === "edit" || kind === "multiedit";
    const filePath =
      strField(tool.input, "file_path") || strField(tool.input, "path");
    const stat = toolInputDiffStat(tool);
    const preview = buildEditPreviewLines(
      tool,
      !isEditKind && showFullInput
        ? Number.POSITIVE_INFINITY
        : MAX_DIFF_PREVIEW_LINES,
    );
    if (preview) {
      const isSimplified = Boolean(preview.approximate || stat?.approximate);
      const hasReplaceAll = Boolean(
        tool.input &&
        typeof tool.input === "object" &&
        !Array.isArray(tool.input) &&
        (tool.input.replace_all === true ||
          (Array.isArray(tool.input.edits) &&
            tool.input.edits.some(
              (entry) =>
                entry &&
                typeof entry === "object" &&
                !Array.isArray(entry) &&
                entry.replace_all === true,
            ))),
      );
      const hasExtraWriteFields =
        kind === "write" &&
        Boolean(
          tool.input &&
          typeof tool.input === "object" &&
          !Array.isArray(tool.input) &&
          Object.keys(tool.input).some(
            (k) => k !== "file_path" && k !== "path" && k !== "content",
          ),
        );
      const canToggleFullInput =
        !inputOnly &&
        !hideToggles &&
        (isEditKind ||
          preview.truncated > 0 ||
          hasExtraWriteFields ||
          showFullInput);
      const immediateOutput =
        !inputOnly &&
        (tool.status === "failed" ||
          tool.load !== undefined ||
          tool.status === "pending");
      const hasSavedResult =
        !inputOnly &&
        !hideToggles &&
        !immediateOutput &&
        tool.output !== undefined &&
        outputText(tool.output).trim().length > 0;
      return (
        <div className="activity-well activity-well--diff">
          {(filePath || stat || hasReplaceAll || isSimplified) && (
            <div className="activity-well-header">
              <span
                className="activity-well-path"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                {filePath && <span>{filePath}</span>}
                {hasReplaceAll && <Badge>全部替换</Badge>}
              </span>
              {isSimplified ? (
                <Badge tone="warning">差异已简化</Badge>
              ) : (
                stat && <DiffStat added={stat.added} removed={stat.removed} />
              )}
            </div>
          )}
          <div className="activity-diff-lines">
            {isSimplified && (
              <div className="activity-diff-more">
                变更超出精确比对上限，以下按整段旧值与新值简化展示
              </div>
            )}
            {preview.lines.map((line, idx) =>
              line.kind === "sep" ? (
                <div key={idx} className="activity-diff-sep">
                  {line.text}
                </div>
              ) : (
                <div key={idx} className={`activity-diff-line is-${line.kind}`}>
                  <span className="activity-diff-gutter" aria-hidden="true">
                    {line.lineNo ?? ""}
                  </span>
                  <span className="activity-diff-code">{line.text || " "}</span>
                </div>
              ),
            )}
            {preview.truncated > 0 && (
              <div className="activity-diff-more">
                已折叠其余 {preview.truncated} 行变更预览
              </div>
            )}
          </div>
          {showFullInput &&
            (isEditKind || hasExtraWriteFields) &&
            tool.input !== undefined && (
              <div className="activity-generic-section">
                <div className="activity-output-label">完整输入参数</div>
                <pre>{outputText(tool.input)}</pre>
              </div>
            )}
          {immediateOutput && (
            <div className="activity-diff-footer">
              <FullToolOutput
                output={tool.output}
                load={tool.load}
                loadContext={loadContext}
                pending={tool.status === "pending"}
              />
            </div>
          )}
          {(canToggleFullInput || hasSavedResult) && (
            <div className="activity-diff-footer">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                {canToggleFullInput && (
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-expanded={showFullInput}
                    onClick={() => setShowFullInput((value) => !value)}
                  >
                    {showFullInput ? "收起完整输入" : "查看完整输入"}
                  </Button>
                )}
                {hasSavedResult && (
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-expanded={showResult}
                    onClick={() => setShowResult((value) => !value)}
                  >
                    {showResult ? "收起结果" : "查看结果"}
                  </Button>
                )}
              </div>
              {showResult && hasSavedResult && (
                <FullToolOutput
                  output={tool.output}
                  load={tool.load}
                  loadContext={loadContext}
                />
              )}
            </div>
          )}
        </div>
      );
    }
  }

  if (kind === "read" || kind === "glob" || kind === "grep") {
    const offset = numField(tool.input, "offset");
    const limit = numField(tool.input, "limit");
    const filePath =
      strField(tool.input, "file_path") || strField(tool.input, "path");
    const pattern = strField(tool.input, "pattern");
    const primaryTarget = kind === "read" ? filePath : pattern;
    const scopePath = kind !== "read" ? filePath : "";
    const meta =
      offset !== undefined || limit !== undefined
        ? `行范围 ${offset ?? 1}${limit ? ` · 共 ${limit} 行` : ""}`
        : scopePath
          ? `范围 ${scopePath}`
          : "";
    return (
      <div className="activity-well activity-well--code">
        {(primaryTarget || meta) && (
          <div className="activity-well-header">
            {primaryTarget && (
              <span className="activity-well-path">{primaryTarget}</span>
            )}
            {meta && <span className="activity-well-meta">{meta}</span>}
          </div>
        )}
        {!inputOnly && (
          <div className="activity-code-body">
            <FullToolOutput
              output={tool.output}
              load={tool.load}
              loadContext={loadContext}
              pending={tool.status === "pending"}
            />
          </div>
        )}
      </div>
    );
  }

  const hasStructuredInput =
    tool.input !== undefined &&
    tool.input !== null &&
    !(
      typeof tool.input === "object" &&
      !Array.isArray(tool.input) &&
      Object.keys(tool.input).length === 0
    );

  return (
    <div className="activity-well">
      {hasStructuredInput && (
        <div className="activity-generic-section">
          <div className="activity-output-label">参数</div>
          <pre>{outputText(tool.input!)}</pre>
        </div>
      )}
      {!inputOnly && (
        <div className="activity-generic-section">
          {hasStructuredInput && (
            <div className="activity-output-label">
              {tool.status === "failed" ? "错误输出" : "结果"}
            </div>
          )}
          <FullToolOutput
            output={tool.output}
            load={tool.load}
            loadContext={loadContext}
            pending={tool.status === "pending"}
          />
        </div>
      )}
    </div>
  );
}

export function ToolRow({
  tool,
  loadContext,
  projectPath,
  onOpenSubagents,
}: {
  tool: ToolActivity;
  loadContext?: ToolLoadContext;
  projectPath?: string;
  onOpenSubagents?: () => void;
}) {
  const label = toolLabel(tool).replace(/\s+/g, " ");
  const parts = toolDisplayParts(tool, true);
  return (
    <details className="activity-row" data-status={tool.status}>
      <summary title={label}>
        <ToolIcon tool={tool} />
        <span className="activity-label">
          {parts.verb && <span className="activity-verb">{parts.verb}</span>}
          {parts.target && (
            <span
              className={`activity-target${parts.monoTarget ? " is-mono" : ""}`}
            >
              {parts.target}
            </span>
          )}
        </span>
        {parts.diffSimplified ? (
          <Badge tone="warning">差异已简化</Badge>
        ) : (
          parts.diff && (
            <DiffStat added={parts.diff.added} removed={parts.diff.removed} />
          )
        )}
        <Status status={tool.status} />
        <ChevronRight size={13} className="activity-chevron" />
      </summary>
      <div
        className="activity-output"
        tabIndex={0}
        role="region"
        aria-label={`${label}的详情`}
      >
        <ToolDetailBody
          tool={tool}
          loadContext={loadContext}
          projectPath={projectPath}
          onOpenSubagents={onOpenSubagents}
        />
      </div>
    </details>
  );
}

export function ToolGroup({
  tools,
  unrecovered = false,
  loadContext,
  projectPath,
  onOpenSubagents,
}: {
  tools: ToolActivity[];
  unrecovered?: boolean;
  loadContext?: ToolLoadContext;
  projectPath?: string;
  onOpenSubagents?: () => void;
}) {
  const pending = tools.some((t) => t.status === "pending");
  const failedCount = tools.filter((t) => t.status === "failed").length;
  const allFailed =
    !pending && tools.length > 0 && failedCount === tools.length;
  const escalateFailure =
    !pending &&
    (allFailed || (unrecovered && tools.at(-1)?.status === "failed"));
  const status: ToolActivity["status"] = pending
    ? "pending"
    : escalateFailure
      ? "failed"
      : tools.some((t) => t.status === "unconfirmed")
        ? "unconfirmed"
        : "completed";
  const showStepCount = tools.length > 3;
  const showMutedFailedCount = !pending && failedCount > 0 && !allFailed;
  const countLabel =
    showStepCount && showMutedFailedCount
      ? `· ${tools.length} 步（${failedCount} 项失败）`
      : showStepCount
        ? `· ${tools.length} 步`
        : showMutedFailedCount
          ? `· ${failedCount} 项失败`
          : null;

  return (
    <details className="activity-group" data-status={status}>
      <summary>
        {escalateFailure ? (
          <CircleAlert
            size={14}
            className="activity-icon activity-icon--danger"
          />
        ) : (
          <GroupIcon tools={tools} pending={pending} />
        )}
        <span className="activity-label">
          <span className="activity-group-summary">
            {toolGroupLabel(tools)}
          </span>
          {countLabel && (
            <span className="activity-group-count">{countLabel}</span>
          )}
        </span>
        <Status status={status} hidePending />
        <ChevronRight size={13} className="activity-chevron" />
      </summary>
      <div className="activity-children">
        {tools.map((tool) => (
          <ToolRow
            key={tool.key}
            tool={tool}
            loadContext={loadContext}
            projectPath={projectPath}
            onOpenSubagents={onOpenSubagents}
          />
        ))}
      </div>
    </details>
  );
}
