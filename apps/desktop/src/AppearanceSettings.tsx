import { copyText } from "./clipboard";
import { AppearancePreview } from "./AppearancePreview";
import { MessageContent } from "./MessageContent";
import { SettingsPane } from "./SettingsPane";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, Copy, RotateCcw, Upload } from "lucide-react";
import { useAppearance } from "./AppearanceProvider";
import {
  defaultTheme,
  isColor,
  MAX_THEME_BYTES,
  minimumThemeContrast,
  parseAppearance,
  presets,
  resolveTheme,
  themeTokens,
  type ThemeConfig,
  type ThemeKind,
  type ThemeMode,
} from "./appearance";
import {
  Button,
  CardList,
  ColorField,
  NoticeBanner,
  Section,
  SectionHeader,
  Segmented,
  Select,
  SettingRow,
  Slider,
  Switch,
} from "./ui";

const modes: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

const fontOptions = [
  { value: "system", label: "系统默认" },
  { value: "sans", label: "无衬线" },
  { value: "serif", label: "衬线" },
  { value: "mono", label: "等宽" },
];

const weights = [
  { value: "400", label: "常规" },
  { value: "500", label: "中等" },
  { value: "600", label: "半粗" },
];

function ColorControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (color: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const valid = isColor(draft);
  return (
    <ColorField
      label={label}
      pickerLabel={`${label}拾色器`}
      value={draft}
      swatchColor={value}
      error={!valid ? "请输入 #RRGGBB" : undefined}
      errorRole="status"
      onTextBlur={() => {
        if (!valid) setDraft(value);
      }}
      onTextKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          setDraft(value);
        }
      }}
      onChange={(next) => {
        setDraft(next);
        if (isColor(next)) onChange(next.toUpperCase());
      }}
    />
  );
}

export function AppearanceSettings({
  onClose,
  closeDisabled = false,
}: {
  onClose?: () => void;
  closeDisabled?: boolean;
} = {}) {
  const { settings, kind, error, update } = useAppearance();
  const [editing, setEditing] = useState<ThemeKind>(kind);
  const [transferring, setTransferring] = useState(false);
  const [notice, setNotice] = useState("");
  const [importError, setImportError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const theme = settings[editing];
  const preset =
    Object.entries(presets[editing]).find(
      ([, p]) =>
        p.accent === theme.accent &&
        p.background === theme.background &&
        p.foreground === theme.foreground,
    )?.[0] ?? "custom";
  const patch = (value: Partial<ThemeConfig>) =>
    update({ ...settings, [editing]: { ...theme, ...value } });

  function importJson(text: string) {
    try {
      const next = parseAppearance(text);
      update(next);
      setImportError("");
      setEditing(
        resolveTheme(
          next.mode,
          window.matchMedia("(prefers-color-scheme: dark)").matches,
        ),
      );
      setNotice("已导入浅色、深色主题及主题模式。");
    } catch (e) {
      setImportError(String((e as Error).message));
    }
  }

  return (
    <SettingsPane
      title="外观"
      description="让工作台适合你的阅读习惯。修改即时生效，并保存在此设备。"
      className="appearance-settings"
      onClose={onClose}
      closeDisabled={closeDisabled || transferring}
    >
      <Section>
        <SectionHeader title="主题" />
        <div className="appearance-modes" role="group" aria-label="主题模式">
          {modes.map((mode) => (
            <button
              key={mode.value}
              className="appearance-mode"
              aria-pressed={settings.mode === mode.value}
              onClick={() => {
                update({ ...settings, mode: mode.value });
                setEditing(
                  mode.value === "system"
                    ? window.matchMedia("(prefers-color-scheme: dark)").matches
                      ? "dark"
                      : "light"
                    : mode.value,
                );
              }}
            >
              <span
                className={`appearance-thumbnail ${mode.value}`}
                aria-hidden="true"
              >
                <span className="thumbnail-sidebar" />
                <span className="thumbnail-content">
                  <i />
                  <i />
                  <span>
                    <i />
                    <i />
                    <i />
                  </span>
                </span>
              </span>
              <span>
                {mode.label}
                {settings.mode === mode.value && <Check size={14} />}
              </span>
            </button>
          ))}
        </div>
      </Section>

      <div className="appearance-editor-heading" style={{ margin: 0 }}>
        <Segmented
          label="编辑主题"
          roleType="group"
          size="md"
          value={editing}
          onChange={setEditing}
          options={[
            { value: "light", label: "浅色主题" },
            { value: "dark", label: "深色主题" },
          ]}
        />
        <span>{editing === kind ? "当前使用" : "切换主题模式后应用"}</span>
      </div>

      <div
        className="appearance-preview"
        style={themeTokens(theme) as CSSProperties}
        aria-label="主题预览"
      >
        <div className="appearance-preview-copy markdown">
          <MessageContent
            text={`### 让想法变成作品

这是聊天正文的预览。中文、English 和 \`inline code\` 保持清晰，**重点信息**稍作强调。

- 清晰的行距与段落留白，适合阅读较长的回复。
- [链接与强调色](#appearance-controls)与正文保持同一阅读节奏。`}
          />
        </div>
        <div className="appearance-preview-code">
          <div>
            <span>−</span>
            <code>const theme = "default";</code>
          </div>
          <div>
            <span>+</span>
            <code>const theme = "your style";</code>
          </div>
        </div>
      </div>

      <div
        className="appearance-preview"
        style={themeTokens(theme) as CSSProperties}
      >
        <AppearancePreview />
      </div>

      <CardList id="appearance-controls">
        <SettingRow label={editing === "dark" ? "深色主题" : "浅色主题"}>
          <Button
            variant="subtle"
            size="sm"
            leading={<Upload size={13.5} />}
            disabled={transferring}
            title="选择 JSON 文件，导入浅色、深色主题及主题模式"
            onClick={() => {
              setNotice("");
              setImportError("");
              fileInput.current?.click();
            }}
          >
            导入
          </Button>
          <Button
            variant="subtle"
            size="sm"
            leading={<Copy size={13.5} />}
            disabled={transferring}
            title="复制包含浅色、深色主题及主题模式的 JSON"
            onClick={async () => {
              setImportError("");
              setNotice("");
              setTransferring(true);
              try {
                await copyText(JSON.stringify(settings, null, 2));
                setNotice("已复制完整主题 JSON，可保存为 .json 文件后导入。");
              } catch {
                setImportError("无法写入剪贴板，请重试或检查系统剪贴板权限。");
              } finally {
                setTransferring(false);
              }
            }}
          >
            复制主题
          </Button>
          <Select
            label="主题预设"
            variant="ghost"
            size="sm"
            minMenuWidth={150}
            align="end"
            value={preset}
            options={[
              ...Object.keys(presets[editing]).map((value) => ({
                value,
                label: value,
              })),
              { value: "custom", label: "自定义" },
            ]}
            onChange={(v) => {
              if (presets[editing][v]) patch(presets[editing][v]);
            }}
          />
        </SettingRow>

        {(
          [
            ["accent", "强调色"],
            ["background", "背景"],
            ["foreground", "前景"],
          ] as const
        ).map(([key, label]) => (
          <SettingRow key={key} label={label}>
            <ColorControl
              label={label}
              value={theme[key]}
              onChange={(v) => patch({ [key]: v })}
            />
          </SettingRow>
        ))}

        {(
          [
            ["uiFont", "uiWeight", "UI 字体"],
            ["contentFont", "contentWeight", "内容字体"],
            ["codeFont", "codeWeight", "代码字体"],
          ] as const
        ).map(([font, weight, label]) => (
          <SettingRow key={font} label={label}>
            <Select
              label={label}
              variant="ghost"
              size="sm"
              minMenuWidth={168}
              align="end"
              value={theme[font]}
              options={
                font === "codeFont"
                  ? [
                      { value: "system", label: "系统默认" },
                      { value: "menlo", label: "Menlo" },
                      { value: "consolas", label: "Consolas" },
                    ]
                  : font === "contentFont"
                    ? [
                        { value: "inherit", label: "与界面字体相同" },
                        ...fontOptions,
                      ]
                    : fontOptions
              }
              onChange={(v) => patch({ [font]: v })}
            />
            <Select
              label={`${label}字重`}
              variant="ghost"
              size="sm"
              minMenuWidth={112}
              align="end"
              value={theme[weight]}
              options={weights}
              onChange={(v) => patch({ [weight]: v })}
            />
          </SettingRow>
        ))}

        <SettingRow label="半透明侧边栏" description="应用内透明效果">
          <Switch
            label="半透明侧边栏"
            checked={theme.translucentSidebar}
            onChange={(checked) => patch({ translucentSidebar: checked })}
          />
        </SettingRow>

        <SettingRow label="对比度" htmlFor="appearance-contrast">
          <Slider
            id="appearance-contrast"
            label="对比度"
            min={0}
            max={100}
            value={theme.contrast}
            onChange={(contrast) => patch({ contrast })}
          />
        </SettingRow>
      </CardList>

      {(() => {
        const minContrast = minimumThemeContrast(theme);
        return (
          minContrast < 4.5 && (
            <NoticeBanner tone="warning">
              当前文字与界面层对比度较低（最低 {minContrast.toFixed(1)}
              :1），阅读可能吃力。可调整前景、背景或对比度设置。
            </NoticeBanner>
          )
        );
      })()}

      <div className="appearance-footer" style={{ margin: 0 }}>
        <span>未安装的字体会自动使用备用字体。</span>
        <Button
          variant="subtle"
          size="md"
          leading={<RotateCcw size={14} />}
          onClick={() => {
            update({ ...settings, [editing]: defaultTheme(editing) });
            setNotice("已恢复当前编辑主题的默认设置。");
          }}
        >
          恢复此主题默认值
        </Button>
      </div>

      <input
        ref={fileInput}
        className="appearance-file-input"
        hidden
        type="file"
        aria-label="导入主题 JSON 文件"
        accept=".json,application/json"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setNotice("");
          setImportError("");
          if (file.size > MAX_THEME_BYTES) {
            setImportError("主题文件不能超过 32 KB。");
            return;
          }
          setTransferring(true);
          try {
            importJson(await file.text());
          } catch {
            setImportError("无法读取主题文件。");
          } finally {
            setTransferring(false);
          }
        }}
      />

      {importError && <NoticeBanner tone="danger">{importError}</NoticeBanner>}
      {error && <NoticeBanner tone="danger">{error}</NoticeBanner>}
      <p role="status" className="appearance-notice">
        {notice}
      </p>
    </SettingsPane>
  );
}
