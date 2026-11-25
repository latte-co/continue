import {
  ChevronRight,
  ShieldCheck,
  Terminal,
  FileText,
  FilePenLine,
  Search,
  Wrench,
  MessageCircleQuestion,
} from "lucide-react";
import type { Event } from "./protocol";
import { toolDisplayParts, toolLabel, type ToolActivity } from "./activity";
import { ToolDetailBody, type ToolLoadContext } from "./ToolActivity";
import { ApprovalOperation } from "./ApprovalOperation";
import { Badge, Button, DiffStat } from "./ui";

type Request = Extract<Event["event"], { kind: "approval" }>;
export function ApprovalCard({
  request,
  resolved,
  decision,
  tool,
  disabled,
  busy,
  presentation = "request",
  loadContext,
  projectPath,
  onDecision,
}: {
  request: Request;
  resolved?: boolean;
  decision?: "allowed" | "denied" | "expired";
  tool?: ToolActivity;
  disabled?: boolean;
  busy?: boolean;
  presentation?: "request" | "record";
  loadContext?: ToolLoadContext;
  projectPath?: string;
  onDecision: (allow: boolean) => void;
}) {
  const requestTool: ToolActivity = {
    key: 0,
    type: "tool",
    name: request.tool,
    input: request.input,
    status: "waiting",
  };
  const label = toolLabel(requestTool);
  const kind = request.tool.toLowerCase();
  if (kind === "askuserquestion") {
    if (resolved || presentation === "record")
      return (
        <details className="activity-row question-result">
          <summary>
            <MessageCircleQuestion size={14} className="activity-icon" />
            <span className="activity-label">提问（旧记录）</span>
            <span className="activity-status">
              {resolved ? "未保存结构化回答" : "需要更新服务"}
            </span>
            <ChevronRight size={13} className="activity-chevron" />
          </summary>
          <div className="activity-output">
            <ApprovalOperation input={request.input} compact />
          </div>
        </details>
      );
    return (
      <section
        className="approval-card question-card"
        aria-label="问题交互暂不可用"
      >
        <header>
          <MessageCircleQuestion size={16} />
          需要你的回答
        </header>
        <p>
          当前主机服务尚不支持问题交互，请更新服务后使用。你也可以跳过这次问题，让模型继续。
        </p>
        <div className="approval-actions">
          <Button
            variant="subtle"
            size="md"
            disabled={disabled || busy}
            onClick={() => onDecision(false)}
          >
            {busy ? "正在提交…" : "跳过问题"}
          </Button>
        </div>
      </section>
    );
  }
  const [Icon, category] =
    kind === "bash"
      ? ([Terminal, "终端"] as const)
      : kind === "write"
        ? ([FileText, "写入文件"] as const)
        : ["edit", "multiedit"].includes(kind)
          ? ([FilePenLine, "编辑文件"] as const)
          : kind === "read"
            ? ([FileText, "读取文件"] as const)
            : ["glob", "grep"].includes(kind)
              ? ([Search, "搜索"] as const)
              : ([Wrench, request.tool] as const);
  const question =
    kind === "bash" ? "是否允许运行以下命令？" : `是否允许${label}？`;
  const status = !resolved
    ? "等待审批"
    : decision === "denied"
      ? "已拒绝"
      : decision !== "allowed"
        ? "审批已过期"
        : tool?.status === "failed"
          ? "执行失败"
          : tool?.status === "completed"
            ? "已完成"
            : tool?.status === "pending"
              ? "已允许 · 执行中"
              : tool?.status === "unconfirmed"
                ? "已允许 · 结果待确认"
                : "已允许";
  const parameters = (
    <details className="approval-parameters">
      <summary>
        操作参数
        <ChevronRight size={13} aria-hidden="true" />
      </summary>
      <pre>{JSON.stringify(request.input, null, 2)}</pre>
    </details>
  );
  if (resolved || presentation === "record") {
    const hasExecutionOutput =
      tool?.output !== undefined ||
      tool?.load !== undefined ||
      tool?.status === "pending";
    const effectiveTool: ToolActivity = {
      key: tool?.key ?? 0,
      type: "tool",
      name: tool?.name ?? request.tool,
      input: tool?.input ?? request.input,
      output: tool?.output,
      load: tool?.load,
      status: tool?.status ?? "waiting",
    };
    const parts = toolDisplayParts(
      {
        ...effectiveTool,
        name: request.tool,
        input: request.input,
      },
      true,
    );
    return (
      <details
        className="approval-result activity-row"
        data-status={tool?.status}
      >
        <summary title={label.replace(/\s+/g, " ")}>
          <ShieldCheck size={14} className="activity-icon" />
          <span className="activity-label">
            {parts.verb && <span className="activity-verb">{parts.verb}</span>}
            {parts.target ? (
              <span
                className={`activity-target${parts.monoTarget ? " is-mono" : ""}`}
              >
                {parts.target}
              </span>
            ) : (
              !parts.verb && <span className="activity-target">{label}</span>
            )}
          </span>
          {parts.diffSimplified ? (
            <Badge tone="warning">差异已简化</Badge>
          ) : (
            parts.diff && (
              <DiffStat added={parts.diff.added} removed={parts.diff.removed} />
            )
          )}
          <span
            className={`activity-status${tool?.status === "failed" ? " failure" : ""}`}
          >
            {status}
          </span>
          <ChevronRight size={13} className="activity-chevron" />
        </summary>
        <div
          className="activity-output"
          tabIndex={0}
          role="region"
          aria-label={`${label.replace(/\s+/g, " ")}的详情`}
        >
          <ToolDetailBody
            tool={effectiveTool}
            loadContext={loadContext}
            projectPath={projectPath}
            inputOnly={!hasExecutionOutput}
            hideToggles
          />
          {parameters}
        </div>
      </details>
    );
  }
  return (
    <section className="approval-card" aria-label={`${label}，需要确认`}>
      <header>
        <Icon size={16} aria-hidden="true" />
        <span>{category}</span>
      </header>
      <p className="approval-summary">{question}</p>
      <ToolDetailBody
        tool={requestTool}
        projectPath={projectPath}
        inputOnly
        hideToggles
      />
      <footer>
        {parameters}
        <div className="approval-actions">
          <Button
            variant="subtle"
            size="md"
            disabled={disabled || busy}
            onClick={() => onDecision(false)}
          >
            拒绝
          </Button>
          <Button
            variant="primary"
            size="md"
            busy={busy}
            disabled={disabled || busy}
            onClick={() => onDecision(true)}
          >
            {busy ? "处理中…" : "允许一次"}
          </Button>
        </div>
      </footer>
    </section>
  );
}
