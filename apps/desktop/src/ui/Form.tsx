import { useId, useRef, type ComponentProps, type ReactNode } from "react";
import { Check, Search, X } from "lucide-react";
import { useDefaultControlSize } from "./context";

export type FormControlSize = "lg" | "md" | "sm";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function Field({
  label,
  labelTrailing,
  htmlFor,
  hint,
  error,
  className,
  children,
}: {
  label: ReactNode;
  labelTrailing?: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx("ui-field", className)}>
      <div className="ui-field-header">
        <label className="ui-field-label" htmlFor={htmlFor}>
          {label}
        </label>
        {labelTrailing && (
          <div className="ui-field-trailing">{labelTrailing}</div>
        )}
      </div>
      {children}
      {error ? (
        <div role="alert" className="ui-field-error">
          {error}
        </div>
      ) : hint ? (
        <div className="ui-field-hint">{hint}</div>
      ) : null}
    </div>
  );
}

export function TextInput({
  size,
  compact = false,
  monospace = false,
  invalid = false,
  className,
  ...props
}: Omit<ComponentProps<"input">, "size"> & {
  size?: FormControlSize;
  compact?: boolean;
  monospace?: boolean;
  invalid?: boolean;
}) {
  const contextSize = useDefaultControlSize();
  const effectiveSize: FormControlSize =
    size ?? contextSize ?? (compact ? "sm" : "lg");
  return (
    <input
      aria-invalid={invalid || props["aria-invalid"] || undefined}
      className={cx(
        "ui-input",
        effectiveSize !== "lg" && `ui-input--${effectiveSize}`,
        monospace && "ui-input--mono",
        invalid && "ui-input--invalid",
        className,
      )}
      {...props}
    />
  );
}

/** Horizontal group aligning a TextInput with a trailing/leading Button or IconButton. */
export function InputGroup({ className, ...props }: ComponentProps<"div">) {
  return <div className={cx("ui-input-group", className)} {...props} />;
}

export function TextArea({
  monospace = false,
  invalid = false,
  className,
  ...props
}: ComponentProps<"textarea"> & {
  monospace?: boolean;
  invalid?: boolean;
}) {
  return (
    <textarea
      aria-invalid={invalid || props["aria-invalid"] || undefined}
      className={cx(
        "ui-textarea",
        monospace && "ui-textarea--mono",
        invalid && "ui-textarea--invalid",
        className,
      )}
      {...props}
    />
  );
}

export function SearchInput({
  size,
  compact,
  onClear,
  clearLabel = "清空搜索",
  className,
  value,
  ...props
}: Omit<ComponentProps<"input">, "type" | "size"> & {
  size?: FormControlSize;
  compact?: boolean;
  onClear?: () => void;
  clearLabel?: string;
}) {
  const effectiveSize: FormControlSize =
    size ?? (compact === true ? "sm" : "md");
  const hasValue = typeof value === "string" && value.length > 0;
  return (
    <div
      className={cx(
        "ui-search-wrap",
        `ui-search-wrap--${effectiveSize}`,
        className,
      )}
    >
      <span className="ui-search-icon" aria-hidden="true">
        <Search size={effectiveSize === "sm" ? 13.5 : 14.5} />
      </span>
      <input
        type="text"
        spellCheck={false}
        autoComplete="off"
        value={value}
        className={cx(
          "ui-input",
          effectiveSize !== "lg" && `ui-input--${effectiveSize}`,
          hasValue && onClear && "ui-input--clearable",
        )}
        {...props}
      />
      {hasValue && onClear && (
        <button
          type="button"
          className="ui-search-clear"
          aria-label={clearLabel}
          onClick={onClear}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  id,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
}) {
  const fallbackId = useId();
  return (
    <button
      id={id ?? fallbackId}
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      className="ui-switch"
      onClick={() => onChange(!checked)}
    >
      <span className="ui-switch-thumb" aria-hidden="true" />
    </button>
  );
}

/** Accessible labeled native checkbox with custom optical checkmark box. */
export function Checkbox({
  checked,
  onChange,
  label,
  ariaLabel,
  disabled = false,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label
      className={cx(
        "ui-checkbox",
        disabled && "ui-checkbox--disabled",
        className,
      )}
    >
      <input
        type="checkbox"
        aria-label={ariaLabel}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="ui-checkbox-box" aria-hidden="true">
        {checked && <Check size={11.5} strokeWidth={2.6} />}
      </span>
      {label && <span className="ui-checkbox-label">{label}</span>}
    </label>
  );
}

/** Range slider paired with a tabular `<output>` value display. */
export function Slider({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  formatValue,
  disabled = false,
  id,
  onChange,
  className,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  formatValue?: (value: number) => string;
  disabled?: boolean;
  id?: string;
  onChange: (value: number) => void;
  className?: string;
}) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  return (
    <div className={cx("ui-slider", className)}>
      <input
        id={inputId}
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output htmlFor={inputId}>
        {formatValue ? formatValue(value) : value}
      </output>
    </div>
  );
}

/** Unified Well color swatch + `#RRGGBB` monospace hex input with optional validation alert. */
export function ColorField({
  label,
  pickerLabel,
  value,
  swatchColor,
  error,
  errorRole = "alert",
  disabled = false,
  onChange,
  onTextBlur,
  onTextKeyDown,
  className,
}: {
  label: string;
  pickerLabel?: string;
  value: string;
  swatchColor?: string;
  error?: string;
  errorRole?: "alert" | "status";
  disabled?: boolean;
  onChange: (value: string) => void;
  onTextBlur?: () => void;
  onTextKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  className?: string;
}) {
  const safeHex =
    swatchColor ?? (/^#[\da-f]{6}$/i.test(value) ? value : "#808080");
  return (
    <div className={cx("ui-color-field", className)}>
      <div className={cx("ui-color-well", error && "ui-color-well--invalid")}>
        <input
          type="color"
          aria-label={pickerLabel ?? `${label}取色器`}
          value={safeHex}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
        />
        <input
          type="text"
          aria-label={label}
          aria-invalid={!!error || undefined}
          spellCheck={false}
          maxLength={7}
          value={value}
          disabled={disabled}
          onBlur={onTextBlur}
          onKeyDown={onTextKeyDown}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      {error && (
        <small role={errorRole} className="ui-field-error">
          {error}
        </small>
      )}
    </div>
  );
}

export interface ChoiceOption<T extends string = string> {
  value: T;
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

/**
 * Accessible `role="radiogroup"` choice pills (`layout="inline"`) or stacked cards (`layout="stack"`),
 * replacing ad-hoc `.ssh-auth-options` and `.question-choices`.
 */
export function ChoiceGroup<T extends string = string>({
  label,
  value,
  options,
  onChange,
  layout = "inline",
  disabled = false,
  className,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<ChoiceOption<T>>;
  onChange: (value: T) => void;
  layout?: "inline" | "stack";
  disabled?: boolean;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={root}
      role="radiogroup"
      aria-label={label}
      className={cx(
        "ui-choice-group",
        layout === "stack"
          ? "ui-choice-group--stack"
          : "ui-choice-group--inline",
        className,
      )}
      onKeyDown={(event) => {
        if (
          !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
            event.key,
          )
        )
          return;
        const enabled = options.filter((o) => !o.disabled && !disabled);
        if (!enabled.length) return;
        event.preventDefault();
        const idx = Math.max(
          0,
          enabled.findIndex((o) => o.value === value),
        );
        const step =
          event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
        const next = enabled[(idx + step + enabled.length) % enabled.length];
        onChange(next.value);
        const buttons =
          root.current?.querySelectorAll<HTMLButtonElement>(
            'button[role="radio"]:not(:disabled)',
          ) ?? [];
        buttons[enabled.indexOf(next)]?.focus();
      }}
    >
      {options.map((option) => {
        const checked = option.value === value;
        const isDisabled = disabled || !!option.disabled;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={isDisabled}
            data-checked={checked ? "true" : undefined}
            className="ui-choice-item"
            onClick={() => {
              if (!checked && !isDisabled) onChange(option.value);
            }}
          >
            <span className="ui-choice-indicator" aria-hidden="true" />
            <span className="ui-choice-copy">
              <span className="ui-choice-label">
                {option.icon}
                {option.label}
              </span>
              {option.description && (
                <small className="ui-choice-description">
                  {option.description}
                </small>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
