export type TurnErrorTone = "warning" | "danger";
export type TurnErrorCategory =
  "rate_limit" | "auth" | "context" | "upstream" | "general";

export interface ParsedTurnError {
  tone: TurnErrorTone;
  category: TurnErrorCategory;
  title: string;
  detail: string;
  raw: string;
}

const TRACE_TOKEN_RE =
  /^(?:req_[0-9a-z_-]+|trace[_-]?[0-9a-z_-]+|[0-9a-f]{16,}|[0-9]{12,}[0-9a-z_-]{6,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const NUMERIC_CODE_RE = /^\d{3,6}$/;

function extractJsonMessage(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const record = parsed as Record<string, unknown>;
    if (
      record.error &&
      typeof record.error === "object" &&
      !Array.isArray(record.error)
    ) {
      const errObj = record.error as Record<string, unknown>;
      if (typeof errObj.message === "string" && errObj.message.trim()) {
        return errObj.message.trim();
      }
    }
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message.trim();
    }
  } catch {
    return null;
  }
  return null;
}

function extractBracketHumanDetail(body: string): string | null {
  const brackets = [...body.matchAll(/\[([^\][]+)\]/g)].map((m) => m[1].trim());
  if (brackets.length === 0) return null;
  const meaningful = brackets.filter(
    (part) =>
      part.length > 0 &&
      !NUMERIC_CODE_RE.test(part) &&
      !TRACE_TOKEN_RE.test(part),
  );
  if (meaningful.length > 0) return meaningful.join(" · ");
  return null;
}

function stripNoiseTokens(text: string): string {
  return text
    .replace(
      /\s*\[(?:req_[0-9a-z_-]+|trace[_-]?[0-9a-z_-]+|[0-9a-f]{16,}|[0-9]{12,}[0-9a-z_-]{6,})\]\s*/gi,
      " ",
    )
    .replace(
      /\s*\((?:request[_\s-]?id|trace[_\s-]?id)\s*[:=]\s*[^)]+\)\s*/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .replace(/^[·:：\-–—\s]+|[·:：\-–—\s]+$/g, "")
    .trim();
}

function detectStatus(raw: string): number | undefined {
  const match =
    raw.match(/\bRequest rejected\s*\((\d{3})\)/i) ??
    raw.match(/\bAPI Error:\s*(\d{3})\b/i) ??
    raw.match(/\bHTTP\s*(\d{3})\b/i) ??
    raw.match(/\((\d{3})\)/);
  if (!match) return undefined;
  const code = Number.parseInt(match[1], 10);
  return code >= 400 && code <= 599 ? code : undefined;
}

function classifyError(
  raw: string,
  status: number | undefined,
): { tone: TurnErrorTone; category: TurnErrorCategory; title: string } {
  const lower = raw.toLowerCase();
  if (
    status === 429 ||
    lower.includes("rate_limit") ||
    lower.includes("too many requests") ||
    raw.includes("速率限制") ||
    raw.includes("请求频率")
  ) {
    return {
      tone: "warning",
      category: "rate_limit",
      title: `请求达到速率限制${status ? ` (${status})` : ""}`,
    };
  }
  if (
    status === 529 ||
    lower.includes("overloaded_error") ||
    lower.includes("overloaded")
  ) {
    return {
      tone: "warning",
      category: "rate_limit",
      title: `模型服务繁忙${status ? ` (${status})` : ""}`,
    };
  }
  if (
    status === 401 ||
    status === 403 ||
    lower.includes("invalid_api_key") ||
    lower.includes("authentication_error") ||
    lower.includes("unauthorized") ||
    lower.includes("insufficient_quota") ||
    lower.includes("billing_error") ||
    raw.includes("鉴权") ||
    raw.includes("配额不足") ||
    raw.includes("余额不足")
  ) {
    const label = status === 403 ? "模型访问被拒绝" : "模型鉴权失败";
    return {
      tone: "danger",
      category: "auth",
      title: `${label}${status ? ` (${status})` : ""}`,
    };
  }
  if (
    status === 413 ||
    lower.includes("context_length") ||
    lower.includes("prompt is too long") ||
    lower.includes("maximum context length") ||
    raw.includes("上下文长度") ||
    raw.includes("超出上下文")
  ) {
    return {
      tone: "danger",
      category: "context",
      title: `上下文超出模型上限${status ? ` (${status})` : ""}`,
    };
  }
  if (
    (status !== undefined && status >= 500 && status <= 599) ||
    lower.includes("bad gateway") ||
    lower.includes("gateway timeout") ||
    lower.includes("service unavailable") ||
    lower.includes("internal server error") ||
    lower.includes("upstream connect error")
  ) {
    return {
      tone: "danger",
      category: "upstream",
      title: `模型服务响应失败${status ? ` (${status})` : ""}`,
    };
  }
  if (/^\s*API Error\b/i.test(raw) || status !== undefined) {
    return {
      tone: "danger",
      category: "general",
      title: `模型请求失败${status ? ` (${status})` : ""}`,
    };
  }
  return {
    tone: "danger",
    category: "general",
    title: "执行失败",
  };
}

export function parseTurnError(rawInput: string): ParsedTurnError {
  const raw = rawInput.trim();
  const status = detectStatus(raw);
  const { tone, category, title } = classifyError(raw, status);

  const isStructuredApi = /^\s*API Error\b/i.test(raw);
  let remainder = raw;
  if (isStructuredApi) {
    remainder = remainder
      .replace(/^\s*API Error:\s*/i, "")
      .replace(/^Request rejected\s*\(\d{3}\)\s*[·:：\-–—]?\s*/i, "")
      .replace(
        /^\d{3}\s*(?:Unauthorized|Forbidden|Bad Gateway|Gateway Timeout|Service Unavailable|Too Many Requests|Internal Server Error)?\s*[·:：\-–—]?\s*/i,
        "",
      )
      .trim();
  }

  let detail =
    extractJsonMessage(remainder) ??
    (isStructuredApi || /^\s*\[/.test(remainder)
      ? extractBracketHumanDetail(remainder)
      : null) ??
    stripNoiseTokens(remainder);

  detail = stripNoiseTokens(detail);

  if (
    detail === title ||
    (detail.toLowerCase() === "overloaded" &&
      category === "rate_limit" &&
      title.includes("繁忙"))
  ) {
    if (detail === title) detail = "";
  }

  return {
    tone,
    category,
    title,
    detail,
    raw: rawInput,
  };
}
