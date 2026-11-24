import { useRef, type ReactNode } from "react";

export interface SegmentedOption<T extends string = string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export function Segmented<T extends string = string>({
  label,
  value,
  options,
  onChange,
  size = "sm",
  roleType = "radiogroup",
  className,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  roleType?: "radiogroup" | "group";
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={root}
      role={roleType}
      aria-label={label}
      className={[
        "ui-segmented",
        size === "md" ? "ui-segmented--md" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        const enabled = options.filter((o) => !o.disabled);
        if (!enabled.length) return;
        event.preventDefault();
        const idx = Math.max(
          0,
          enabled.findIndex((o) => o.value === value),
        );
        const next =
          enabled[
            (idx + (event.key === "ArrowRight" ? 1 : -1) + enabled.length) %
              enabled.length
          ];
        onChange(next.value);
        const buttons =
          root.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
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
            role={roleType === "radiogroup" ? "radio" : undefined}
            aria-checked={roleType === "radiogroup" ? active : undefined}
            aria-pressed={roleType === "group" ? active : undefined}
            disabled={option.disabled}
            data-active={active ? "true" : undefined}
            className="ui-segmented-item"
            onClick={() => {
              if (!active) onChange(option.value);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
