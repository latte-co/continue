import { useId, useRef, useState } from "react";
import { History, MessageCircle } from "lucide-react";
import { message, request, ServerRequestError } from "./api";
import { MessageTimestamp } from "./MessageTimestamp";
import type { Session } from "./protocol";
import { useEffect } from "react";
import { Badge, Button, IconButton, MenuTitle, NavRow, Popover } from "./ui";

export interface SideChatHistoryProps {
  hostId: string;
  parentId: string;
  currentId?: string;
  onOpen: (id: string) => void;
}

export function SideChatHistory({
  hostId,
  parentId,
  currentId,
  onOpen,
}: SideChatHistoryProps) {
  return (
    <SideChatHistoryPages
      key={JSON.stringify([hostId, parentId])}
      hostId={hostId}
      parentId={parentId}
      currentId={currentId}
      onOpen={onOpen}
    />
  );
}

function SideChatHistoryPages({
  hostId,
  parentId,
  currentId,
  onOpen,
}: SideChatHistoryProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [before, setBefore] = useState<string | null>(null);
  const [attempt, retry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;
    async function read() {
      try {
        const response = await request(hostId, {
          method: "side_chat_history",
          session_id: parentId,
          before,
        }).catch((cause) => {
          if (
            before === null &&
            cause instanceof ServerRequestError &&
            cause.code === "invalid_request"
          )
            return request(hostId, {
              method: "side_chats",
              session_id: parentId,
            });
          throw cause;
        });
        if (disposed) return;
        if (
          response.kind !== "side_chat_history" &&
          response.kind !== "sessions"
        )
          throw new Error("无法读取历史记录");
        setSessions((previous) =>
          before === null
            ? response.sessions
            : [...previous, ...response.sessions],
        );
        setNext(response.kind === "side_chat_history" ? response.next : null);
      } catch (cause) {
        if (!disposed) setError(message(cause));
      } finally {
        if (!disposed) setLoading(false);
      }
    }
    void read();
    return () => {
      disposed = true;
    };
  }, [hostId, parentId, before, attempt]);

  function loadOlder() {
    setLoading(true);
    setError("");
    if (error) retry((value) => value + 1);
    else setBefore(next);
  }

  return (
    <div className="side-chat-history-list" role="group" aria-label="历史记录">
      {sessions.map((session) => {
        const status =
          session.status === "running"
            ? { label: "执行中", tone: "brand" as const }
            : session.status === "waiting"
              ? { label: "等待回应", tone: "warning" as const }
              : session.status === "failed"
                ? { label: "失败", tone: "danger" as const }
                : session.status === "unknown"
                  ? { label: "待确认", tone: "neutral" as const }
                  : null;
        return (
          <NavRow
            key={session.id}
            selected={session.id === currentId}
            aria-current={session.id === currentId ? "true" : undefined}
            title={session.title}
            icon={<MessageCircle size={14.5} aria-hidden="true" />}
            trailing={
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                {status && (
                  <Badge tone={status.tone} data-status={session.status}>
                    {status.label}
                  </Badge>
                )}
                <MessageTimestamp at={session.created_at} label="创建时间" />
              </span>
            }
            onClick={() => onOpen(session.id)}
          >
            {session.title}
          </NavRow>
        );
      })}
      {(loading || error || !sessions.length) && (
        <p className="side-chat-history-status" role="status">
          {loading ? "正在读取…" : error || "暂无历史记录"}
        </p>
      )}
      {(next || error || before) && (
        <Button
          variant="ghost"
          size="xs"
          fullWidth
          className="task-info-earlier"
          aria-disabled={loading || (!next && !error) || undefined}
          onClick={() => {
            if (!loading && (next || error)) loadOlder();
          }}
        >
          {error ? "重试" : next ? "查看更早记录" : "已显示全部记录"}
        </Button>
      )}
    </div>
  );
}

export function SideChatHistoryButton(props: SideChatHistoryProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();

  return (
    <>
      <IconButton
        ref={trigger}
        size="sm"
        active={open}
        label="历史"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <History size={15.5} aria-hidden="true" />
      </IconButton>
      <Popover
        id={id}
        open={open}
        anchorRef={trigger}
        align="end"
        minWidth={288}
        role="dialog"
        label="历史"
        autoFocusMenu
        className="side-chat-history-popover"
        onClose={(restoreFocus) => {
          setOpen(false);
          if (restoreFocus) trigger.current?.focus();
        }}
        onBlur={(event) => {
          if (
            !event.currentTarget.contains(event.relatedTarget) &&
            event.relatedTarget !== trigger.current
          )
            setOpen(false);
        }}
      >
        <MenuTitle>历史</MenuTitle>
        <SideChatHistory
          {...props}
          onOpen={(sideId) => {
            setOpen(false);
            trigger.current?.focus();
            props.onOpen(sideId);
          }}
        />
      </Popover>
    </>
  );
}
