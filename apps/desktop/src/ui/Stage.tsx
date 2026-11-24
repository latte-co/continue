import type { ComponentProps, ReactNode } from "react";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

/**
 * Single clipped 12px stage container (`overflow: clip; isolation: isolate`)
 * that houses the main pane and optional right workspace separated by a 1px hairline.
 */
export function StageIsland({
  fullInset = false,
  className,
  children,
  ...props
}: ComponentProps<"div"> & { fullInset?: boolean }) {
  return (
    <div
      className={cx("ui-stage-island", className)}
      data-full-inset={fullInset ? "true" : undefined}
      {...props}
    >
      {children}
    </div>
  );
}

/** Primary 44px topbar aligned to native macOS traffic lights. */
export function Topbar({
  leading,
  trailing,
  className,
  children,
  ...props
}: ComponentProps<"header"> & {
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <header
      className={cx("ui-topbar", className)}
      data-tauri-drag-region="deep"
      {...props}
    >
      {children ?? (
        <>
          <div className="ui-topbar-side">{leading}</div>
          {trailing && <div className="ui-topbar-side">{trailing}</div>}
        </>
      )}
    </header>
  );
}

/** Secondary 38px workspace sub-toolbar (Diff scope/options, File path/mode, Browser bar). */
export function Subbar({ className, ...props }: ComponentProps<"div">) {
  return <div className={cx("ui-subbar", className)} {...props} />;
}

/** Orthogonal 1px internal resize divider inside a StageIsland. */
export function SplitHandle({
  label,
  className,
  ...props
}: ComponentProps<"div"> & { label: string }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      className={cx("ui-split-handle", className)}
      {...props}
    />
  );
}
