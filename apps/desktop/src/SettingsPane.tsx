import { useLayoutEffect, useRef, type ReactNode } from "react";
import { ChevronLeft, X } from "lucide-react";
import { isHiddenOrInert } from "./Modal";
import { Button, IconButton, PageContainer } from "./ui";

export interface SettingsSubviewConfig {
  parentTitle: string;
  title: ReactNode;
  onBack: () => void;
  backDisabled?: boolean;
  status?: ReactNode;
  footer?: ReactNode;
}

/**
 * Shared right-pane structure for every Settings tab inside the Settings modal:
 * sticky header (or `< Parent / Edit Item` subview breadcrumb), scrollable content body,
 * and optional sticky subview action footer — eliminating modal-on-modal nesting.
 */
export function SettingsPane({
  title,
  description,
  actions,
  subview,
  onClose,
  closeDisabled = false,
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  subview?: SettingsSubviewConfig;
  onClose?: () => void;
  closeDisabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const pane = useRef<HTMLDivElement>(null);
  const inSubview = Boolean(subview);
  const wasSubview = useRef(inSubview);
  const lastTriggerLabel = useRef<string | null>(null);

  if (inSubview && !wasSubview.current) {
    const active = document.activeElement;
    lastTriggerLabel.current =
      active instanceof HTMLElement && pane.current?.contains(active)
        ? active.getAttribute("aria-label")
        : null;
  }

  useLayoutEffect(() => {
    const exitedSubview = wasSubview.current && !inSubview;
    wasSubview.current = inSubview;
    if (!exitedSubview) return;
    const root = pane.current;
    if (
      !root ||
      isHiddenOrInert(root) ||
      root.contains(document.activeElement)
    ) {
      return;
    }
    const label = lastTriggerLabel.current;
    const restored =
      (label
        ? Array.from(
            root.querySelectorAll<HTMLElement>("button:not(:disabled)"),
          ).find((el) => el.getAttribute("aria-label") === label)
        : undefined) ??
      root.querySelector<HTMLElement>(
        ".settings-pane-scroll button:not(:disabled), .settings-pane-actions button:not(:disabled)",
      ) ??
      root;
    restored.focus();
  }, [inSubview]);

  return (
    <div
      ref={pane}
      tabIndex={-1}
      className="settings-pane"
      onKeyDown={(event) => {
        if (
          subview &&
          event.key === "Escape" &&
          !event.defaultPrevented &&
          !event.nativeEvent.isComposing &&
          !subview.backDisabled
        ) {
          event.preventDefault();
          event.stopPropagation();
          subview.onBack();
        }
      }}
    >
      <header className="settings-pane-header">
        {subview ? (
          <div className="settings-pane-breadcrumb">
            <Button
              variant="ghost"
              size="sm"
              className="settings-subview-back"
              leading={<ChevronLeft size={15} />}
              disabled={subview.backDisabled}
              onClick={subview.onBack}
            >
              {subview.parentTitle}
            </Button>
            <span className="settings-breadcrumb-sep" aria-hidden="true">
              /
            </span>
            <h2 className="settings-pane-title">{subview.title}</h2>
          </div>
        ) : (
          <h2 className="settings-pane-title">{title}</h2>
        )}
        {(actions || onClose) && (
          <div className="settings-pane-actions">
            {!subview && actions}
            {onClose && (
              <IconButton
                label="关闭设置"
                size="sm"
                disabled={closeDisabled}
                onClick={onClose}
              >
                <X size={15.5} />
              </IconButton>
            )}
          </div>
        )}
      </header>

      <div className="settings-pane-scroll">
        <PageContainer
          className={["settings-panel-content", className ?? ""]
            .filter(Boolean)
            .join(" ")}
        >
          {!subview && description && (
            <p className="settings-pane-description">{description}</p>
          )}
          {children}
        </PageContainer>
      </div>

      {subview?.footer && (
        <footer className="settings-pane-footer">
          {subview.status && (
            <span className="ui-card-status">{subview.status}</span>
          )}
          <div className="ui-card-footer-actions">{subview.footer}</div>
        </footer>
      )}
    </div>
  );
}
