import { LoaderCircle } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

export type ButtonVariant =
  "primary" | "elevated" | "subtle" | "ghost" | "danger";
export type ControlSize = "lg" | "md" | "sm" | "xs";
export type ButtonIntent = "default" | "danger";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function Button({
  variant = "subtle",
  size = "md",
  intent = "default",
  busy = false,
  fullWidth = false,
  leading,
  trailing,
  disabled,
  type = "button",
  className,
  children,
  ...props
}: ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: ControlSize;
  intent?: ButtonIntent;
  busy?: boolean;
  fullWidth?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const iconPx = size === "xs" ? 12 : size === "sm" ? 13.5 : 14.5;
  const hasLeading = Boolean(busy || leading);
  const hasTrailing = Boolean(trailing);
  return (
    <button
      type={type}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      data-intent={intent !== "default" ? intent : undefined}
      data-has-leading={hasLeading ? "true" : undefined}
      data-has-trailing={hasTrailing ? "true" : undefined}
      className={cx(
        "ui-btn",
        `ui-btn--${variant}`,
        `ui-btn--${size}`,
        fullWidth && "ui-btn--full",
        className,
      )}
      {...props}
    >
      {busy ? (
        <LoaderCircle size={iconPx} className="spin" aria-hidden="true" />
      ) : (
        leading
      )}
      {children}
      {trailing}
    </button>
  );
}

export function IconButton({
  label,
  variant = "ghost",
  size = "sm",
  intent = "default",
  active = false,
  busy = false,
  disabled,
  type = "button",
  className,
  title,
  children,
  ...props
}: Omit<ComponentProps<"button">, "aria-label"> & {
  label: string;
  variant?: Exclude<ButtonVariant, "primary">;
  size?: ControlSize;
  intent?: ButtonIntent;
  active?: boolean;
  busy?: boolean;
  children: ReactNode;
}) {
  const iconPx = size === "xs" ? 13 : size === "sm" ? 14.5 : 15.5;
  return (
    <button
      type={type}
      aria-label={label}
      aria-busy={busy || undefined}
      title={title ?? label}
      disabled={disabled || busy}
      data-active={active ? "true" : undefined}
      data-intent={intent !== "default" ? intent : undefined}
      className={cx(
        "ui-icon-btn",
        `ui-icon-btn--${variant}`,
        `ui-icon-btn--${size}`,
        className,
      )}
      {...props}
    >
      {busy ? (
        <LoaderCircle size={iconPx} className="spin" aria-hidden="true" />
      ) : (
        children
      )}
    </button>
  );
}
