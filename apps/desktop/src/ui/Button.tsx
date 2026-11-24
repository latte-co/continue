import { LoaderCircle } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

export type ButtonVariant =
  "primary" | "elevated" | "subtle" | "ghost" | "danger";
export type ControlSize = "lg" | "md" | "sm" | "xs";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function Button({
  variant = "subtle",
  size = "md",
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
  busy?: boolean;
  fullWidth?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const iconPx = size === "xs" ? 12.5 : size === "sm" ? 14 : 15;
  return (
    <button
      type={type}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
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
  active?: boolean;
  busy?: boolean;
  children: ReactNode;
}) {
  const iconPx = size === "xs" ? 13 : size === "sm" ? 15 : 16;
  return (
    <button
      type={type}
      aria-label={label}
      aria-busy={busy || undefined}
      title={title ?? label}
      disabled={disabled || busy}
      data-active={active ? "true" : undefined}
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
