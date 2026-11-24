import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApprovalCard } from "./ApprovalCard";
import { ImageGallery } from "./ImageGallery";
import { MessageContent } from "./MessageContent";
import { QuestionCard } from "./QuestionCard";
import { ToolGroup, ToolRow } from "./ToolActivity";
import { ToolImages } from "./ToolImages";
import { TurnTranscript } from "./TurnTranscript";
import { UserMessage } from "./UserMessage";
import { WorkingStatus } from "./WorkingStatus";
import { message, request } from "./api";
import { executionStatus } from "./executionStatus";
import type { Event, Request, Session } from "./protocol";
import { clearSideWriteConfirmation } from "./sideWritePrompts";
import { LIVE_POLL_MS } from "./usePollingSnapshot";
import type { Workbench } from "./useWorkbench";
import { Button, Dialog, NoticeBanner } from "./ui";

export interface StandaloneSideChatTarget {
  hostId: string;
  sideId: string;
  initialSession: Session;
}

export function SideChatRecoveryDialog({
  state,
  target,
}: {
  state: Workbench;
  target: StandaloneSideChatTarget;
}) {
  const { hostId, sideId, initialSession } = target;
  const { closeStandaloneSideChat } = state;
  const connected = state.isHostConnected(hostId);
  const [session, setSession] = useState<Session>(initialSession);
  const [events, setEvents] = useState<Event[]>([]);
  const [ready, setReady] = useState(false);
  const [readError, setReadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, refresh] = useState(0);
  const [confirming, setConfirming] = useState<string>();
  const [hadPending, setHadPending] = useState(() =>
    Boolean(
      initialSession.agent_close_pending || initialSession.side_write_pending,
    ),
  );
  const after = useRef(0);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  const hostName =
    state.hosts.find((item) => item.id === hostId)?.name ?? hostId;
  const project = state.projects.find(
    (item) => item.hostId === hostId && item.id === session.project_id,
  );
  const projectName = project?.name;

  const running = session.status === "running" || session.status === "waiting";
  const closePending = session.agent_close_pending;
  const sideWritePending = session.side_write_pending;
  const needsRuntimeClose =
    !running && !!closePending && session.agent_session_open === true;
  const pendingToken =
    !running && !needsRuntimeClose
      ? closePending
        ? `close:${closePending}`
        : sideWritePending
          ? `write:${sideWritePending}`
          : undefined
      : undefined;
  const showingConfirmation = !!pendingToken && confirming === pendingToken;
  const idleAndReady =
    ready && !running && !closePending && !sideWritePending && !readError;
  const reconciled = hadPending && idleAndReady;
  const noPendingProjected = !hadPending && idleAndReady;

  useEffect(() => {
    if (closePending || sideWritePending) setHadPending(true);
  }, [closePending, sideWritePending]);

  useEffect(() => {
    if (confirming && confirming !== pendingToken) setConfirming(undefined);
  }, [confirming, pendingToken]);

  useEffect(() => {
    if (ready && !closePending && !sideWritePending) {
      clearSideWriteConfirmation(hostId, sideId);
    }
  }, [ready, closePending, sideWritePending, hostId, sideId]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        busy ||
        event.defaultPrevented ||
        document.querySelector(".ssh-password-modal")
      )
        return;
      const self = document.querySelector<HTMLElement>(
        ".side-chat-recovery-modal",
      );
      for (let cur = self; cur; cur = cur.parentElement) {
        if (cur.inert || cur.hasAttribute("inert")) return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      closeStandaloneSideChat();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [busy, closeStandaloneSideChat]);

  useEffect(() => {
    setReady(false);
    if (!connected || busy) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const page = await request(hostId, {
          method: "poll",
          session_id: sideId,
          after: after.current,
        });
        if (disposed) return;
        if (
          page.kind !== "events" ||
          page.session.id !== sideId ||
          page.session.project_id !== initialSession.project_id
        )
          throw new Error("侧边聊天记录不匹配");
        if (page.has_more && !page.events.length)
          throw new Error("侧边聊天记录分页未前进");
        if (page.events.length) {
          const next = page.events.at(-1)!.seq;
          if (
            next <= after.current ||
            page.events.some((entry) => entry.session_id !== sideId)
          )
            throw new Error("侧边聊天记录游标无效");
          after.current = next;
          setEvents((previous) => [...previous, ...page.events]);
        }
        setSession(page.session);
        setReady(!page.has_more);
        setReadError("");
        timer = setTimeout(read, page.has_more ? 0 : LIVE_POLL_MS);
      } catch (cause) {
        if (!disposed) {
          setReadError(message(cause));
          setReady(false);
        }
      }
    }
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [connected, busy, hostId, sideId, initialSession.project_id, revision]);

  useLayoutEffect(() => {
    if (follow.current && scroll.current) {
      scroll.current.scrollTop = scroll.current.scrollHeight;
    }
  }, [events, session.status]);

  async function perform(action: Request, requireReady = false) {
    if (!connected || busy || (requireReady && !ready)) return;
    setBusy(true);
    setError("");
    try {
      const response = await request(hostId, action);
      if (action.method === "close_agent_session") {
        if (response.kind !== "ok" && response.kind !== "side_chat_closed")
          throw new Error("无法确认侧边聊天已关闭");
      } else if (
        action.method === "confirm_agent_closed" ||
        action.method === "confirm_side_writes_ended"
      ) {
        if (response.kind !== "session")
          throw new Error("操作结果待确认，请核对侧边聊天的记录");
        setSession(response.session);
        if (
          !response.session.agent_close_pending &&
          !response.session.side_write_pending
        ) {
          clearSideWriteConfirmation(hostId, sideId);
        }
      } else if (response.kind !== "ok") {
        throw new Error("操作结果待确认，请核对侧边聊天的记录");
      }
      setReady(false);
      refresh((value) => value + 1);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  function confirmEnd() {
    if (!confirming || confirming !== pendingToken) return;
    setConfirming(undefined);
    if (closePending && confirming === `close:${closePending}`) {
      void perform(
        {
          method: "confirm_agent_closed",
          session_id: sideId,
          close_id: closePending,
        },
        true,
      );
      return;
    }
    if (sideWritePending && confirming === `write:${sideWritePending}`) {
      void perform(
        {
          method: "confirm_side_writes_ended",
          session_id: sideId,
          request_id: sideWritePending,
        },
        true,
      );
    }
  }

  const status = executionStatus(session, events, connected);
  const title = session.title.trim() || sideId;

  return (
    <Dialog
      open
      width={680}
      className="side-chat-recovery-modal"
      ariaLabel={`核对侧边聊天：${title}`}
      title="核对侧边聊天"
      description={`${hostName}${projectName ? ` · ${projectName}` : ""} · ${title}（${sideId}）`}
      closeLabel="关闭侧边聊天核对窗口"
      busy={busy}
      onClose={closeStandaloneSideChat}
      footer={
        <Button
          variant={reconciled ? "primary" : "subtle"}
          size="md"
          disabled={busy}
          onClick={closeStandaloneSideChat}
        >
          {reconciled ? "完成" : "关闭"}
        </Button>
      }
    >
      <p className="ui-field-hint" style={{ margin: 0 }}>
        当前主机的旧版 Server
        未返回该侧边聊天所属的主会话（可能已归档、已关闭且超出最近 500
        条记录）。你可直接在此核对侧边聊天记录并确认写入结束，或更新主机 Server
        以恢复跳转至原主会话。
      </p>
      <div
        className="side-chat-transcript side-chat-recovery-transcript"
        ref={scroll}
        onScroll={(event) => {
          const element = event.currentTarget;
          follow.current =
            element.scrollHeight - element.clientHeight - element.scrollTop <
            90;
        }}
      >
        <div className="side-chat-messages">
          {!ready && !events.length && connected && !readError && (
            <WorkingStatus label="正在读取记录…" animated />
          )}
          {ready && !events.length && !readError && (
            <p className="ui-field-hint" style={{ margin: 0 }}>
              暂无侧边聊天记录。
            </p>
          )}
          <ImageGallery scope={`${hostId}:${sideId}`} active={connected}>
            <TurnTranscript events={events}>
              {(item) => {
                if (item.type === "user")
                  return (
                    <UserMessage
                      text={item.text}
                      at={item.at}
                      hostId={hostId}
                      projectId={session.project_id}
                      projectPath={project?.path}
                      sessionId={session.id}
                      connected={connected}
                      active
                    />
                  );
                if (item.type === "assistant")
                  return (
                    <article className="assistant">
                      <div className="markdown">
                        <MessageContent text={item.text} />
                      </div>
                    </article>
                  );
                if (item.type === "tool")
                  return (
                    <ToolRow
                      tool={item}
                      loadContext={{ hostId, sessionId: session.id }}
                    />
                  );
                if (item.type === "tools")
                  return (
                    <ToolGroup
                      tools={item.tools}
                      loadContext={{ hostId, sessionId: session.id }}
                    />
                  );
                if (item.type === "tool_images")
                  return <ToolImages images={item.images} active={connected} />;
                if (item.type !== "event") return null;
                const value = item.value;
                if (value.kind === "notice")
                  return <p className="notice">{value.text}</p>;
                if (
                  value.kind === "state" &&
                  (value.message || value.status === "unknown")
                )
                  return (
                    <p className="notice">
                      {value.message || "侧边聊天状态待确认"}
                    </p>
                  );
                if (value.kind === "approval")
                  return (
                    <ApprovalCard
                      request={value}
                      resolved={item.resolved}
                      decision={item.decision}
                      tool={item.approvalTool}
                      loadContext={{ hostId, sessionId: session.id }}
                      disabled={!connected || busy || !running}
                      busy={busy}
                      onDecision={(allow) =>
                        void perform({
                          method: "approve",
                          session_id: session.id,
                          request_id: value.request_id,
                          allow,
                        })
                      }
                    />
                  );
                if (value.kind === "question")
                  return (
                    <QuestionCard
                      request={value}
                      resolved={item.resolved}
                      answers={item.answers}
                      disabled={!connected || busy || !running}
                      onAnswer={(answers) =>
                        void perform({
                          method: "answer_question",
                          session_id: session.id,
                          request_id: value.request_id,
                          answers,
                        })
                      }
                    />
                  );
                return null;
              }}
            </TurnTranscript>
          </ImageGallery>
          {status && (
            <WorkingStatus label={status} animated={connected && running} />
          )}
        </div>
      </div>

      <div
        className="side-chat-recovery-footer"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2)",
        }}
      >
        {running && (
          <NoticeBanner
            tone="warning"
            action={
              <Button
                size="xs"
                variant="subtle"
                disabled={!connected || busy}
                onClick={() =>
                  void perform({ method: "cancel", session_id: sideId })
                }
              >
                停止运行
              </Button>
            }
          >
            侧边聊天仍在运行，请等待完成或停止运行后再确认写入结束。
          </NoticeBanner>
        )}
        {needsRuntimeClose && (
          <NoticeBanner
            tone="warning"
            action={
              <Button
                size="xs"
                variant="subtle"
                disabled={!connected || busy || !!session.agent_session_busy}
                onClick={() =>
                  void perform({
                    method: "close_agent_session",
                    session_id: sideId,
                    only_if_idle: false,
                  })
                }
              >
                关闭原生会话
              </Button>
            }
          >
            原生会话仍由 Server 管理，请先关闭后再核对关闭状态。
          </NoticeBanner>
        )}
        {pendingToken && (
          <NoticeBanner
            tone="warning"
            action={
              <div style={{ display: "inline-flex", gap: "var(--space-2)" }}>
                {showingConfirmation && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setConfirming(undefined)}
                  >
                    取消
                  </Button>
                )}
                <Button
                  size="xs"
                  variant="subtle"
                  disabled={
                    !connected ||
                    !ready ||
                    busy ||
                    (!!closePending && !!session.agent_session_busy)
                  }
                  onClick={() =>
                    showingConfirmation
                      ? confirmEnd()
                      : setConfirming(pendingToken)
                  }
                >
                  {showingConfirmation
                    ? "我已核对，确认结束"
                    : closePending
                      ? "核对原生会话关闭"
                      : "核对后台写入已结束"}
                </Button>
              </div>
            }
          >
            {closePending
              ? showingConfirmation
                ? "请核对主机上的原生进程、后台任务和外部工具均已停止。"
                : "原生会话关闭待确认。"
              : showingConfirmation
                ? "请核对侧边聊天启动的后台进程和外部工具均已停止写入工作区。"
                : "侧边聊天后台写入待确认。"}
          </NoticeBanner>
        )}
        {reconciled && (
          <NoticeBanner tone="success">
            后台写入已确认结束，关闭此窗口后可继续原操作。
          </NoticeBanner>
        )}
        {noPendingProjected && (
          <NoticeBanner tone="neutral">
            当前侧边聊天未返回待确认的写入状态；若原操作仍受阻，请更新主机
            Server 后重试。
          </NoticeBanner>
        )}
        {(!connected || readError || error) && (
          <NoticeBanner
            tone="danger"
            action={
              connected && readError ? (
                <Button
                  size="xs"
                  variant="subtle"
                  disabled={busy}
                  onClick={() => refresh((value) => value + 1)}
                >
                  重新读取
                </Button>
              ) : undefined
            }
          >
            {!connected ? "主机已断开，请在重连后核对记录" : readError || error}
          </NoticeBanner>
        )}
      </div>
    </Dialog>
  );
}
