import { ChevronRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

/** Tier-2 10px optical surface card (`1px` perimeter ring + top bevel + soft lift). */
export function Card({
  padded = false,
  className,
  ...props
}: ComponentProps<"section"> & {
  padded?: boolean;
}) {
  return (
    <section
      className={cx("ui-card", padded && "ui-card--padded", className)}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  description,
  actions,
  className,
  children,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={cx("ui-card-header", className)} {...props}>
      {children ?? (
        <>
          <div className="ui-card-header-copy">
            {title && <div className="ui-card-title">{title}</div>}
            {description && (
              <div className="ui-card-description">{description}</div>
            )}
          </div>
          {actions && <div className="ui-card-actions">{actions}</div>}
        </>
      )}
    </div>
  );
}

/** Footer bar inside an editable Card: dirty/saved status on the left, CTA buttons on the right. */
export function CardFooter({
  status,
  className,
  children,
  ...props
}: ComponentProps<"div"> & {
  status?: ReactNode;
}) {
  return (
    <div className={cx("ui-card-footer", className)} {...props}>
      {status !== undefined && (
        <span className="ui-card-status" role="status">
          {status}
        </span>
      )}
      <div className="ui-card-footer-actions">{children}</div>
    </div>
  );
}

/**
 * Grouped 10px Card list whose child ItemRow / SettingRow elements are separated
 * by crisp 1px `--color-border-subtle` hairlines instead of bloated per-item cards.
 */
export function CardList({
  label,
  className,
  ...props
}: ComponentProps<"div"> & {
  label?: string;
}) {
  return (
    <div
      role={label ? "list" : undefined}
      aria-label={label}
      className={cx("ui-card", "ui-card-list", className)}
      {...props}
    />
  );
}

/** Standardized progressive disclosure (`<details>`) with rotating chevron and clean body spacing. */
export function Disclosure({
  title,
  meta,
  className,
  children,
  ...props
}: Omit<ComponentProps<"details">, "title"> & {
  title: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <details className={cx("ui-disclosure", className)} {...props}>
      <summary className="ui-disclosure-summary">
        <ChevronRight
          size={13.5}
          className="ui-disclosure-chevron"
          aria-hidden="true"
        />
        <span className="ui-disclosure-title">{title}</span>
        {meta && <span className="ui-disclosure-meta">{meta}</span>}
      </summary>
      <div className="ui-disclosure-body">{children}</div>
    </details>
  );
}

/** Tier-1 8px recessed slot (`Well`). */
export function Well({ className, ...props }: ComponentProps<"div">) {
  return <div className={cx("ui-well", className)} {...props} />;
}

/** Frosted 28px floating capsule (Return to Latest, Turn Changes summary). */
export function FloatingPill({
  type = "button",
  className,
  ...props
}: ComponentProps<"button">) {
  return (
    <button
      type={type}
      className={cx("ui-floating-pill", className)}
      {...props}
    />
  );
}
