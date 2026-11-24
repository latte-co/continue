import { useRef, type ReactNode } from "react";

export interface TabOption<T extends string = string> {
  value: T;
  label: ReactNode;
  count?: number;
  disabled?: boolean;
}

/**
 * Accessible category tab strip (`role="tablist"`) with roving ArrowLeft/ArrowRight/Home/End
 * focus and optional tabular item counts.
 */
export function Tabs<T extends string = string>({
  label,
  value,
  options,
  onChange,
  variant = "pill",
  idPrefix,
  panelId,
  className,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<TabOption<T>>;
  onChange: (value: T) => void;
  variant?: "pill" | "underline";
  idPrefix?: string;
  panelId?: string;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={root}
      role="tablist"
      aria-label={label}
      className={[
        "ui-tabs",
        variant === "underline" ? "ui-tabs--underline" : "ui-tabs--pill",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        const enabled = options.filter((o) => !o.disabled);
        if (!enabled.length) return;
        event.preventDefault();
        const idx = Math.max(
          0,
          enabled.findIndex((o) => o.value === value),
        );
        const next =
          event.key === "Home"
            ? enabled[0]
            : event.key === "End"
              ? enabled[enabled.length - 1]
              : enabled[
                  (idx +
                    (event.key === "ArrowRight" ? 1 : -1) +
                    enabled.length) %
                    enabled.length
                ];
        onChange(next.value);
        const buttons =
          root.current?.querySelectorAll<HTMLButtonElement>(
            'button[role="tab"]:not(:disabled)',
          ) ?? [];
        buttons[enabled.indexOf(next)]?.focus();
      }}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            id={idPrefix ? `${idPrefix}${option.value}` : undefined}
            aria-controls={panelId}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            disabled={option.disabled}
            data-active={active ? "true" : undefined}
            className="ui-tab-item"
            onClick={() => {
              if (!active) onChange(option.value);
            }}
          >
            <span>{option.label}</span>
            {option.count !== undefined && (
              <small className="ui-tab-count">{option.count}</small>
            )}
          </button>
        );
      })}
    </div>
  );
}
