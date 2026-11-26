import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CircleStop,
  GripVertical,
  ListEnd,
  MoreHorizontal,
  Pencil,
  Play,
  Trash2,
} from "lucide-react";
import { createPortal } from "react-dom";
import { request, message } from "./api";
import type { Request, QueuedMessage } from "./protocol";
import { usePollingSnapshot, LIVE_POLL_MS } from "./usePollingSnapshot";
import { useStatusIssues } from "./statusNotices";
import { userMessageContent } from "./annotations";
import { Button, IconButton, MenuRow, StatusSignal } from "./ui";
const initial = {
  entries: [] as QueuedMessage[],
  paused: false,
  reason: null as string | null,
};

export function MessageQueue({
  hostId,
  sessionId,
  connected,
  active,
  revision,
  running,
  onEdit,
  editingBlocked = false,
  onEditPending,
  captureQueuedPredictionRetirement,
}: {
  hostId: string;
  sessionId?: string;
  connected: boolean;
  active: boolean;
  revision: string;
  running: boolean;
  onEdit?: (entry: QueuedMessage) => void;
  editingBlocked?: boolean;
  onEditPending?: (pending: boolean) => void;
  captureQueuedPredictionRetirement?: (requestId: string) => () => void;
}) {
  const scope = JSON.stringify([hostId, sessionId]);
  const context = JSON.stringify([scope, active, connected]);
  const current = useRef({ context, scope, version: 0, mounted: true });
  if (current.current.context !== context)
    current.current = {
      ...current.current,
      context,
      scope,
      version: current.current.version + 1,
    };
  const version = current.current.version;
  const valid = () =>
    current.current.mounted && current.current.version === version;
  useEffect(() => {
    current.current.mounted = true;
    return () => {
      current.current.mounted = false;
    };
  }, []);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const acting = useRef<number | null>(null);
  const [feedback, setFeedback] = useState<{
    id: string;
    revision: number;
    kind: "pending" | "success" | "error";
    text: string;
  }>();
  const [error, setError] = useState("");
  const [recover, setRecover] =
    useState<Extract<Request, { method: "take_queued_message" }>>();
  const drag = useRef<
    | {
        id: string;
        x: number;
        y: number;
        moved: boolean;
        target?: { id: string; after: boolean };
      }
    | undefined
  >(undefined);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    after: boolean;
  }>();
  const [dragging, setDragging] = useState<string>();
  const [collapsed, setCollapsed] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const grips = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterReorder = useRef<{ id: string; before: unknown } | undefined>(
    undefined,
  );
  const latestSnapshot = useRef<unknown>(undefined);
  function endDrag() {
    drag.current = undefined;
    setDragging(undefined);
    setDropTarget(undefined);
  }
  useEffect(() => {
    setBusy(false);
    acting.current = null;
    setFeedback(undefined);
    setError("");
    setCollapsed(false);
    setAnnouncement("");
    focusAfterReorder.current = undefined;
    endDrag();
  }, [context]);
  useEffect(() => {
    if (feedback?.kind !== "success") return;
    const timer = setTimeout(() => setFeedback(undefined), 4000);
    return () => clearTimeout(timer);
  }, [feedback]);
  const read = useCallback(async () => {
    const response = await request(hostId, {
      method: "message_queue",
      session_id: sessionId!,
    });
    if (response.kind !== "message_queue")
      throw new Error("此 Server 不支持消息排队，请更新 Server");
    return response;
  }, [hostId, sessionId]);
  const state = usePollingSnapshot(
    scope,
    active && connected && !!sessionId,
    read,
    initial,
    `${revision}:${reload}:${running}`,
    LIVE_POLL_MS,
    0,
  );
  useEffect(() => {
    if (
      feedback?.kind === "success" &&
      state.data.entries.some(
        (entry) =>
          entry.request_id === feedback.id &&
          entry.revision !== feedback.revision,
      )
    )
      setFeedback(undefined);
  }, [feedback, state.data]);
  latestSnapshot.current = state.data;
  useEffect(() => {
    const pending = focusAfterReorder.current;
    if (!busy && pending && state.data !== pending.before) {
      grips.current.get(pending.id)?.focus();
      focusAfterReorder.current = undefined;
    }
  }, [busy, state.data]);
  async function act(command: Request, focusId?: string) {
    if (acting.current === version || !connected || !active) return;
    const taking = command.method === "take_queued_message";
    if (taking && editingBlocked) return;
    const retirePrediction =
      command.method === "cancel_queued_message" ||
      command.method === "take_queued_message"
        ? captureQueuedPredictionRetirement?.(command.request_id)
        : undefined;
    acting.current = version;
    if (taking) onEditPending?.(true);
    setBusy(true);
    if (command.method === "dispatch_queued_message")
      setFeedback({
        id: command.request_id,
        revision: command.revision,
        kind: "pending",
        text: command.interrupt ? "正在停止当前任务并发送…" : "正在交给 Agent…",
      });
    else setFeedback(undefined);
    setAnnouncement("");
    try {
      const response = await request(hostId, command);
      const taken =
        command.method === "take_queued_message" &&
        response.kind === "queued_message_taken";
      // Authority belongs to the captured operation even after navigation/unmount.
      // Ordinary list omission and clear_queue do not prove a target was cancelled.
      if (
        (command.method === "cancel_queued_message" &&
          response.kind === "message_queue" &&
          !response.entries.some(
            (entry) => entry.request_id === command.request_id,
          )) ||
        (command.method === "take_queued_message" &&
          response.kind === "queued_message_taken" &&
          response.entry.request_id === command.request_id &&
          response.entry.revision === command.revision)
      )
        retirePrediction?.();
      // A confirmed take belongs to its captured session even after navigation.
      if (taken) onEdit?.(response.entry);
      if (!valid()) return;
      if (!taken && response.kind !== "message_queue") {
        throw new Error("队列操作未确认，请刷新后核对");
      }
      setError("");
      if (command.method === "dispatch_queued_message")
        setFeedback({
          id: command.request_id,
          revision: command.revision,
          kind: "success",
          text: "已交给 Agent，等待处理",
        });
      if (command.method === "reorder_message_queue") {
        setAnnouncement("待发送顺序已保存");
        if (focusId)
          focusAfterReorder.current = {
            id: focusId,
            before: latestSnapshot.current,
          };
      }
      if (taken) setRecover(undefined);
      setReload((v) => v + 1);
    } catch (cause) {
      if (
        command.method === "take_queued_message" &&
        current.current.mounted &&
        current.current.scope === scope
      )
        setRecover(command);
      if (valid()) {
        setError(message(cause));
        if (command.method === "dispatch_queued_message")
          setFeedback({
            id: command.request_id,
            revision: command.revision,
            kind: "error",
            text: `未发送：${message(cause)}`,
          });
        setReload((v) => v + 1);
      }
    } finally {
      if (taking) onEditPending?.(false);
      if (valid()) {
        acting.current = null;
        setBusy(false);
      }
    }
  }
  useStatusIssues([
    {
      id: `message-queue:${scope}`,
      title: "消息队列暂不可用",
      error:
        active && connected
          ? error ||
            (recover ? "编辑取回结果待确认，请恢复编辑内容" : state.error)
          : "",
      pending: busy,
      action: {
        label: recover ? "恢复编辑内容" : "刷新队列",
        run: () => {
          if (recover) {
            void act(recover);
            return;
          }
          setError("");
          setReload((v) => v + 1);
        },
      },
    },
  ]);
  const { entries, paused, reason } = state.data;
  useEffect(() => {
    if (entries.length <= 1) setCollapsed(false);
  }, [entries.length]);
  if (!entries.length && (!feedback || feedback.kind === "success"))
    return null;
  const disabled = busy || !connected || !active;
  const canReorder = entries.length > 1 && !disabled;
  const showHeader = paused || entries.length > 1;
  const nextPreview = entries[0]
    ? userMessageContent(entries[0].text).text
    : "";
  function reorder(
    expected: string[],
    id: string,
    target: string,
    after: boolean,
    keyboard = false,
  ) {
    if (!expected.includes(id) || !expected.includes(target)) {
      setAnnouncement("队列已更新，已取消本次拖动");
      return;
    }
    const order = expected.filter((key) => key !== id);
    const index = order.indexOf(target);
    if (index < 0 || id === target) return;
    order.splice(index + (after ? 1 : 0), 0, id);
    if (order.every((key, i) => key === expected[i])) return;
    void act(
      {
        method: "reorder_message_queue",
        session_id: sessionId!,
        expected,
        order,
      },
      keyboard ? id : undefined,
    );
  }
  return (
    <section
      className="message-queue"
      data-paused={paused ? "true" : undefined}
      data-collapsed={collapsed ? "true" : undefined}
      data-dragging={dragging ? "true" : undefined}
      aria-label="待发送消息"
    >
      {showHeader && (
        <div className="message-queue-heading">
          <div className="message-queue-heading-copy">
            {paused ? (
              <StatusSignal status="waiting" />
            ) : (
              <ListEnd
                size={13}
                className="message-queue-marker"
                aria-hidden="true"
              />
            )}
            <span className="message-queue-title">
              待发送 · {entries.length}
            </span>
            {paused ? (
              <span className="message-queue-reason">
                {reason || "队列已暂停"}
              </span>
            ) : (
              collapsed &&
              nextPreview && (
                <span className="message-queue-preview">{nextPreview}</span>
              )
            )}
          </div>
          <div className="message-queue-heading-actions">
            {paused && (
              <Button
                variant="subtle"
                size="xs"
                leading={<Play size={11.5} />}
                disabled={disabled}
                onClick={() =>
                  void act({
                    method: "resume_message_queue",
                    session_id: sessionId!,
                    provider: null,
                  })
                }
              >
                继续排队
              </Button>
            )}
            {entries.length > 1 && (
              <IconButton
                label={collapsed ? "展开待发送队列" : "收起待发送队列"}
                variant="ghost"
                size="xs"
                aria-expanded={!collapsed}
                onClick={() => setCollapsed((v) => !v)}
              >
                {collapsed ? (
                  <ChevronRight size={13.5} />
                ) : (
                  <ChevronDown size={13.5} />
                )}
              </IconButton>
            )}
          </div>
        </div>
      )}
      <span className="visually-hidden" role="status">
        {announcement}
      </span>
      {!collapsed && (
        <ol>
          {entries.map((entry, index) => {
            const content = userMessageContent(entry.text);
            const rowPending =
              feedback?.id === entry.request_id && feedback.kind === "pending";
            return (
              <li
                key={entry.request_id}
                className={[
                  "message-queue-row",
                  dragging === entry.request_id ? "message-queue-dragging" : "",
                  dropTarget?.id === entry.request_id
                    ? dropTarget.after
                      ? "message-queue-drop-after"
                      : "message-queue-drop-before"
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {entries.length === 1 && (
                  <span className="message-queue-lead" aria-hidden="true">
                    <ListEnd size={13.5} className="message-queue-marker" />
                  </span>
                )}
                {entries.length > 1 && (
                  <button
                    ref={(node) => {
                      if (node) grips.current.set(entry.request_id, node);
                      else grips.current.delete(entry.request_id);
                    }}
                    type="button"
                    className="message-queue-grip"
                    aria-label={`排序排队消息：${content.text}`}
                    title="拖动排序，或按上、下方向键调整"
                    disabled={!canReorder}
                    onPointerDown={(event) => {
                      if (!canReorder || event.button !== 0) return;
                      event.preventDefault();
                      event.currentTarget.focus();
                      event.currentTarget.setPointerCapture?.(event.pointerId);
                      drag.current = {
                        id: entry.request_id,
                        x: event.clientX,
                        y: event.clientY,
                        moved: false,
                      };
                      setAnnouncement("");
                    }}
                    onPointerMove={(event) => {
                      const moving = drag.current;
                      if (!canReorder || !moving) return;
                      if (
                        !moving.moved &&
                        Math.hypot(
                          event.clientX - moving.x,
                          event.clientY - moving.y,
                        ) < 4
                      )
                        return;
                      moving.moved = true;
                      setDragging(moving.id);
                      const list = event.currentTarget.closest("ol")!;
                      const bounds = list.getBoundingClientRect();
                      const inside =
                        event.clientX >= bounds.left &&
                        event.clientX <= bounds.right &&
                        event.clientY >= bounds.top &&
                        event.clientY <= bounds.bottom;
                      moving.target = undefined;
                      if (inside) {
                        if (event.clientY < bounds.top + 24)
                          list.scrollTop -= 12;
                        else if (event.clientY > bounds.bottom - 24)
                          list.scrollTop += 12;
                        for (const [i, row] of Array.from(
                          list.children,
                        ).entries()) {
                          const box = row.getBoundingClientRect();
                          if (
                            event.clientY >= box.top &&
                            event.clientY <= box.bottom &&
                            entries[i].request_id !== moving.id
                          ) {
                            moving.target = {
                              id: entries[i].request_id,
                              after: event.clientY > box.top + box.height / 2,
                            };
                            break;
                          }
                        }
                      }
                      setDropTarget(moving.target);
                    }}
                    onPointerUp={(event) => {
                      const moving = drag.current;
                      if (canReorder && moving?.moved && moving.target)
                        reorder(
                          entries.map((item) => item.request_id),
                          moving.id,
                          moving.target.id,
                          moving.target.after,
                        );
                      endDrag();
                      if (
                        event.currentTarget.hasPointerCapture?.(event.pointerId)
                      )
                        event.currentTarget.releasePointerCapture(
                          event.pointerId,
                        );
                    }}
                    onPointerCancel={endDrag}
                    onLostPointerCapture={endDrag}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        endDrag();
                        return;
                      }
                      if (
                        !canReorder ||
                        !["ArrowUp", "ArrowDown"].includes(event.key)
                      )
                        return;
                      event.preventDefault();
                      const down = event.key === "ArrowDown";
                      const target = entries[index + (down ? 1 : -1)];
                      if (target)
                        reorder(
                          entries.map((item) => item.request_id),
                          entry.request_id,
                          target.request_id,
                          down,
                          true,
                        );
                    }}
                  >
                    <span className="message-queue-index" aria-hidden="true">
                      {index + 1}
                    </span>
                    <GripVertical
                      size={13.5}
                      className="message-queue-grip-icon"
                      aria-hidden="true"
                    />
                  </button>
                )}
                <span className="message-queue-text" title={content.text}>
                  {content.text}
                  {content.references.length > 0 && (
                    <small> · {content.references.length} 个引用</small>
                  )}
                </span>
                <div
                  className="message-queue-actions"
                  data-busy={rowPending ? "true" : undefined}
                >
                  <IconButton
                    label={`发送排队消息：${content.text}`}
                    title="发送给 Agent（不中断当前任务）"
                    variant="ghost"
                    size="xs"
                    busy={rowPending}
                    disabled={
                      disabled ||
                      (feedback?.id === entry.request_id &&
                        feedback.kind === "success")
                    }
                    onClick={() =>
                      void act({
                        method: "dispatch_queued_message",
                        interrupt: false,
                        session_id: sessionId!,
                        request_id: entry.request_id,
                        revision: entry.revision,
                        provider: null,
                      })
                    }
                  >
                    <ArrowUp size={13.5} />
                  </IconButton>
                  <IconButton
                    label={`删除排队消息：${content.text}`}
                    title="移除"
                    variant="ghost"
                    intent="danger"
                    size="xs"
                    disabled={disabled}
                    onClick={() =>
                      void act({
                        method: "cancel_queued_message",
                        session_id: sessionId!,
                        request_id: entry.request_id,
                        revision: entry.revision,
                      })
                    }
                  >
                    <Trash2 size={13.5} />
                  </IconButton>
                  <QueueMessageMenu
                    disabled={disabled}
                    canEdit={!!onEdit && !editingBlocked}
                    stopAndSend={() =>
                      void act({
                        method: "dispatch_queued_message",
                        interrupt: true,
                        session_id: sessionId!,
                        request_id: entry.request_id,
                        revision: entry.revision,
                        provider: null,
                      })
                    }
                    name={content.text}
                    edit={() =>
                      void act({
                        method: "take_queued_message",
                        session_id: sessionId!,
                        request_id: entry.request_id,
                        revision: entry.revision,
                      })
                    }
                  />
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {feedback && (
        <p
          className="message-queue-feedback"
          data-tone={feedback.kind === "error" ? "danger" : undefined}
          role={feedback.kind === "error" ? "alert" : "status"}
        >
          {feedback.text}
        </p>
      )}
    </section>
  );
}

function QueueMessageMenu({
  disabled,
  name,
  edit,
  canEdit,
  stopAndSend,
}: {
  disabled: boolean;
  name: string;
  edit: () => void;
  canEdit: boolean;
  stopAndSend: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [point, setPoint] = useState<{ x: number; y: number }>();
  useLayoutEffect(() => {
    if (!point || !menu.current || !trigger.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const box = menu.current.getBoundingClientRect();
    const gap = 6;
    const placeAbove =
      anchor.top - box.height - gap >= 8 ||
      anchor.top > innerHeight - anchor.bottom;
    const top = placeAbove
      ? Math.max(8, anchor.top - box.height - gap)
      : Math.min(anchor.bottom + gap, innerHeight - box.height - 8);
    menu.current.style.left = `${Math.max(8, Math.min(anchor.right - box.width, innerWidth - box.width - 8))}px`;
    menu.current.style.top = `${Math.max(8, top)}px`;
    menu.current
      .querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
  }, [point]);
  useEffect(() => {
    if (!point) return;
    const outside = (event: PointerEvent) => {
      if (
        !menu.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setPoint(undefined);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        // Put focus on the persistent trigger before the portal is removed;
        // normal Tab/Shift+Tab then continues from the row instead of body.
        trigger.current?.focus();
        setPoint(undefined);
        return;
      }
      if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const buttons = Array.from(
          menu.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) ?? [],
        );
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) %
                buttons.length;
        buttons[next]?.focus();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setPoint(undefined);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key, true);
    };
  }, [point]);
  return (
    <>
      <IconButton
        ref={trigger}
        label={`排队消息更多操作：${name}`}
        title="更多操作"
        variant="ghost"
        size="xs"
        aria-haspopup="menu"
        aria-expanded={!!point}
        active={!!point}
        disabled={disabled}
        onClick={() => {
          const box = trigger.current!.getBoundingClientRect();
          setPoint(point ? undefined : { x: box.right, y: box.bottom + 4 });
        }}
      >
        <MoreHorizontal size={14} />
      </IconButton>
      {point &&
        !disabled &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            aria-label="排队消息操作"
            className="ui-popover message-queue-menu"
            style={{ position: "fixed", left: point.x, top: point.y }}
          >
            <MenuRow
              role="menuitem"
              disabled={!canEdit}
              leading={<Pencil size={13.5} />}
              onClick={() => {
                setPoint(undefined);
                edit();
              }}
            >
              编辑消息
            </MenuRow>
            <MenuRow
              role="menuitem"
              leading={<CircleStop size={13.5} />}
              onClick={() => {
                setPoint(undefined);
                stopAndSend();
              }}
            >
              停止当前并发送
            </MenuRow>
          </div>,
          document.body,
        )}
    </>
  );
}
