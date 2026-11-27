import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, CircleAlert } from "lucide-react";
import { renderAnsiText, stripAnsi } from "./ansi";
import { Button } from "./ui";
import { parseTurnError } from "./turnError";

export interface TurnErrorRecoveryAction {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}

export function TurnErrorRow({
  message,
  action,
}: {
  message: string;
  action?: TurnErrorRecoveryAction;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  const cleanMessage = useMemo(() => stripAnsi(message), [message]);
  const parsed = useMemo(() => parseTurnError(cleanMessage), [cleanMessage]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  async function copyRaw() {
    try {
      await navigator.clipboard?.writeText(cleanMessage);
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        setCopied(false);
        timerRef.current = null;
      }, 1600);
    } catch {
      // Ignore clipboard permission errors in restricted webviews.
    }
  }

  return (
    <div className="turn-error-entry" data-open={open || undefined}>
      <div className="turn-error-bar">
        <button
          type="button"
          className="turn-error-toggle"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
        >
          <CircleAlert
            size={14}
            className={`activity-icon activity-icon--${parsed.tone}`}
            aria-hidden="true"
          />
          <span className="turn-error-title">{parsed.title}</span>
          {parsed.detail && (
            <span className="turn-error-detail">· {parsed.detail}</span>
          )}
          <ChevronRight
            size={13}
            className="activity-chevron"
            aria-hidden="true"
          />
        </button>
        {action && (
          <Button
            size="xs"
            variant="subtle"
            className="turn-error-action"
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {action.label}
          </Button>
        )}
      </div>
      {open && (
        <div className="activity-output">
          <div className="activity-well turn-error-well">
            <pre>{renderAnsiText(message)}</pre>
            <Button
              size="xs"
              variant="ghost"
              className="turn-error-copy"
              onClick={() => void copyRaw()}
            >
              {copied ? "已复制" : "复制"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
