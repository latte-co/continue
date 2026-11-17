import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { MessageSquare, Pencil, Trash2, X } from "lucide-react";
import { Modal } from "./Modal";
import { MessageContent } from "./MessageContent";
import {
  annotationRange,
  selectedAnnotation,
  MAX_COMMENT,
  MAX_QUOTE,
  type Annotation,
} from "./annotations";
import "./annotations.css";

type Change = (entry: Annotation) => string | null;
type Rect = Pick<DOMRect, "left" | "right" | "top" | "bottom">;

/** Shared modal focus contract with a compact, viewport-bounded anchored surface. */
function AnnotationPopover({
  anchor,
  label,
  close,
  children,
}: {
  anchor: Rect;
  label: string;
  close: () => void;
  children: ReactNode;
}) {
  const content = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8, width: 400 });
  useLayoutEffect(() => {
    const place = () => {
      const width = Math.max(0, Math.min(440, window.innerWidth - 16));
      const height = Math.min(
        content.current?.offsetHeight ?? 260,
        window.innerHeight - 24,
      );
      setPosition({
        width,
        left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
        top: Math.max(
          8,
          Math.min(
            anchor.top >= height + 20
              ? anchor.top - height - 12
              : anchor.bottom + 12,
            window.innerHeight - height - 8,
          ),
        ),
      });
    };
    place();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(place);
    if (content.current) observer?.observe(content.current);
    window.addEventListener("resize", place);
    const stopBackgroundScroll = (event: WheelEvent) => {
      if (
        event.target instanceof Node &&
        !content.current?.contains(event.target)
      )
        event.preventDefault();
    };
    popover.current?.addEventListener("wheel", stopBackgroundScroll, {
      passive: false,
    });
    const backdrop = popover.current;
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      backdrop?.removeEventListener("wheel", stopBackgroundScroll);
    };
  }, [anchor]);
  return createPortal(
    <div
      className="annotation-backdrop"
      ref={popover}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <Modal
        className="annotation-popover"
        aria-label={label}
        style={position}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      >
        <div ref={content}>{children}</div>
      </Modal>
    </div>,
    document.body,
  );
}

export function AnnotationEditor({
  entry,
  anchor,
  onSave,
  onRemove,
  close,
}: {
  entry: Annotation;
  anchor: Rect;
  onSave: Change;
  onRemove?: () => void;
  close: () => void;
}) {
  const [comment, setComment] = useState(entry.comment);
  const [error, setError] = useState("");
  const composing = useRef(false);
  function save() {
    if (!comment.trim()) return;
    const error = onSave({ ...entry, comment: comment.trim() });
    if (error) setError(error);
    else close();
  }
  return (
    <AnnotationPopover
      anchor={anchor}
      label={entry.comment ? "编辑注释" : "添加注释"}
      close={close}
    >
      <div className="annotation-editor">
        <label htmlFor={`annotation-${entry.id}`}>用户评论</label>
        <textarea
          id={`annotation-${entry.id}`}
          autoFocus
          rows={3}
          maxLength={MAX_COMMENT}
          placeholder="针对这段文字，写下你的问题或修改建议…"
          value={comment}
          onChange={(e) => {
            setComment(e.target.value);
            setError("");
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              (e.metaKey || e.ctrlKey) &&
              !e.nativeEvent.isComposing &&
              !composing.current &&
              e.keyCode !== 229
            ) {
              e.preventDefault();
              save();
            }
          }}
        />
        <blockquote>{entry.quote}</blockquote>
        {error && (
          <p role="alert" className="annotation-error">
            {error}
          </p>
        )}
        <footer>
          {onRemove && (
            <button
              className="icon-button"
              aria-label="删除注释"
              onClick={() => {
                onRemove();
                close();
              }}
            >
              <Trash2 size={16} />
            </button>
          )}
          <span className="annotation-limit">
            {comment.length}/{MAX_COMMENT}
          </span>
          <button className="secondary small" onClick={close}>
            取消
          </button>
          <button
            className="primary small"
            disabled={!comment.trim()}
            title="⌘/Ctrl + Enter 保存"
            onClick={save}
          >
            保存
          </button>
        </footer>
      </div>
    </AnnotationPopover>
  );
}

export function AnnotationSummary({
  entries,
  onSave,
  onRemove,
  onClear,
  disabled = false,
  active = true,
}: {
  entries: Annotation[];
  onSave?: Change;
  onRemove?: (id: string) => void;
  onClear?: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<Rect | null>(null);
  const [editing, setEditing] = useState<Annotation | null>(null);
  useEffect(() => {
    if (!active || disabled || !entries.length) {
      setAnchor(null);
      setEditing(null);
    }
  }, [active, disabled, entries.length]);
  const close = () => {
    setAnchor(null);
    setEditing(null);
    queueMicrotask(() => {
      if (trigger.current?.isConnected && !trigger.current.closest("[inert]"))
        trigger.current.focus();
    });
  };
  if (!entries.length) return null;
  return (
    <div className="annotation-summary">
      <div className="annotation-chip">
        <button
          ref={trigger}
          aria-expanded={!!anchor}
          aria-haspopup="dialog"
          disabled={disabled}
          onClick={() => {
            trigger.current?.focus();
            setAnchor(trigger.current!.getBoundingClientRect());
          }}
        >
          <MessageSquare size={15} />
          {entries.length} 条注释
        </button>
        {onClear && (
          <button
            disabled={disabled}
            className="annotation-clear"
            aria-label="移除全部注释"
            onClick={onClear}
          >
            <X size={14} />
          </button>
        )}
      </div>
      {anchor &&
        active &&
        (editing && onSave ? (
          <AnnotationEditor
            key={editing.id}
            entry={editing}
            anchor={anchor}
            onSave={onSave}
            onRemove={onRemove ? () => onRemove(editing.id) : undefined}
            close={close}
          />
        ) : (
          <AnnotationPopover anchor={anchor} label="消息注释" close={close}>
            <div className="annotation-list-heading">
              <span>{entries.length} 条注释</span>
              <button
                className="icon-button"
                aria-label="关闭注释"
                onClick={close}
              >
                <X size={16} />
              </button>
            </div>
            <ol className="annotation-list">
              {entries.map((entry, index) => (
                <li key={entry.id}>
                  <span className="annotation-index">{index + 1}.</span>
                  <div className="annotation-copy">
                    <span>所选文本</span>
                    <blockquote>{entry.quote}</blockquote>
                    <span>用户评论</span>
                    <p>{entry.comment}</p>
                  </div>
                  {(onSave || onRemove) && (
                    <div className="annotation-entry-actions">
                      {onSave && (
                        <button
                          className="icon-button"
                          aria-label={`编辑注释 ${index + 1}`}
                          disabled={disabled}
                          onClick={() => setEditing(entry)}
                        >
                          <Pencil size={15} />
                        </button>
                      )}
                      {onRemove && (
                        <button
                          className="icon-button"
                          aria-label={`删除注释 ${index + 1}`}
                          disabled={disabled}
                          onClick={() => onRemove(entry.id)}
                        >
                          <Trash2 size={15} />
                        </button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </AnnotationPopover>
        ))}
    </div>
  );
}

export function AnnotatedMessage({
  text,
  message,
  entries,
  enabled,
  onSave,
  onRemove,
  askInSideChat,
}: {
  text: string;
  message: number;
  entries: Annotation[];
  enabled: boolean;
  onSave: Change;
  onRemove: (id: string) => void;
  askInSideChat?: (quote: string) => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const releaseClick = useRef<Element | null>(null);
  const gesture = useRef<{ x: number; y: number; range: Range | null } | null>(
    null,
  );
  function clearSelection() {
    const selected = window.getSelection();
    if (
      body.current?.contains(selected?.anchorNode ?? null) &&
      body.current?.contains(selected?.focusNode ?? null)
    )
      selected?.removeAllRanges();
  }
  const [selection, setSelection] = useState<{
    entry: Annotation;
    anchor: Rect;
  } | null>(null);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState("");
  const [marks, setMarks] = useState<
    {
      entry: Annotation;
      number: number;
      markerTop: number;
      rects: { left: number; top: number; width: number; height: number }[];
    }[]
  >([]);
  const close = () => {
    setSelection(null);
    setEditing(false);
    releaseClick.current = null;
    clearSelection();
    queueMicrotask(() => {
      if (
        document.activeElement === document.body &&
        body.current?.isConnected &&
        !body.current.closest("[inert]")
      )
        body.current.focus({ preventScroll: true });
    });
  };
  useEffect(() => {
    if (!enabled) {
      releaseClick.current = null;
      gesture.current = null;
      setSelection(null);
      setEditing(false);
      setNotice("");
    }
  }, [enabled]);
  useEffect(() => {
    if (!selection || editing) return;
    const dismiss = () => setSelection(null);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    const outside = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(".annotation-selection-menu")
      )
        dismiss();
    };
    const changed = () => {
      const selected = body.current
        ? selectedAnnotation(body.current, message)
        : null;
      if (
        !selected ||
        selected.source.start !== selection.entry.source.start ||
        selected.source.end !== selection.entry.source.end
      )
        dismiss();
    };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    document.addEventListener("keydown", key);
    document.addEventListener("selectionchange", changed);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      document.removeEventListener("keydown", key);
      document.removeEventListener("selectionchange", changed);
      document.removeEventListener("pointerdown", outside);
    };
  }, [selection, editing, message]);
  useLayoutEffect(() => {
    const root = body.current;
    if (!root) return;
    if (!entries.some((entry) => entry.source.message === message)) {
      setMarks([]);
      return;
    }
    const measure = () => {
      const origin = root.getBoundingClientRect();
      const occupied: number[] = [];
      setMarks(
        entries.flatMap((entry, index) => {
          if (entry.source.message !== message) return [];
          const range = annotationRange(root, entry);
          if (!range || typeof range.getClientRects !== "function") return [];
          const rects = Array.from(range.getClientRects())
            .filter((r) => r.width && r.height)
            .slice(0, 500)
            .map((r) => ({
              left: Math.max(0, r.left - origin.left),
              top: r.top - origin.top,
              width: Math.max(
                0,
                Math.min(r.right, origin.right) - Math.max(r.left, origin.left),
              ),
              height: r.height,
            }))
            .filter((r) => r.width > 0);
          if (!rects.length) return [];
          let markerTop = rects[0].top;
          while (occupied.some((top) => Math.abs(top - markerTop) < 32))
            markerTop += 32;
          occupied.push(markerTop);
          return [{ entry, number: index + 1, rects, markerTop }];
        }),
      );
    };
    measure();
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(schedule);
    observer?.observe(root);
    root.addEventListener("scroll", schedule, true);
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      root.removeEventListener("scroll", schedule, true);
    };
  }, [entries, message, text]);
  function select(event?: React.MouseEvent<HTMLDivElement>) {
    const started = gesture.current;
    gesture.current = null;
    releaseClick.current = null;
    if (!enabled || editing || !body.current) return;
    const entry = selectedAnnotation(body.current, message);
    if (!entry) {
      setSelection(null);
      const selected = window.getSelection();
      setNotice(
        selected &&
          body.current.contains(selected.anchorNode) &&
          selected.toString().length > MAX_QUOTE
          ? `每条注释最多引用 ${MAX_QUOTE} 字，请缩小选区。`
          : "",
      );
      return;
    }
    setNotice("");
    const range = annotationRange(body.current, entry);
    if (range) {
      const current = window.getSelection()?.getRangeAt(0);
      const previous = started?.range;
      const changed =
        current &&
        (!previous ||
          current.startContainer !== previous.startContainer ||
          current.startOffset !== previous.startOffset ||
          current.endContainer !== previous.endContainer ||
          current.endOffset !== previous.endOffset);
      const moved =
        event &&
        started &&
        Math.hypot(event.clientX - started.x, event.clientY - started.y) > 3;
      const control =
        event?.target instanceof Element
          ? event.target.closest("a, button")
          : null;
      if (
        started &&
        (changed || moved) &&
        control &&
        body.current.contains(control) &&
        range.intersectsNode(control)
      )
        releaseClick.current = control;
      setSelection({ entry, anchor: range.getBoundingClientRect() });
    }
  }
  return (
    <article
      className="assistant-message annotated-message"
      data-annotations={
        enabled && entries.some((entry) => entry.source.message === message)
      }
    >
      <div
        className="markdown annotation-body"
        tabIndex={-1}
        ref={body}
        onPointerDownCapture={() => {
          releaseClick.current = null;
        }}
        onMouseDownCapture={(event) => {
          releaseClick.current = null;
          const selected = window.getSelection();
          gesture.current =
            event.button === 0
              ? {
                  x: event.clientX,
                  y: event.clientY,
                  range: selected?.rangeCount
                    ? selected.getRangeAt(0).cloneRange()
                    : null,
                }
              : null;
        }}
        onKeyDownCapture={() => {
          releaseClick.current = null;
          gesture.current = null;
        }}
        onMouseUp={select}
        onClickCapture={(event) => {
          // Suppress only the release click of the gesture that selected this
          // control's caption. An old selection cannot disable other actions.
          const control = releaseClick.current;
          releaseClick.current = null;
          if (
            event.detail > 0 &&
            control &&
            event.target instanceof Node &&
            control.contains(event.target)
          ) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onKeyUp={(e) => {
          if (e.shiftKey || e.key === "Shift") select();
        }}
      >
        <MessageContent text={text} />
      </div>
      {enabled && (
        <div className="annotation-marks">
          {marks.map(({ entry, number, rects, markerTop }) => (
            <div key={entry.id}>
              {rects.map((rect, index) => (
                <span
                  key={index}
                  className="annotation-highlight"
                  style={rect}
                />
              ))}
              <button
                className="annotation-marker"
                aria-label={`编辑注释 ${number}`}
                title={entry.comment}
                style={{ top: markerTop, right: 0 }}
                onClick={(e) => {
                  e.currentTarget.focus();
                  setSelection({
                    entry,
                    anchor: e.currentTarget.getBoundingClientRect(),
                  });
                  setEditing(true);
                }}
              >
                {number}
              </button>
            </div>
          ))}
        </div>
      )}
      {notice && (
        <p className="annotation-error" role="status">
          {notice}
        </p>
      )}
      {selection &&
        enabled &&
        (editing ? (
          <AnnotationEditor
            entry={selection.entry}
            anchor={selection.anchor}
            onSave={(entry) => {
              const error = onSave(entry);
              if (!error) clearSelection();
              return error;
            }}
            onRemove={
              entries.some((entry) => entry.id === selection.entry.id)
                ? () => onRemove(selection.entry.id)
                : undefined
            }
            close={close}
          />
        ) : (
          createPortal(
            <div
              className="annotation-selection-menu"
              role="menu"
              aria-label="所选文本操作"
              style={{
                left: Math.max(
                  8,
                  Math.min(
                    selection.anchor.left,
                    window.innerWidth - (askInSideChat ? 292 : 120),
                  ),
                ),
                top: Math.max(
                  8,
                  Math.min(selection.anchor.top - 44, window.innerHeight - 48),
                ),
                maxWidth: "calc(100vw - 16px)",
              }}
              onMouseDown={(e) => e.preventDefault()}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  close();
                  return;
                }
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                  return;
                event.preventDefault();
                const buttons = Array.from(
                  event.currentTarget.querySelectorAll("button"),
                );
                const index = buttons.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                buttons[
                  (index +
                    (event.key === "ArrowRight" ? 1 : -1) +
                    buttons.length) %
                    buttons.length
                ]?.focus();
              }}
            >
              <button role="menuitem" onClick={() => setEditing(true)}>
                <MessageSquare size={15} />
                添加注释
              </button>
              {askInSideChat && (
                <button
                  role="menuitem"
                  onClick={() => {
                    const quote = selection.entry.quote;
                    setSelection(null);
                    setEditing(false);
                    releaseClick.current = null;
                    clearSelection();
                    askInSideChat(quote);
                  }}
                >
                  在侧边聊天中提问
                </button>
              )}
            </div>,
            document.body,
          )
        ))}
    </article>
  );
}
