import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ArrowUp, MessageSquareText, Pencil, Trash2, X } from "lucide-react";
import { isHiddenOrInert, Modal } from "./Modal";
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
  maxWidth = 440,
  gap = 10,
  className = "",
  close,
  children,
}: {
  anchor: Rect;
  label: string;
  maxWidth?: number;
  gap?: number;
  className?: string;
  close: () => void;
  children: ReactNode;
}) {
  const content = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({
    left: 8,
    top: 8,
    width: maxWidth,
  });
  useLayoutEffect(() => {
    const place = () => {
      const width = Math.max(0, Math.min(maxWidth, window.innerWidth - 16));
      const height = Math.min(
        content.current?.offsetHeight ?? 56,
        window.innerHeight - 24,
      );
      setPosition({
        width,
        left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
        top: Math.max(
          8,
          Math.min(
            anchor.top >= height + gap + 8
              ? anchor.top - height - gap
              : anchor.bottom + gap,
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
  }, [anchor, gap, maxWidth]);
  return createPortal(
    <div
      className="annotation-backdrop"
      ref={popover}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <Modal
        className={`annotation-popover${className ? ` ${className}` : ""}`}
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
  gap = 10,
  onSave,
  onRemove,
  close,
}: {
  entry: Annotation;
  anchor: Rect;
  gap?: number;
  onSave: Change;
  onRemove?: () => void;
  close: () => void;
}) {
  const [comment, setComment] = useState(entry.comment);
  const [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 28), 120)}px`;
  }, [comment]);
  function save() {
    const result = onSave({ ...entry, comment: comment.trim() });
    if (result) setError(result);
    else close();
  }
  return (
    <AnnotationPopover
      anchor={anchor}
      label={entry.comment ? "编辑注释" : "添加注释"}
      maxWidth={400}
      gap={gap}
      className="annotation-editor-popover"
      close={close}
    >
      <div className="annotation-editor-shell">
        <div className="annotation-editor">
          <textarea
            ref={input}
            id={`annotation-${entry.id}`}
            aria-label="添加可选评论"
            autoFocus
            rows={1}
            maxLength={MAX_COMMENT}
            placeholder="添加可选评论…"
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
                (!e.shiftKey || e.metaKey || e.ctrlKey) &&
                !e.nativeEvent.isComposing &&
                !composing.current &&
                e.keyCode !== 229
              ) {
                e.preventDefault();
                save();
              }
            }}
          />
          {onRemove && (
            <button
              type="button"
              className="icon-button annotation-editor-delete"
              aria-label="删除注释"
              title="删除注释"
              onClick={() => {
                onRemove();
                close();
              }}
            >
              <Trash2 size={14} />
            </button>
          )}
          <button
            type="button"
            className="annotation-submit"
            aria-label="提交注释"
            title="提交注释（Enter）"
            onClick={save}
          >
            <ArrowUp size={16} strokeWidth={2} />
          </button>
        </div>
        {error && (
          <p role="alert" className="annotation-error">
            {error}
          </p>
        )}
      </div>
    </AnnotationPopover>
  );
}

function AnnotationInlineEditor({
  entry,
  number,
  disabled,
  onSave,
  onCancel,
}: {
  entry: Annotation;
  number: number;
  disabled: boolean;
  onSave: Change;
  onCancel: () => void;
}) {
  const [comment, setComment] = useState(entry.comment);
  const [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 24), 120)}px`;
  }, [comment]);
  function save() {
    const result = onSave({ ...entry, comment: comment.trim() });
    if (result) setError(result);
    else onCancel();
  }
  return (
    <div className="annotation-inline-editor-wrap">
      <div className="annotation-inline-editor">
        <textarea
          ref={input}
          aria-label={`编辑注释 ${number} 评论`}
          autoFocus
          rows={1}
          disabled={disabled}
          maxLength={MAX_COMMENT}
          placeholder="添加可选评论…"
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
            if (e.key === "Escape" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.stopPropagation();
              onCancel();
              return;
            }
            if (
              e.key === "Enter" &&
              (!e.shiftKey || e.metaKey || e.ctrlKey) &&
              !e.nativeEvent.isComposing &&
              !composing.current &&
              e.keyCode !== 229
            ) {
              e.preventDefault();
              save();
            }
          }}
        />
        <button
          type="button"
          className="icon-button annotation-inline-cancel"
          aria-label="取消编辑"
          title="取消编辑（Esc）"
          disabled={disabled}
          onClick={onCancel}
        >
          <X size={14} />
        </button>
        <button
          type="button"
          className="annotation-submit annotation-inline-submit"
          aria-label="提交注释"
          title="提交注释（Enter）"
          disabled={disabled}
          onClick={save}
        >
          <ArrowUp size={14} strokeWidth={2} />
        </button>
      </div>
      {error && (
        <p role="alert" className="annotation-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function AnnotationSummary({
  entries,
  onSave,
  onRemove,
  onClear,
  onFocusComposer,
  disabled = false,
  active = true,
}: {
  entries: Annotation[];
  onSave?: Change;
  onRemove?: (id: string) => void;
  onClear?: () => void;
  onFocusComposer?: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const [anchor, setAnchor] = useState<Rect | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => {
    if (!active || disabled || !entries.length) {
      setAnchor(null);
      setEditingId(null);
    }
  }, [active, disabled, entries.length]);
  useEffect(() => {
    if (editingId && !entries.some((entry) => entry.id === editingId)) {
      setEditingId(null);
    }
  }, [editingId, entries]);
  const close = () => {
    setAnchor(null);
    setEditingId(null);
    queueMicrotask(() => {
      if (trigger.current?.isConnected && !isHiddenOrInert(trigger.current))
        trigger.current.focus();
    });
  };
  const focusRowEditButton = (id: string) => {
    queueMicrotask(() => {
      const button = Array.from(
        list.current?.querySelectorAll<HTMLButtonElement>(
          "button[data-edit-id]",
        ) ?? [],
      ).find((el) => el.dataset.editId === id);
      button?.focus();
    });
  };
  const removeItem = (id: string) => {
    if (!onRemove) return;
    const willEmpty = entries.length <= 1;
    if (editingId === id) setEditingId(null);
    onRemove(id);
    if (willEmpty) {
      setAnchor(null);
      queueMicrotask(() => onFocusComposer?.());
      return;
    }
    queueMicrotask(() => {
      const dialog = list.current?.closest('[role="dialog"]') as
        HTMLElement | null | undefined;
      if (!dialog?.isConnected) return;
      if (!dialog.contains(document.activeElement)) {
        const nextControl =
          list.current?.querySelector<HTMLElement>(
            "button:not(:disabled), textarea:not(:disabled)",
          ) ?? dialog;
        nextControl.focus({ preventScroll: true });
      }
    });
  };
  if (!entries.length) return null;
  return (
    <div className="annotation-summary">
      <div className="annotation-chip">
        <button
          type="button"
          ref={trigger}
          className="annotation-chip-trigger"
          aria-expanded={!!anchor}
          aria-haspopup="dialog"
          disabled={disabled}
          onClick={() => {
            trigger.current?.focus();
            setAnchor(trigger.current!.getBoundingClientRect());
          }}
        >
          <MessageSquareText size={13} />
          <span>{entries.length} 条注释</span>
        </button>
        {onClear && (
          <button
            type="button"
            disabled={disabled}
            className="annotation-clear"
            aria-label="移除全部注释"
            title="移除全部注释"
            onClick={() => {
              onClear();
              queueMicrotask(() => onFocusComposer?.());
            }}
          >
            <X size={13} />
          </button>
        )}
      </div>
      {anchor && active && (
        <AnnotationPopover
          anchor={anchor}
          label="消息注释"
          maxWidth={460}
          gap={8}
          className="annotation-list-popover"
          close={close}
        >
          <ol className="annotation-list" ref={list}>
            {entries.map((entry, index) => {
              const comment = entry.comment.trim();
              const isEditing = editingId === entry.id && !!onSave;
              return (
                <li key={entry.id}>
                  <span className="annotation-index">{index + 1}.</span>
                  <div className="annotation-copy">
                    <span>所选文本：</span>
                    <blockquote>{entry.quote}</blockquote>
                    {isEditing ? (
                      <>
                        <span>用户评论：</span>
                        <AnnotationInlineEditor
                          key={entry.id}
                          entry={entry}
                          number={index + 1}
                          disabled={disabled}
                          onSave={onSave}
                          onCancel={() => {
                            setEditingId(null);
                            focusRowEditButton(entry.id);
                          }}
                        />
                      </>
                    ) : (
                      comment && (
                        <>
                          <span>用户评论：</span>
                          <p>{comment}</p>
                        </>
                      )
                    )}
                  </div>
                  {(onSave || onRemove) && !isEditing && (
                    <div className="annotation-entry-actions">
                      {onSave && (
                        <button
                          type="button"
                          data-edit-id={entry.id}
                          className="icon-button"
                          aria-label={`编辑注释 ${index + 1}`}
                          title="编辑注释"
                          disabled={disabled}
                          onClick={() => setEditingId(entry.id)}
                        >
                          <Pencil size={14} />
                        </button>
                      )}
                      {onRemove && (
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`删除注释 ${index + 1}`}
                          title="删除注释"
                          disabled={disabled}
                          onClick={() => removeItem(entry.id)}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </AnnotationPopover>
      )}
    </div>
  );
}

function innermostClipScope(node: Node, root: HTMLElement): HTMLElement {
  let ancestor: HTMLElement | null =
    node instanceof HTMLElement ? node : node.parentElement;
  while (ancestor && ancestor !== root) {
    const style = window.getComputedStyle(ancestor);
    if (
      (style.overflowX !== "" && style.overflowX !== "visible") ||
      (style.overflowY !== "" && style.overflowY !== "visible")
    ) {
      return ancestor;
    }
    ancestor = ancestor.parentElement;
  }
  return root;
}

function rangeClipSegments(
  range: Range,
  root: HTMLElement,
): { range: Range; scope: HTMLElement }[] {
  if (
    range.startContainer === range.endContainer ||
    range.startContainer.nodeType !== Node.TEXT_NODE ||
    range.endContainer.nodeType !== Node.TEXT_NODE
  ) {
    return [
      {
        range,
        scope: innermostClipScope(range.commonAncestorContainer, root),
      },
    ];
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  walker.currentNode = range.startContainer;
  const groups: {
    scope: HTMLElement;
    startNode: Node;
    startOffset: number;
    endNode: Node;
    endOffset: number;
  }[] = [];
  for (
    let node: Node | null = walker.currentNode;
    node;
    node = walker.nextNode()
  ) {
    const startOffset = node === range.startContainer ? range.startOffset : 0;
    const endOffset =
      node === range.endContainer
        ? range.endOffset
        : (node.textContent?.length ?? 0);
    if (endOffset > startOffset) {
      const scope = innermostClipScope(node, root);
      const prev = groups.at(-1);
      if (prev && prev.scope === scope) {
        groups[groups.length - 1] = {
          ...prev,
          endNode: node,
          endOffset,
        };
      } else {
        groups.push({
          scope,
          startNode: node,
          startOffset,
          endNode: node,
          endOffset,
        });
      }
    }
    if (node === range.endContainer) break;
  }
  if (groups.length <= 1) {
    return [
      {
        range,
        scope:
          groups[0]?.scope ??
          innermostClipScope(range.commonAncestorContainer, root),
      },
    ];
  }
  return groups.map((group) => {
    const sub = document.createRange();
    sub.setStart(group.startNode, group.startOffset);
    sub.setEnd(group.endNode, group.endOffset);
    return { range: sub, scope: group.scope };
  });
}

function clipRectsForScope(
  range: Range,
  scope: HTMLElement,
  root: HTMLElement,
  base: Rect,
  origin: DOMRect,
  limit: number,
) {
  let {
    left: clipLeft,
    right: clipRight,
    top: clipTop,
    bottom: clipBottom,
  } = base;
  let ancestor: HTMLElement | null = scope;
  while (ancestor && ancestor !== root) {
    const style = window.getComputedStyle(ancestor);
    const clipX = style.overflowX !== "" && style.overflowX !== "visible";
    const clipY = style.overflowY !== "" && style.overflowY !== "visible";
    if (clipX || clipY) {
      const box = ancestor.getBoundingClientRect();
      if (clipX && box.width > 0) {
        clipLeft = Math.max(clipLeft, box.left);
        clipRight = Math.min(clipRight, box.right);
      }
      if (clipY && box.height > 0) {
        clipTop = Math.max(clipTop, box.top);
        clipBottom = Math.min(clipBottom, box.bottom);
      }
    }
    ancestor = ancestor.parentElement;
  }
  return Array.from(range.getClientRects())
    .filter((r) => r.width && r.height)
    .slice(0, limit)
    .map((r) => {
      const leftEdge = Number.isFinite(clipLeft)
        ? Math.max(r.left, clipLeft)
        : r.left;
      const rightEdge = Number.isFinite(clipRight)
        ? Math.min(r.right, clipRight)
        : r.right;
      const topEdge = Number.isFinite(clipTop)
        ? Math.max(r.top, clipTop)
        : r.top;
      const bottomEdge = Number.isFinite(clipBottom)
        ? Math.min(r.bottom, clipBottom)
        : r.bottom;
      return {
        left: Math.max(0, leftEdge - origin.left),
        top: topEdge - origin.top,
        width: Number.isFinite(clipRight)
          ? Math.max(0, rightEdge - leftEdge)
          : r.width,
        height: Number.isFinite(clipBottom)
          ? Math.max(0, bottomEdge - topEdge)
          : r.height,
      };
    })
    .filter((r) => r.width > 0 && r.height > 0);
}

export function AnnotatedMessage({
  text,
  message,
  entries,
  enabled,
  onSave,
  onRemove,
  askInSideChat,
  addToMainChat,
}: {
  text: string;
  message: number;
  entries: Annotation[];
  enabled: boolean;
  onSave: Change;
  onRemove: (id: string) => void;
  askInSideChat?: (quote: string) => void;
  addToMainChat?: (quote: string) => void;
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
      markerLeft: number;
      markerTop: number;
      pending: boolean;
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
        !isHiddenOrInert(body.current)
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
  const pendingEntry =
    editing &&
    selection &&
    !entries.some((entry) => entry.id === selection.entry.id)
      ? selection.entry
      : null;
  useLayoutEffect(() => {
    const root = body.current;
    const container = root?.parentElement;
    if (!root || !container) return;
    if (
      !pendingEntry &&
      !entries.some((entry) => entry.source.message === message)
    ) {
      setMarks([]);
      return;
    }
    const measure = () => {
      const origin = container.getBoundingClientRect();
      const bodyRect = root.getBoundingClientRect();
      const baseClip: Rect = {
        left:
          bodyRect.width > 0
            ? bodyRect.left
            : origin.width > 0
              ? origin.left
              : -Infinity,
        right:
          bodyRect.width > 0
            ? bodyRect.right
            : origin.width > 0
              ? origin.right
              : Infinity,
        top:
          bodyRect.height > 0
            ? bodyRect.top
            : origin.height > 0
              ? origin.top
              : -Infinity,
        bottom:
          bodyRect.height > 0
            ? bodyRect.bottom
            : origin.height > 0
              ? origin.bottom
              : Infinity,
      };
      const maxLeft = Math.max(0, container.clientWidth - 24);
      const occupied: { left: number; top: number }[] = [];
      const buildMark = (
        entry: Annotation,
        number: number,
        pending: boolean,
      ) => {
        const range = annotationRange(root, entry);
        if (!range || typeof range.getClientRects !== "function") return [];
        const rects: {
          left: number;
          top: number;
          width: number;
          height: number;
        }[] = [];
        for (const segment of rangeClipSegments(range, root)) {
          if (rects.length >= 500) break;
          rects.push(
            ...clipRectsForScope(
              segment.range,
              segment.scope,
              root,
              baseClip,
              origin,
              500 - rects.length,
            ),
          );
        }
        if (!rects.length) return [];
        const anchorRect = rects.at(-1)!;
        const markerLeft = Math.max(
          0,
          Math.min(anchorRect.left + anchorRect.width - 6, maxLeft),
        );
        let markerTop = anchorRect.top - 18;
        while (
          occupied.some(
            (pos) =>
              Math.abs(pos.left - markerLeft) < 26 &&
              Math.abs(pos.top - markerTop) < 26,
          )
        )
          markerTop += 26;
        occupied.push({ left: markerLeft, top: markerTop });
        return [
          {
            entry,
            number,
            rects,
            markerLeft,
            markerTop,
            pending,
          },
        ];
      };
      const savedMarks = entries.flatMap((entry, index) =>
        entry.source.message === message
          ? buildMark(entry, index + 1, false)
          : [],
      );
      const draftMarks = pendingEntry
        ? buildMark(pendingEntry, entries.length + 1, true)
        : [];
      setMarks([...savedMarks, ...draftMarks]);
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
    observer?.observe(container);
    observer?.observe(root);
    root.addEventListener("scroll", schedule, true);
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      root.removeEventListener("scroll", schedule, true);
    };
  }, [entries, message, pendingEntry, text]);
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
        enabled &&
        (!!pendingEntry ||
          entries.some((entry) => entry.source.message === message))
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
          {marks.map(
            ({ entry, number, rects, markerLeft, markerTop, pending }) => (
              <div key={entry.id}>
                {rects.map((rect, index) => (
                  <span
                    key={index}
                    className="annotation-highlight"
                    style={rect}
                  />
                ))}
                {pending ? (
                  <span
                    className="annotation-marker annotation-marker-pending"
                    aria-hidden="true"
                    style={{ left: markerLeft, top: markerTop }}
                  >
                    {number}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="annotation-marker"
                    aria-label={`编辑注释 ${number}`}
                    title={entry.comment || entry.quote}
                    style={{ left: markerLeft, top: markerTop }}
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
                )}
              </div>
            ),
          )}
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
            gap={pendingEntry ? 28 : 8}
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
                    window.innerWidth -
                      (askInSideChat || addToMainChat ? 268 : 112),
                  ),
                ),
                top: Math.max(
                  8,
                  Math.min(selection.anchor.top - 42, window.innerHeight - 44),
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
                <MessageSquareText size={14} />
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
              {addToMainChat && (
                <button
                  role="menuitem"
                  onClick={() => {
                    const quote = selection.entry.quote;
                    setSelection(null);
                    setEditing(false);
                    releaseClick.current = null;
                    clearSelection();
                    addToMainChat(quote);
                  }}
                >
                  添加到主对话
                </button>
              )}
            </div>,
            document.body,
          )
        ))}
    </article>
  );
}
