import type { ComponentProps } from "react";

/**
 * 10px framed compact data table (`Well` ring + muted header + `1px` hairline row dividers + tabular numerals).
 */
export function DataTable({
  caption,
  className,
  children,
  ...props
}: ComponentProps<"table"> & {
  caption?: string;
}) {
  return (
    <div className="ui-table-wrap">
      <table
        className={["ui-table", className ?? ""].filter(Boolean).join(" ")}
        {...props}
      >
        {caption && <caption className="ui-sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}
