import type { ComponentProps, ReactNode } from "react";
import {
  CheckCircle2,
  CircleAlert,
  CircleHelp,
  CirclePause,
  Info,
  TriangleAlert,
} from "lucide-react";

export type SignalKind =
  "running" | "waiting" | "unread" | "failed" | "unknown" | "idle";

const SIGNAL_LABELS: Record<Exclude<SignalKind, "idle">, string> = {
  running: "执行中",
  waiting: "等待确认",
  unread: "未读",
  failed: "执行失败",
  unknown: "状态待确认",
};

/**
 * Global 5-state status signal grammar (silence when idle/completed).
 * Strictly preserves `unknown` for disconnected/interrupted sessions without inferring completion.
 */
export function StatusSignal({
  status,
  label,
  title,
}: {
  status: SignalKind;
  label?: string;
  title?: string;
}) {
  if (status === "idle") return null;
  const text = label ?? SIGNAL_LABELS[status];
  const tip = title ?? text;
  if (status === "running") {
    return (
      <span className="ui-signal-dots" role="img" aria-label={text} title={tip}>
        <i />
        <i />
        <i />
      </span>
    );
  }
  if (status === "waiting") {
    return (
      <CirclePause
        size={13.5}
        style={{ color: "var(--color-warning)" }}
        role="img"
        aria-label={text}
      >
        <title>{tip}</title>
      </CirclePause>
    );
  }
  if (status === "failed") {
    return (
      <CircleAlert
        size={13.5}
        style={{ color: "var(--color-danger)" }}
        role="img"
        aria-label={text}
      >
        <title>{tip}</title>
      </CircleAlert>
    );
  }
  if (status === "unknown") {
    return (
      <CircleHelp
        size={13.5}
        style={{ color: "var(--color-text-muted)" }}
        role="img"
        aria-label={text}
      >
        <title>{tip}</title>
      </CircleHelp>
    );
  }
  return (
    <span
      className="ui-signal-unread"
      role="img"
      aria-label={text}
      title={tip}
    />
  );
}

export function Badge({
  tone = "neutral",
  className,
  ...props
}: ComponentProps<"span"> & {
  tone?: "neutral" | "brand" | "success" | "warning" | "danger";
}) {
  return (
    <span
      className={[
        "ui-badge",
        tone !== "neutral" ? `ui-badge--${tone}` : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      {...props}
    />
  );
}

/**
 * Unified inline status or alert callout (`8px` radius, semantic icon, optional trailing action).
 * Replaces ad-hoc `<p role="alert">`, `.form-error`, `.agent-notice`, and `.archive-load-error`.
 */
export function NoticeBanner({
  tone = "neutral",
  action,
  className,
  children,
  ...props
}: ComponentProps<"div"> & {
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
  action?: ReactNode;
}) {
  const Icon =
    tone === "danger"
      ? CircleAlert
      : tone === "warning"
        ? TriangleAlert
        : tone === "success"
          ? CheckCircle2
          : Info;
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={[
        "ui-notice-banner",
        tone !== "neutral" ? `ui-notice-banner--${tone}` : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      {...props}
    >
      <Icon size={15} className="ui-notice-icon" aria-hidden="true" />
      <div className="ui-notice-body">{children}</div>
      {action && <div className="ui-notice-action">{action}</div>}
    </div>
  );
}

/** Calm recessed 10px zero-data / empty-filter placeholder. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className={["ui-empty-state", className ?? ""].filter(Boolean).join(" ")}
      {...props}
    >
      {icon && (
        <div className="ui-empty-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <div className="ui-empty-title">{title}</div>
      {description && <p className="ui-empty-description">{description}</p>}
      {action && <div className="ui-empty-action">{action}</div>}
    </div>
  );
}

export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={["ui-kbd", className ?? ""].filter(Boolean).join(" ")}
      {...props}
    />
  );
}

export function DiffStat({
  added,
  removed,
  className,
}: {
  added: number;
  removed: number;
  className?: string;
}) {
  return (
    <span
      className={["ui-diff-stat", className ?? ""].filter(Boolean).join(" ")}
    >
      <span className="ui-diff-stat-add">+{added}</span>
      <span className="ui-diff-stat-del">-{removed}</span>
    </span>
  );
}

export function StateBlock({
  kind = "empty",
  compact = false,
  action,
  children,
}: {
  kind?: "empty" | "loading" | "truncated" | "error";
  compact?: boolean;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      className={[
        "ui-state-block",
        compact || kind === "truncated" ? "ui-state-block--banner" : "",
        kind === "error" ? "ui-state-block--error" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span>{children}</span>
      {action && <span>{action}</span>}
    </div>
  );
}
