export type ThemeMode = "system" | "light" | "dark";
export type ThemeKind = "light" | "dark";
export type FontChoice = "system" | "sans" | "serif" | "mono";
export type FontWeight = "400" | "500" | "600";
export interface ThemeConfig {
  accent: string;
  background: string;
  foreground: string;
  contrast: number;
  translucentSidebar: boolean;
  uiFont: FontChoice;
  contentFont: FontChoice | "inherit";
  codeFont: "system" | "menlo" | "consolas";
  uiWeight: FontWeight;
  contentWeight: FontWeight;
  codeWeight: FontWeight;
}
export interface Appearance {
  version: 1;
  mode: ThemeMode;
  light: ThemeConfig;
  dark: ThemeConfig;
}
export const APPEARANCE_KEY = "latte-work.appearance.v1";
export const APPEARANCE_EVENT = "latte-work:appearance";
export const MAX_THEME_BYTES = 32 * 1024;
export const fonts = {
  system:
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", sans-serif',
  sans: 'Arial, "PingFang SC", sans-serif',
  serif: 'Georgia, "Songti SC", serif',
  mono: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
};
export const codeFonts = {
  system: fonts.mono,
  menlo: 'Menlo, Monaco, "Courier New", monospace',
  consolas: 'Consolas, "Courier New", monospace',
};
export const presets: Record<
  ThemeKind,
  Record<string, Pick<ThemeConfig, "accent" | "background" | "foreground">>
> = {
  dark: {
    Latte: { accent: "#F2F2F2", background: "#181818", foreground: "#F2F2F2" },
    Material: {
      accent: "#82AAFF",
      background: "#1E272C",
      foreground: "#F5F7FA",
    },
    Graphite: {
      accent: "#B9A3FF",
      background: "#202024",
      foreground: "#ECECF0",
    },
  },
  light: {
    Latte: { accent: "#2563EB", background: "#FFFFFF", foreground: "#181818" },
    Paper: { accent: "#806044", background: "#FAF7F2", foreground: "#2C2824" },
    Mint: { accent: "#247564", background: "#F4F8F6", foreground: "#1D312B" },
  },
};
export function defaultTheme(kind: ThemeKind): ThemeConfig {
  return {
    ...presets[kind].Latte,
    contrast: 50,
    translucentSidebar: false,
    uiFont: "system",
    contentFont: "inherit",
    codeFont: "system",
    uiWeight: "400",
    contentWeight: "400",
    codeWeight: "400",
  };
}
export function defaultAppearance(): Appearance {
  return {
    version: 1,
    mode: "system",
    light: defaultTheme("light"),
    dark: defaultTheme("dark"),
  };
}
export function isColor(value: unknown): value is string {
  return typeof value === "string" && /^#[\da-f]{6}$/i.test(value);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function choice(value: unknown, choices: string[]): boolean {
  return typeof value === "string" && choices.includes(value);
}
function parseTheme(value: unknown): ThemeConfig {
  if (
    !record(value) ||
    ![value.accent, value.background, value.foreground].every(isColor) ||
    typeof value.contrast !== "number" ||
    !Number.isFinite(value.contrast) ||
    value.contrast < 0 ||
    value.contrast > 100 ||
    typeof value.translucentSidebar !== "boolean" ||
    !choice(value.uiFont, ["system", "sans", "serif", "mono"]) ||
    !choice(value.contentFont, [
      "inherit",
      "system",
      "sans",
      "serif",
      "mono",
    ]) ||
    !choice(value.codeFont, ["system", "menlo", "consolas"]) ||
    ![value.uiWeight, value.contentWeight, value.codeWeight].every(
      (v) => typeof v === "string" && ["400", "500", "600"].includes(v),
    )
  ) {
    throw new Error("主题字段无效，请使用从 Continue One 复制的主题 JSON。");
  }
  // Copy only known fields; imported data is never interpreted as CSS or HTML.
  return {
    accent: String(value.accent).toUpperCase(),
    background: String(value.background).toUpperCase(),
    foreground: String(value.foreground).toUpperCase(),
    contrast: value.contrast,
    translucentSidebar: value.translucentSidebar,
    uiFont: value.uiFont as FontChoice,
    contentFont: value.contentFont as ThemeConfig["contentFont"],
    codeFont: value.codeFont as ThemeConfig["codeFont"],
    uiWeight: value.uiWeight as FontWeight,
    contentWeight: value.contentWeight as FontWeight,
    codeWeight: value.codeWeight as FontWeight,
  };
}
export function parseAppearance(text: string): Appearance {
  if (new TextEncoder().encode(text).length > MAX_THEME_BYTES)
    throw new Error("主题文件不能超过 32 KB。");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("JSON 格式不正确。");
  }
  if (
    !record(value) ||
    value.version !== 1 ||
    !choice(value.mode, ["system", "light", "dark"])
  ) {
    throw new Error("不支持的主题格式或版本。");
  }
  return {
    version: 1,
    mode: value.mode as ThemeMode,
    light: parseTheme(value.light),
    dark: parseTheme(value.dark),
  };
}
export function readAppearance(): { settings: Appearance; error: string } {
  try {
    const raw = localStorage.getItem(APPEARANCE_KEY);
    return {
      settings: raw ? parseAppearance(raw) : defaultAppearance(),
      error: "",
    };
  } catch {
    return {
      settings: defaultAppearance(),
      error: "无法读取已保存的外观，当前使用默认主题。重新调整后可保存。",
    };
  }
}
export function saveAppearance(settings: Appearance): string {
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(settings));
    return "";
  } catch {
    return "外观已应用，但无法保存到本机。重启后可能丢失。";
  }
}
export function resolveTheme(mode: ThemeMode, systemDark: boolean): ThemeKind {
  return mode === "system" ? (systemDark ? "dark" : "light") : mode;
}

function rgb(color: string): [number, number, number] {
  return [
    parseInt(color.slice(1, 3), 16),
    parseInt(color.slice(3, 5), 16),
    parseInt(color.slice(5, 7), 16),
  ];
}

function srgbToLinear(channel: number): number {
  const n = channel / 255;
  return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
}

function linearToSrgbByte(linear: number): number {
  const c = Math.max(0, Math.min(1, linear));
  const encoded = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(encoded * 255)));
}

function hexToOklab(color: string): [number, number, number] {
  const [r, g, b] = rgb(color).map(srgbToLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToHex(L: number, a: number, b: number, neutral: boolean): string {
  const clampedL = Math.max(0, Math.min(1, L));
  if (neutral) {
    const lin = clampedL ** 3;
    const byte = linearToSrgbByte(lin).toString(16).padStart(2, "0");
    return `#${byte}${byte}${byte}`;
  }
  const l_ = clampedL + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = clampedL - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = clampedL - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return (
    "#" +
    [r, g, bl]
      .map((v) => linearToSrgbByte(v).toString(16).padStart(2, "0"))
      .join("")
  );
}

function isNeutralHex(color: string): boolean {
  const [r, g, b] = rgb(color);
  return r === g && g === b;
}

/** Perceptually uniform OKLab/OKLCH interpolation serialized to 6-digit hex. */
export function mix(a: string, b: string, ratio: number): string {
  const t = Math.max(0, Math.min(1, ratio));
  const [L1, a1, b1] = hexToOklab(a);
  const [L2, a2, b2] = hexToOklab(b);
  const neutral = isNeutralHex(a) && isNeutralHex(b);
  return oklabToHex(
    L1 + (L2 - L1) * t,
    a1 + (a2 - a1) * t,
    b1 + (b2 - b1) * t,
    neutral,
  );
}

/** Shift perceptual lightness while preserving (and gently retaining) hue/chroma. */
function shiftLightness(
  color: string,
  deltaL: number,
  chromaScale = 1,
): string {
  const [L, a, b] = hexToOklab(color);
  const neutral = isNeutralHex(color);
  const baseL = deltaL > 0 ? Math.max(L, 0.16) : L;
  return oklabToHex(
    baseL + deltaL,
    neutral ? 0 : a * chromaScale,
    neutral ? 0 : b * chromaScale,
    neutral,
  );
}

function luminance(color: string): number {
  const values = rgb(color).map(srgbToLinear);
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}

export function contrastRatio(a: string, b: string): number {
  const l = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l[0] + 0.05) / (l[1] + 0.05);
}

/** Worst-case text-to-surface contrast across canvas, sidebar, cards, inputs, and elevated overlays. */
export function minimumThemeContrast(theme: ThemeConfig): number {
  const tokens = themeTokens(theme);
  const surfaces = [
    tokens["--color-canvas"],
    tokens["--color-sidebar"].slice(0, 7),
    tokens["--color-surface"],
    tokens["--color-card"],
    tokens["--color-elevated"],
    tokens["--color-input"],
    tokens["--color-composer"],
  ];
  const texts = [
    tokens["--color-text"],
    tokens["--color-text-secondary"],
    tokens["--color-text-muted"],
  ];
  let worst = Number.POSITIVE_INFINITY;
  for (const text of texts) {
    for (const surface of surfaces) {
      worst = Math.min(worst, contrastRatio(text, surface));
    }
  }
  return worst;
}

function minContrastAgainst(color: string, against: string[]): number {
  let worst = Number.POSITIVE_INFINITY;
  for (const bg of against) {
    worst = Math.min(worst, contrastRatio(color, bg));
  }
  return worst;
}

/** Guarantee minimum WCAG contrast against reference surfaces via perceptual stepping. */
function ensureContrast(
  candidate: string,
  against: string[],
  targetFg: string,
  minRatio = 4.6,
): string {
  const candidateRatio = minContrastAgainst(candidate, against);
  if (candidateRatio >= minRatio) return candidate;

  for (let step = 1; step <= 20; step++) {
    const current = mix(candidate, targetFg, step * 0.05);
    if (minContrastAgainst(current, against) >= minRatio) return current;
  }

  const fgRatio = minContrastAgainst(targetFg, against);
  const fallbackMin = 4.55;
  if (fgRatio >= fallbackMin) return targetFg;

  const pole =
    minContrastAgainst("#ffffff", against) >=
    minContrastAgainst("#000000", against)
      ? "#ffffff"
      : "#000000";

  let best = fgRatio >= candidateRatio ? targetFg : candidate;
  let bestRatio = Math.max(fgRatio, candidateRatio);
  for (let step = 1; step <= 20; step++) {
    const boosted = mix(targetFg, pole, step * 0.05);
    const ratio = minContrastAgainst(boosted, against);
    if (ratio >= fallbackMin) return boosted;
    if (ratio > bestRatio) {
      best = boosted;
      bestRatio = ratio;
    }
  }
  return best;
}

export function themeTokens(theme: ThemeConfig): Record<string, string> {
  const bg = theme.background;
  const fg = theme.foreground;
  const accent = theme.accent;
  const dark = luminance(bg) < 0.4;
  const scale = 0.65 + (theme.contrast / 100) * 0.7;
  const step = (n: number) => mix(bg, fg, n);
  const shell = dark
    ? shiftLightness(bg, -0.022 * scale, 1.06)
    : shiftLightness(bg, -0.024 * scale, 1.08);
  const sidebarBase = shell;
  const surface = dark
    ? shiftLightness(bg, 0.03 * scale)
    : shiftLightness(bg, -0.014 * scale, 1.04);
  const card = dark ? shiftLightness(bg, 0.03 * scale) : bg;
  const elevated = dark ? shiftLightness(bg, 0.046 * scale) : bg;
  const input = dark
    ? shiftLightness(bg, 0.016 * scale)
    : shiftLightness(bg, -0.009 * scale, 1.02);
  const composer = dark ? shiftLightness(bg, 0.036 * scale) : bg;

  const surfaces = [bg, sidebarBase, surface, card, elevated, input, composer];
  const textSecondary = ensureContrast(
    step(dark ? 0.84 : 0.78),
    surfaces,
    fg,
    7.0,
  );
  const textMuted = ensureContrast(
    step(dark ? 0.68 : 0.62),
    surfaces,
    fg,
    4.75,
  );

  return {
    "--color-shell": shell,
    "--color-canvas": bg,
    "--color-text": fg,
    "--color-sidebar": theme.translucentSidebar
      ? sidebarBase + "c7"
      : sidebarBase,
    "--color-surface": surface,
    "--color-card": card,
    "--color-elevated": elevated,
    "--color-well": fg + (dark ? "0c" : "0a"),
    "--color-input": input,
    "--color-composer": composer,
    "--color-text-secondary": textSecondary,
    "--color-text-muted": textMuted,
    "--color-placeholder": textMuted,
    "--color-border-subtle": dark
      ? shiftLightness(bg, 0.045 * scale)
      : shiftLightness(bg, -0.042 * scale),
    "--color-border": dark
      ? shiftLightness(bg, 0.068 * scale)
      : shiftLightness(bg, -0.068 * scale),
    "--color-border-strong": dark
      ? shiftLightness(bg, 0.098 * scale)
      : shiftLightness(bg, -0.105 * scale),
    "--color-hover": fg + (dark ? "0d" : "0a"),
    "--color-row-selected": fg + (dark ? "15" : "10"),
    "--color-selected": fg + (dark ? "1c" : "15"),
    "--color-focus-background": fg + "22",
    "--color-focus-ring": dark
      ? mix(fg, "#FFFFFF", 0.2)
      : mix(fg, "#000000", 0.15),
    "--color-primary": accent,
    "--color-primary-hover": mix(accent, dark ? "#FFFFFF" : "#000000", 0.12),
    "--color-on-primary":
      contrastRatio(accent, "#FFFFFF") > contrastRatio(accent, "#121212")
        ? "#FFFFFF"
        : "#121212",
    "--color-action": dark ? "#FFFFFF" : "#181818",
    "--color-action-hover": dark ? "#E6E6E6" : "#2E2E2E",
    "--color-on-action": dark ? "#141414" : "#FFFFFF",
    "--color-disabled-bg": step(0.065),
    "--color-disabled-text": textMuted,
    "--color-stop": step(dark ? 0.22 : 0.12),
    "--color-stop-hover": step(dark ? 0.3 : 0.18),
    "--color-on-stop": fg,
    "--color-brand": accent,
    "--color-code-keyword": dark ? "#CDA4D7" : "#6B3D83",
    "--color-code-string": dark ? "#C4C998" : "#526B20",
    "--color-code-number": dark ? "#A7C6BE" : "#256557",
    "--color-code-type": dark ? "#DFBC85" : "#805616",
    "--color-success": dark ? "#55C88A" : "#1E7A46",
    "--color-warning": dark ? "#E8B658" : "#946000",
    "--color-danger": dark ? "#F08888" : "#C03939",
    "--color-unread": dark ? "#6EA4FF" : "#2563EB",
    "--color-backdrop": dark ? "#0000008c" : "#00000038",
    "--color-selection": accent + "3d",
    "--shadow-island": dark
      ? "0 0 0 1px rgba(255, 255, 255, 0.065), 0 4px 16px -4px rgba(0, 0, 0, 0.24)"
      : "0 0 0 1px rgba(0, 0, 0, 0.065), 0 4px 16px -6px rgba(15, 23, 42, 0.045)",
    "--shadow-well": dark
      ? "inset 0 0 0 1px rgba(255, 255, 255, 0.065)"
      : "inset 0 0 0 1px rgba(0, 0, 0, 0.065)",
    "--shadow-card": dark
      ? "0 0 0 1px rgba(255, 255, 255, 0.065)"
      : "0 0 0 1px rgba(0, 0, 0, 0.065), 0 1px 2px rgba(15, 23, 42, 0.03)",
    "--shadow-elevated": dark
      ? "0 0 0 1px rgba(255, 255, 255, 0.075), 0 2px 6px rgba(0, 0, 0, 0.18)"
      : "0 0 0 1px rgba(0, 0, 0, 0.065), 0 1px 3px rgba(15, 23, 42, 0.06)",
    "--shadow-composer": dark
      ? "0 0 0 1px rgba(255, 255, 255, 0.08), 0 2px 8px rgba(0, 0, 0, 0.16)"
      : "0 0 0 1px rgba(0, 0, 0, 0.08), 0 2px 8px rgba(15, 23, 42, 0.04)",
    "--shadow-composer-focus": dark
      ? "0 0 0 1px rgba(255, 255, 255, 0.14), 0 2px 8px rgba(0, 0, 0, 0.18)"
      : "0 0 0 1px rgba(0, 0, 0, 0.15), 0 2px 8px rgba(15, 23, 42, 0.05)",
    "--shadow-dialog": dark
      ? "0 16px 40px -8px rgba(0, 0, 0, 0.42), 0 0 0 1px rgba(255, 255, 255, 0.1)"
      : "0 16px 40px -10px rgba(15, 23, 42, 0.14), 0 0 0 1px rgba(0, 0, 0, 0.085)",
    "--shadow-popover": dark
      ? "0 12px 28px -6px rgba(0, 0, 0, 0.36), 0 0 0 1px rgba(255, 255, 255, 0.09)"
      : "0 12px 28px -8px rgba(15, 23, 42, 0.12), 0 0 0 1px rgba(0, 0, 0, 0.08)",
    "--font-ui": fonts[theme.uiFont],
    "--font-content":
      theme.contentFont === "inherit"
        ? fonts[theme.uiFont]
        : fonts[theme.contentFont],
    "--font-code": codeFonts[theme.codeFont],
    "--weight-ui": theme.uiWeight,
    "--weight-content": theme.contentWeight,
    "--weight-content-emphasis": theme.contentWeight === "400" ? "500" : "600",
    "--weight-code": theme.codeWeight,
  };
}
export function applyAppearance(
  settings: Appearance,
  systemDark: boolean,
): void {
  const kind = resolveTheme(settings.mode, systemDark);
  const root = document.documentElement;
  Object.entries(themeTokens(settings[kind])).forEach(([key, value]) =>
    root.style.setProperty(key, value),
  );
  root.style.colorScheme = kind;
  root.dataset.theme = kind;
  root.dataset.translucentSidebar = String(settings[kind].translucentSidebar);
  window.dispatchEvent(new Event(APPEARANCE_EVENT));
}
