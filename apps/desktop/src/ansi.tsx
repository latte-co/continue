import type { ReactNode } from "react";

// Matches C0 control chars except \t (0x09), \n (0x0A), and \r (0x0D), plus DEL (0x7F).
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_TEST = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

// Matches OSC sequences, CSI sequences, 2-byte ESC sequences, or stray control chars.
const ANSI_TOKEN_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[([0-?]*[ -/]*[@-~])|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

type AnsiColor =
  "muted" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white";

interface AnsiStyle {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  fg: AnsiColor | null;
}

const EMPTY_STYLE: AnsiStyle = {
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  fg: null,
};

function styleClasses(style: AnsiStyle): string {
  const classes: string[] = [];
  if (style.bold) classes.push("ansi-bold");
  if (style.dim) classes.push("ansi-dim");
  if (style.italic) classes.push("ansi-italic");
  if (style.underline) classes.push("ansi-underline");
  if (style.fg) classes.push(`ansi-fg-${style.fg}`);
  return classes.join(" ");
}

function applySgrCodes(current: AnsiStyle, rawParams: string): AnsiStyle {
  if (!rawParams) return { ...EMPTY_STYLE };
  const parts = rawParams.split(";");
  const next: AnsiStyle = { ...current };

  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i];
    const code = raw === "" ? 0 : Number.parseInt(raw, 10);
    if (!Number.isFinite(code)) continue;

    if (code === 0) {
      next.bold = false;
      next.dim = false;
      next.italic = false;
      next.underline = false;
      next.fg = null;
    } else if (code === 1) {
      next.bold = true;
    } else if (code === 2) {
      next.dim = true;
    } else if (code === 3) {
      next.italic = true;
    } else if (code === 4) {
      next.underline = true;
    } else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 23) {
      next.italic = false;
    } else if (code === 24) {
      next.underline = false;
    } else if (code === 39) {
      next.fg = null;
    } else if (code === 30 || code === 90) {
      next.fg = "muted";
    } else if (code === 31 || code === 91) {
      next.fg = "red";
    } else if (code === 32 || code === 92) {
      next.fg = "green";
    } else if (code === 33 || code === 93) {
      next.fg = "yellow";
    } else if (code === 34 || code === 94) {
      next.fg = "blue";
    } else if (code === 35 || code === 95) {
      next.fg = "magenta";
    } else if (code === 36 || code === 96) {
      next.fg = "cyan";
    } else if (code === 37 || code === 97) {
      next.fg = "white";
    } else if (code === 38 || code === 48) {
      // Extended 256-color (38;5;n) or 24-bit truecolor (38;2;r;g;b): advance past args cleanly.
      const mode = Number.parseInt(parts[i + 1] ?? "", 10);
      if (mode === 5) {
        i += 2;
      } else if (mode === 2) {
        i += 4;
      }
      if (code === 38) next.fg = null;
    }
  }

  return next;
}

/** Strip all ANSI escape sequences and non-printable C0 control bytes (such as 0x1B ESC). */
export function stripAnsi(text: string): string {
  if (!CONTROL_CHAR_TEST.test(text)) return text;
  return text.replace(ANSI_TOKEN_PATTERN, "");
}

/**
 * Safely convert terminal SGR ANSI sequences into semantic spans while stripping
 * non-SGR control codes so raw 0x1B bytes never render as missing-glyph tofu boxes.
 */
export function renderAnsiText(text: string): ReactNode {
  if (!CONTROL_CHAR_TEST.test(text)) return text;

  const nodes: ReactNode[] = [];
  let style: AnsiStyle = { ...EMPTY_STYLE };
  let lastIndex = 0;
  let key = 0;

  const pushSegment = (segment: string) => {
    if (!segment) return;
    const cls = styleClasses(style);
    if (!cls) {
      nodes.push(segment);
    } else {
      nodes.push(
        <span key={key++} className={cls}>
          {segment}
        </span>,
      );
    }
  };

  ANSI_TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ANSI_TOKEN_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      pushSegment(text.slice(lastIndex, match.index));
    }
    const csiBody = match[1];
    if (csiBody !== undefined && csiBody.endsWith("m")) {
      const params = csiBody.slice(0, -1);
      if (/^[0-9;]*$/.test(params)) {
        style = applySgrCodes(style, params);
      }
    }
    lastIndex = ANSI_TOKEN_PATTERN.lastIndex;
  }

  if (lastIndex < text.length) {
    pushSegment(text.slice(lastIndex));
  }

  if (nodes.length === 0) return "";
  if (nodes.length === 1 && typeof nodes[0] === "string") return nodes[0];
  return nodes;
}
