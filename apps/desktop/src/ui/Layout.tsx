import type { ComponentProps, ReactNode } from "react";
import { ControlSizeContext } from "./context";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

/**
 * Standardized scrollable/centered page container for Settings & Management views.
 * `size="narrow"` (680px) fits forms and grouped record lists; `size="wide"` (960px) fits multi-column grids.
 */
export function PageContainer({
  size = "narrow",
  className,
  ...props
}: ComponentProps<"div"> & {
  size?: "narrow" | "wide";
}) {
  return (
    <div
      className={cx("ui-page", size === "wide" && "ui-page--wide", className)}
      {...props}
    />
  );
}

/** Unified page heading with optional subtitle description and right-aligned primary actions. */
export function PageHeader({
  title,
  description,
  actions,
  className,
  ...props
}: Omit<ComponentProps<"header">, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className={cx("ui-page-header", className)} {...props}>
      <div className="ui-page-header-copy">
        <h2 className="ui-page-title">{title}</h2>
        {description && <p className="ui-page-description">{description}</p>}
      </div>
      {actions && <div className="ui-page-actions">{actions}</div>}
    </header>
  );
}

/** Vertical section grouping a SectionHeader with a Card, CardList, or Grid. */
export function Section({ className, ...props }: ComponentProps<"section">) {
  return <section className={cx("ui-section", className)} {...props} />;
}

/**
 * Calm section header (`[icon] Title  meta ··· count / actions`),
 * e.g. `[Folder] Evaluation  Devbox ··· 3 个聊天`.
 */
export function SectionHeader({
  icon,
  title,
  meta,
  count,
  actions,
  className,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  icon?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  count?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={cx("ui-section-header", className)} {...props}>
      <h3 className="ui-section-title">
        {icon && (
          <span className="ui-section-icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <span>{title}</span>
        {meta && <small className="ui-section-meta">{meta}</small>}
      </h3>
      {(count !== undefined || actions) && (
        <div className="ui-section-trailing">
          {count !== undefined && (
            <span className="ui-section-count">{count}</span>
          )}
          {actions}
        </div>
      )}
    </div>
  );
}

/**
 * Horizontal filter/search bar that locks child SearchInput, Select, Segmented,
 * and Button controls to identical height and 8px corner geometry.
 */
export function FilterBar({
  className,
  children,
  ...props
}: ComponentProps<"div">) {
  return (
    <ControlSizeContext.Provider value="md">
      <div className={cx("ui-filter-bar", className)} {...props}>
        {children}
      </div>
    </ControlSizeContext.Provider>
  );
}
