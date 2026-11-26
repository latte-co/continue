import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Modal } from "../Modal";
import { IconButton } from "./Button";

/** Viewport-clamped 10px frosted popover or action menu anchored to a trigger or point. */
export function Popover({
  id,
  open,
  anchorRef,
  anchorPoint,
  onClose,
  align = "start",
  minWidth = 180,
  role = "dialog",
  label,
  autoFocusMenu,
  restoreFocusOnEscape = true,
  className,
  onBlur,
  onKeyDown,
  onKeyDownCapture,
  onContextMenu,
  children,
}: {
  id?: string;
  open: boolean;
  anchorRef?: RefObject<HTMLElement | null>;
  anchorPoint?: { x: number; y: number };
  onClose: (restoreFocus?: boolean) => void;
  align?: "start" | "end";
  minWidth?: number;
  role?: "dialog" | "menu";
  label: string;
  autoFocusMenu?: boolean;
  restoreFocusOnEscape?: boolean;
  className?: string;
  onBlur?: ComponentProps<"div">["onBlur"];
  onKeyDown?: ComponentProps<"div">["onKeyDown"];
  onKeyDownCapture?: ComponentProps<"div">["onKeyDownCapture"];
  onContextMenu?: ComponentProps<"div">["onContextMenu"];
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const shouldManageMenuFocus = autoFocusMenu ?? role === "menu";
  const [coords, setCoords] = useState({
    left: 12,
    top: 12,
    minWidth,
    maxHeight: 320,
  });

  useLayoutEffect(() => {
    if (!open) return;
    const anchorEl = anchorRef?.current ?? null;
    if (!anchorEl && !anchorPoint) return;
    const rect = anchorPoint
      ? {
          left: anchorPoint.x,
          right: anchorPoint.x,
          top: anchorPoint.y,
          bottom: anchorPoint.y,
          width: 0,
          height: 0,
        }
      : anchorEl!.getBoundingClientRect();
    const panelRect = panel.current?.getBoundingClientRect();
    const measuredWidth = panelRect?.width || panel.current?.offsetWidth || 0;
    const width = Math.min(
      Math.max(rect.width, minWidth, measuredWidth),
      window.innerWidth - 16,
    );
    const left = Math.min(
      Math.max(8, align === "end" ? rect.right - width : rect.left),
      Math.max(8, window.innerWidth - width - 8),
    );
    const below = window.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const placeBelow = below >= 200 || below >= above;
    const maxHeight = Math.max(96, Math.min(360, placeBelow ? below : above));
    const measuredHeight = Math.min(
      panelRect?.height || panel.current?.scrollHeight || maxHeight,
      maxHeight,
    );
    const gap = anchorPoint ? 0 : 6;
    const top = placeBelow
      ? Math.min(
          rect.bottom + gap,
          Math.max(8, window.innerHeight - measuredHeight - 8),
        )
      : Math.max(8, rect.top - measuredHeight - gap);
    setCoords({ left, top, minWidth: Math.min(minWidth, width), maxHeight });

    if (shouldManageMenuFocus) {
      const firstItem = panel.current?.querySelector<HTMLButtonElement>(
        "button:not(:disabled)",
      );
      (firstItem ?? panel.current)?.focus();
    }
  }, [
    open,
    anchorRef,
    anchorPoint?.x,
    anchorPoint?.y,
    align,
    minWidth,
    shouldManageMenuFocus,
  ]);

  useEffect(() => {
    if (!open) return;
    const isInert = () => {
      for (
        let cur: HTMLElement | null = panel.current;
        cur;
        cur = cur.parentElement
      ) {
        if (cur.inert || cur.hasAttribute("inert")) return true;
      }
      return false;
    };
    const onPointer = (event: PointerEvent) => {
      if (isInert()) return;
      const target = event.target as Node | null;
      if (
        target &&
        !panel.current?.contains(target) &&
        !anchorRef?.current?.contains(target)
      ) {
        onClose(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || isInert()) return;
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose(true);
        if (restoreFocusOnEscape) anchorRef?.current?.focus();
        return;
      }
      if (!shouldManageMenuFocus) return;
      if (event.key === "Tab") {
        onClose(false);
        return;
      }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        const items = Array.from(
          panel.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) ?? [],
        );
        if (!items.length) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const current = items.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const nextIndex =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : current < 0
                ? event.key === "ArrowUp"
                  ? items.length - 1
                  : 0
                : (current +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    items.length) %
                  items.length;
        items[nextIndex]?.focus();
      }
    };
    const onResize = () => onClose(false);
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, anchorRef, onClose, restoreFocusOnEscape, shouldManageMenuFocus]);

  if (!open) return null;
  const host =
    anchorRef?.current?.closest<HTMLElement>('[role="dialog"]') ??
    document.body;
  return createPortal(
    <div
      id={id}
      ref={panel}
      role={role}
      aria-label={label}
      tabIndex={-1}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      onKeyDownCapture={onKeyDownCapture}
      onContextMenu={onContextMenu}
      className={["ui-popover", className ?? ""].filter(Boolean).join(" ")}
      style={{
        left: coords.left,
        top: coords.top,
        minWidth: coords.minWidth,
        maxHeight: coords.maxHeight,
      }}
    >
      {children}
    </div>,
    host,
  );
}

/** Muted section heading inside a Popover menu. */
export function MenuTitle({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      role="presentation"
      className={["ui-menu-title", className ?? ""].filter(Boolean).join(" ")}
      {...props}
    />
  );
}

export function MenuRow({
  danger = false,
  active = false,
  leading,
  trailing,
  className,
  onPointerMove,
  children,
  ...props
}: ComponentProps<"button"> & {
  danger?: boolean;
  active?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      data-active={active ? "true" : undefined}
      className={[
        "ui-menu-row",
        danger ? "ui-menu-row--danger" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      onPointerMove={(event) => {
        onPointerMove?.(event);
        if (
          !event.defaultPrevented &&
          !event.currentTarget.disabled &&
          document.activeElement !== event.currentTarget &&
          event.currentTarget.closest('[role="menu"]')
        ) {
          event.currentTarget.focus({ preventScroll: true });
        }
      }}
      {...props}
    >
      <span className="ui-menu-row-main">
        {leading}
        <span>{children}</span>
      </span>
      {trailing && <span className="ui-menu-row-trailing">{trailing}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="ui-menu-sep" />;
}

const DIALOG_SIZES = {
  sm: 380,
  md: 480,
  lg: 600,
} as const;

/**
 * Standardized 14px modal dialog frame built atop Modal's nested inert stack.
 */
export function Dialog({
  open,
  title,
  description,
  ariaLabel,
  ariaDescribedBy,
  closeLabel = "关闭",
  hideCloseButton = false,
  headerLeading,
  headerActions,
  onClose,
  onKeyDown,
  busy = false,
  footer,
  size = "md",
  width,
  backdropClassName,
  className,
  children,
}: {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  closeLabel?: string;
  hideCloseButton?: boolean;
  headerLeading?: ReactNode;
  headerActions?: ReactNode;
  onClose: () => void;
  onKeyDown?: ComponentProps<"section">["onKeyDown"];
  busy?: boolean;
  footer?: ReactNode;
  size?: keyof typeof DIALOG_SIZES;
  width?: number;
  backdropClassName?: string;
  className?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  const descriptionId = useId();
  if (!open) return null;
  const targetWidth = width ?? DIALOG_SIZES[size];
  const describedBy =
    [description ? descriptionId : "", ariaDescribedBy ?? ""]
      .filter(Boolean)
      .join(" ") || undefined;
  return createPortal(
    <div
      className={["ui-dialog-backdrop", backdropClassName ?? ""]
        .filter(Boolean)
        .join(" ")}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented && !busy) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <Modal
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : headingId}
        aria-describedby={describedBy}
        onKeyDown={onKeyDown}
        className={["ui-dialog", className ?? ""].filter(Boolean).join(" ")}
        style={{ width: `min(${targetWidth}px, 100%)` }}
      >
        <div className="ui-dialog-header">
          <div className="ui-dialog-header-main">
            {headerLeading}
            <div className="ui-dialog-header-copy">
              <h2 id={headingId} className="ui-dialog-title">
                {title}
              </h2>
              {description && (
                <p id={descriptionId} className="ui-dialog-description">
                  {description}
                </p>
              )}
            </div>
          </div>
          {(headerActions || !hideCloseButton) && (
            <div className="ui-dialog-header-actions">
              {headerActions}
              {!hideCloseButton && (
                <IconButton
                  label={closeLabel}
                  size="sm"
                  disabled={busy}
                  onClick={onClose}
                >
                  <X size={15} />
                </IconButton>
              )}
            </div>
          )}
        </div>
        <div className="ui-dialog-body">{children}</div>
        {footer && <div className="ui-dialog-footer">{footer}</div>}
      </Modal>
    </div>,
    document.body,
  );
}
