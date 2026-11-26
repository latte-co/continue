import type { ComponentProps, ReactNode } from "react";
import { ControlSizeContext } from "./context";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

/**
 * Matte borderless 2-axis list row used by Sidebar, Settings navigation, and SideChat history.
 * `indent="child"` aligns child text at 32px flush under parent folder titles without vertical rails.
 */
export function NavRow({
  selected = false,
  indent = "flat",
  icon,
  trailing,
  className,
  children,
  ...props
}: ComponentProps<"button"> & {
  selected?: boolean;
  indent?: "flat" | "child";
  icon?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      data-selected={selected ? "true" : undefined}
      className={cx(
        "ui-nav-row",
        indent === "child" && "ui-nav-row--child",
        className,
      )}
      {...props}
    >
      {icon && <span aria-hidden="true">{icon}</span>}
      <span className="ui-nav-row-label">{children}</span>
      {trailing && <span>{trailing}</span>}
    </button>
  );
}

/**
 * Compact 46-54px structured record row inside a `CardList` (Archived Chats, SSH Hosts,
 * Providers, Directory entries), replacing tall padded per-item boulder cards.
 */
export function ItemRow({
  icon,
  title,
  subtitle,
  badge,
  actions,
  truncate = true,
  className,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  truncate?: boolean;
}) {
  return (
    <div className={cx("ui-item-row", className)} {...props}>
      {icon && (
        <span className="ui-item-row-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <div className="ui-item-row-body">
        <div className="ui-item-row-heading">
          <span
            className={cx(
              "ui-item-row-title",
              truncate && "ui-item-row-title--truncate",
            )}
          >
            {title}
          </span>
          {badge}
        </div>
        {subtitle && <div className="ui-item-row-subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="ui-item-row-actions">{actions}</div>}
    </div>
  );
}

/**
 * Two-column preference row inside a `CardList`: label + optional description on the left,
 * size-matched control(s) (`Select`, `Switch`, `Slider`, `ColorField`, `Segmented`) on the right.
 */
export function SettingRow({
  label,
  htmlFor,
  description,
  className,
  children,
  ...props
}: ComponentProps<"div"> & {
  label: ReactNode;
  htmlFor?: string;
  description?: ReactNode;
}) {
  return (
    <div className={cx("ui-setting-row", className)} {...props}>
      <div className="ui-setting-row-copy">
        {htmlFor ? (
          <label className="ui-setting-row-label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <div className="ui-setting-row-label">{label}</div>
        )}
        {description && (
          <div className="ui-setting-row-description">{description}</div>
        )}
      </div>
      <div className="ui-setting-row-control">
        <ControlSizeContext.Provider value="md">
          {children}
        </ControlSizeContext.Provider>
      </div>
    </div>
  );
}
