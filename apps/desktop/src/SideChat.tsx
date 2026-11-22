import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Quote, X } from "lucide-react";
import { ApprovalCard } from "./ApprovalCard";
import { Composer } from "./Composer";
import { ComposerAction } from "./ComposerAction";
import { ModelPicker, type ModelPickerHandle } from "./ModelPicker";
import { modelSelectionScope } from "./modelSelectionScope";
import { PermissionPicker } from "./PermissionPicker";
import { message, request, ServerRequestError } from "./api";
import { DraftStore, useDraft, type Draft } from "./drafts";
import { AnnotatedMessage, AnnotationSummary } from "./AnnotationUI";
import { annotationError, type Annotation } from "./annotations";
import { QuestionCard } from "./QuestionCard";
import { TurnTranscript } from "./TurnTranscript";
import { ToolGroup, ToolRow } from "./ToolActivity";
import { ToolImages } from "./ToolImages";
import { UserMessage } from "./UserMessage";
import { WorkingStatus } from "./WorkingStatus";
import { executionStatus } from "./executionStatus";
import type { Effort, Event, Request, Session } from "./protocol";
import {
  clearSideWriteConfirmation,
  useSideWriteConfirmationRequested,
} from "./sideWritePrompts";
import { LIVE_POLL_MS } from "./usePollingSnapshot";
import { readWorkspace, setSideChatDraft, sideChatId } from "./workspaceState";

export const sideDraftKey = (host: string, parent: string, side: string) =>
  JSON.stringify(["side", host, parent, side]);

type Send = Extract<Request, { method: "send" }>;

// A transport failure can outlive the tab. Keep the ID for the exact draft
// in memory so a manual retry reconciles the original admission.
const admissions = new WeakMap<
  DraftStore,
  Map<string, { draft: Draft; request: Send }>
>();
const operations = new WeakMap<DraftStore, Map<string, Promise<unknown>>>();
type Selection = {
  model: string | null;
  effort: Effort | null;
  permission: string | null;
};
// Workspace navigation unmounts side views. Keep unsent settings for the same
// App lifetime and owner as the draft, without changing its admission version.
const selections = new WeakMap<DraftStore, Map<string, Selection>>();

function sideOperations(drafts: DraftStore) {
  let pending = operations.get(drafts);
  if (!pending) {
    pending = new Map();
    operations.set(drafts, pending);
  }
  return pending;
}

function missingSession(error: unknown) {
  return (
    error instanceof ServerRequestError &&
    error.code === "request_failed" &&
    error.message === "会话不存在"
  );
}

export async function closeSideChat(
  drafts: DraftStore,
  hostId: string,
  parentId: string,
  workspaceId: string,
  id: string,
) {
  const sideId = sideChatId(id);
  if (!sideId || sideId === parentId) throw new Error("侧边聊天 ID 无效");
  const key = sideDraftKey(hostId, parentId, sideId);
  const pending = sideOperations(drafts);
  const previous = pending.get(key);
  const closing = (async () => {
    await previous;
    const tab = readWorkspace(workspaceId).tabs.find((tab) => tab.id === id);
    if (tab?.kind !== "sideChat") return;
    if (!tab.draft) {
      try {
        const result = await request(hostId, {
          method: "close_agent_session",
          session_id: sideId,
          only_if_idle: false,
        });
        if (result.kind !== "ok" && result.kind !== "side_chat_closed")
          throw new Error("无法确认侧边聊天已关闭");
      } catch (cause) {
        if (!missingSession(cause)) throw cause;
      }
    }
    drafts.clear(key, drafts.get(key));
    admissions.get(drafts)?.delete(key);
    selections.get(drafts)?.delete(key);
  })();
  pending.set(key, closing);
  try {
    return await closing;
  } finally {
    if (pending.get(key) === closing) pending.delete(key);
  }
}

export function SideChat({
  parent,
  sideId,
  workspaceId,
  isDraft = false,
  hostId,
  drafts,
  active,
  connected,
  supported,
  supportsInheritPermission = true,
}: {
  parent: Session;
  sideId: string;
  workspaceId: string;
  isDraft?: boolean;
  hostId: string;
  drafts: DraftStore;
  active: boolean;
  connected: boolean;
  supported: boolean;
  supportsInheritPermission?: boolean;
}) {
  const key = sideDraftKey(hostId, parent.id, sideId);
  const draft = useDraft(drafts, key);
  const [session, setSession] = useState<Session>();
  const [events, setEvents] = useState<Event[]>([]);
  const [readError, setReadError] = useState("");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<string>();
  const writeConfirmRequested = useSideWriteConfirmationRequested(
    hostId,
    sideId,
  );
  const closePending = session?.agent_close_pending;
  const sideWritePending =
    !closePending &&
    session?.side_write_pending &&
    (session.status === "unknown" || writeConfirmRequested)
      ? session.side_write_pending
      : undefined;
  const pendingToken = closePending
    ? `close:${closePending}`
    : sideWritePending
      ? `write:${sideWritePending}`
      : undefined;
  const showingConfirmation = !!confirming && confirming === pendingToken;
  useEffect(() => {
    if (session && !session.side_write_pending && writeConfirmRequested) {
      clearSideWriteConfirmation(hostId, sideId);
    }
  }, [hostId, sideId, session, writeConfirmRequested]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revision, refresh] = useState(0);
  const picker = useRef<ModelPickerHandle>(null);
  const [focus, setFocus] = useState(0);
  const [selection, updateSelection] = useState<Selection | undefined>(() =>
    selections.get(drafts)?.get(key),
  );
  function setSelection(value: Selection) {
    let saved = selections.get(drafts);
    if (!saved) {
      saved = new Map();
      selections.set(drafts, saved);
    }
    saved.set(key, value);
    updateSelection(value);
  }
  const [modelReadiness, setModelReadiness] = useState<{
    scope: string;
    ready: boolean;
  }>();
  const model = selection
    ? selection.model
    : ((session ?? parent).model ?? null);
  const effort = selection
    ? selection.effort
    : ((session ?? parent).effort ?? null);
  const hadDraft = useRef(isDraft);
  if (isDraft) hadDraft.current = true;
  if (session) hadDraft.current = false;
  const rawPermission = selection
    ? selection.permission
    : session
      ? (session.permission_mode ?? null)
      : hadDraft.current
        ? (parent.permission_mode ??
          (supportsInheritPermission ? "inherit" : null))
        : null;
  const permission =
    !session && !supportsInheritPermission && rawPermission === "inherit"
      ? null
      : rawPermission;
  const quotes = draft.quotes ?? [];
  const annotations = draft.annotations ?? [];
  function saveAnnotation(entry: Annotation) {
    const existing = drafts.get(key).annotations ?? [];
    const next = existing.some((item) => item.id === entry.id)
      ? existing.map((item) => (item.id === entry.id ? entry : item))
      : [...existing, entry];
    const error = annotationError(next);
    if (error) return error;
    drafts.update(key, { annotations: next });
    return null;
  }
  function removeAnnotation(id: string) {
    drafts.update(key, {
      annotations: (drafts.get(key).annotations ?? []).filter(
        (entry) => entry.id !== id,
      ),
    });
  }
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const after = useRef(0);
  const enabled = active && connected && supported;
  useEffect(() => {
    if (!enabled) return;
    setFocus((v) => v + 1);
  }, [enabled]);

  useEffect(() => {
    setReady(false);
    if (!enabled || busy || isDraft) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        await sideOperations(drafts).get(key);
        if (disposed) return;
        const page = await request(hostId, {
          method: "poll",
          session_id: sideId,
          after: after.current,
        });
        if (disposed) return;
        if (
          page.kind !== "events" ||
          page.session.id !== sideId ||
          page.session.id === parent.id ||
          page.session.project_id !== parent.project_id ||
          (page.session.parent_session_id !== undefined &&
            page.session.parent_session_id !== parent.id)
        )
          throw new Error("侧边聊天记录不匹配");
        if (page.has_more && !page.events.length)
          throw new Error("侧边聊天记录分页未前进");
        if (page.events.length) {
          const next = page.events.at(-1)!.seq;
          if (
            next <= after.current ||
            page.events.some((e) => e.session_id !== sideId)
          )
            throw new Error("侧边聊天记录游标无效");
          after.current = next;
          setEvents((previous) => [...previous, ...page.events]);
          const pending = admissions.get(drafts)?.get(key);
          if (
            pending &&
            page.events.some(
              ({ event }) =>
                event.kind === "user" &&
                event.request_id === pending.request.request_id,
            )
          ) {
            drafts.clear(key, pending.draft);
            admissions.get(drafts)?.delete(key);
            setError("");
          }
        }
        setSession(page.session);
        setReady(!page.has_more);
        setReadError("");
        timer = setTimeout(read, page.has_more ? 0 : LIVE_POLL_MS);
      } catch (cause) {
        if (!disposed) {
          if (missingSession(cause)) {
            after.current = 0;
            setSession(undefined);
            setEvents([]);
            setSideChatDraft(workspaceId, sideId, true);
            setReadError("");
            return;
          }
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
  }, [
    enabled,
    busy,
    hostId,
    parent.id,
    parent.project_id,
    sideId,
    workspaceId,
    isDraft,
    revision,
    drafts,
    key,
  ]);

  useLayoutEffect(() => {
    if (active && follow.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [active, events, session?.status]);

  const canInteract = enabled && (ready || isDraft);
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
        () => {
          if (!session?.side_write_pending) {
            clearSideWriteConfirmation(hostId, sideId);
          }
        },
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
        () => clearSideWriteConfirmation(hostId, sideId),
      );
    }
  }
  function perform(action: Request, accepted?: () => void) {
    const pending = sideOperations(drafts);
    if (!canInteract || pending.has(key)) return Promise.resolve(false);
    setBusy(true);
    setError("");
    const operation = Promise.resolve().then(async () => {
      try {
        if (action.method === "send" && isDraft) {
          // Persist that creation was attempted so reconnect can check the same ID.
          setSideChatDraft(workspaceId, sideId, false);
          const opened = await request(hostId, {
            method: "open_side_chat",
            session_id: parent.id,
            side_id: sideId,
          });
          if (
            opened.kind !== "session" ||
            opened.session.id !== sideId ||
            opened.session.id === parent.id ||
            opened.session.project_id !== parent.project_id
          )
            throw new Error("Server 未返回独立的侧边聊天");
        }
        const response = await request(hostId, action);
        const expected =
          action.method === "send"
            ? "accepted"
            : action.method === "confirm_agent_closed" ||
                action.method === "confirm_side_writes_ended"
              ? "session"
              : "ok";
        if (response.kind !== expected)
          throw new Error("操作结果待确认，请核对侧边聊天的记录");
        if (response.kind === "session") setSession(response.session);
        accepted?.();
        setReady(false);
        refresh((v) => v + 1);
        return true;
      } catch (cause) {
        if (
          action.method === "send" &&
          cause instanceof ServerRequestError &&
          cause.code !== "admission_unknown" &&
          // Older Servers expose actor receipt timeouts as request_failed.
          !(
            cause.code === "request_failed" &&
            /会话接收超时|会话接收结果待确认/.test(cause.message)
          )
        ) {
          const pending = admissions.get(drafts)?.get(key);
          if (pending?.request.request_id === action.request_id)
            admissions.get(drafts)?.delete(key);
        }
        setError(message(cause));
        return false;
      } finally {
        if (pending.get(key) === operation) pending.delete(key);
        setBusy(false);
      }
    });
    pending.set(key, operation);
    return operation;
  }
  const running =
    session?.status === "running" || session?.status === "waiting";
  const disabled = !canInteract || busy || parent.archived;
  const modelReady =
    modelReadiness?.scope ===
      modelSelectionScope(
        hostId,
        parent.project_id,
        parent.agent,
        model,
        effort,
      ) && modelReadiness.ready;
  function submit(prompt: string) {
    if (
      (!prompt.trim() && !quotes.length) ||
      disabled ||
      sideOperations(drafts).has(key) ||
      running ||
      !modelReady
    )
      return Promise.resolve(false);
    if (draft.text.trimStart().startsWith("/")) {
      setError("侧边聊天暂不支持 Agent 原生命令，请输入普通消息。");
      return Promise.resolve(false);
    }
    let requests = admissions.get(drafts);
    if (!requests) {
      requests = new Map();
      admissions.set(drafts, requests);
    }
    const old = requests.get(key);
    if (
      old &&
      drafts.isCurrent(key, old.draft) &&
      (old.request.model !== model ||
        old.request.effort !== effort ||
        old.request.permission_mode !== permission)
    ) {
      setError(
        "上次发送结果待确认。请恢复上次的模型和权限选择后重试，或编辑问题后再发送。",
      );
      return Promise.resolve(false);
    }
    const send: Send =
      old && drafts.isCurrent(key, old.draft)
        ? old.request
        : {
            method: "send",
            session_id: sideId,
            request_id: crypto.randomUUID(),
            text: [
              ...quotes.map((quote) =>
                quote
                  .split("\n")
                  .map((line) => `> ${line}`)
                  .join("\n"),
              ),
              prompt || "请结合主会话解释引用的文本。",
            ].join("\n\n"),
            model,
            effort,
            permission_mode: permission,
          };
    // Include quoted side-chat context before creating a first-use session or
    // recording an admission. The Composer has only checked its own prompt.
    if (new TextEncoder().encode(send.text).length > 128 * 1024) {
      setError("消息、引用文本与注释总内容过长，请缩短后再发送。");
      return Promise.resolve(false);
    }
    requests.set(key, { draft, request: send });
    follow.current = true;
    return perform(send, () => {
      drafts.clear(key, draft);
      if (requests.get(key)?.request.request_id === send.request_id)
        requests.delete(key);
    });
  }
  const status = executionStatus(session, events, connected);
  return (
    <div className="side-chat">
      <div
        className="side-chat-transcript"
        ref={scroll}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current =
            el.scrollHeight - el.clientHeight - el.scrollTop < 90;
        }}
      >
        <div className="side-chat-messages">
          {!isDraft && !ready && !events.length && enabled && !readError && (
            <WorkingStatus label="正在读取记录…" animated />
          )}
          <TurnTranscript events={events}>
            {(item) => {
              if (item.type === "user")
                return (
                  <UserMessage
                    text={item.text}
                    at={item.at}
                    hostId={hostId}
                    projectId={parent.project_id}
                    sessionId={session?.id}
                    connected={connected}
                    active={active}
                  />
                );
              if (item.type === "assistant")
                return (
                  <AnnotatedMessage
                    key={`${key}:${item.key}`}
                    text={item.text}
                    message={item.key}
                    entries={annotations}
                    enabled={active && !busy && !parent.archived}
                    onSave={saveAnnotation}
                    onRemove={removeAnnotation}
                  />
                );
              if (item.type === "tool")
                return (
                  <ToolRow
                    tool={item}
                    loadContext={
                      session ? { hostId, sessionId: session.id } : undefined
                    }
                  />
                );
              if (item.type === "tools")
                return (
                  <ToolGroup
                    tools={item.tools}
                    loadContext={
                      session ? { hostId, sessionId: session.id } : undefined
                    }
                  />
                );
              if (item.type === "tool_images")
                return <ToolImages images={item.images} active={enabled} />;
              if (item.type !== "event") return null;
              const v = item.value;
              if (v.kind === "notice")
                return <p className="notice">{v.text}</p>;
              if (v.kind === "state" && (v.message || v.status === "unknown"))
                return (
                  <p className="notice">{v.message || "侧边聊天状态待确认"}</p>
                );
              if (v.kind === "approval" && session)
                return (
                  <ApprovalCard
                    request={v}
                    resolved={item.resolved}
                    decision={item.decision}
                    tool={item.approvalTool}
                    loadContext={{ hostId, sessionId: session.id }}
                    disabled={disabled || !running}
                    busy={busy}
                    onDecision={(allow) =>
                      void perform({
                        method: "approve",
                        session_id: session.id,
                        request_id: v.request_id,
                        allow,
                      })
                    }
                  />
                );
              if (v.kind === "question" && session)
                return (
                  <QuestionCard
                    request={v}
                    resolved={item.resolved}
                    answers={item.answers}
                    disabled={disabled || !running}
                    onAnswer={(answers) =>
                      void perform({
                        method: "answer_question",
                        session_id: session.id,
                        request_id: v.request_id,
                        answers,
                      })
                    }
                  />
                );
              return null;
            }}
          </TurnTranscript>
          {status && (
            <WorkingStatus label={status} animated={enabled && running} />
          )}
        </div>
      </div>
      <div className="side-chat-compose">
        {pendingToken && !running && (
          <div className="notice" role="status">
            {closePending
              ? showingConfirmation
                ? "请核对主机上的原生进程、后台任务和外部工具均已停止。"
                : "原生会话关闭待确认。"
              : showingConfirmation
                ? "请核对侧边聊天启动的后台进程和外部工具均已停止写入工作区。"
                : "侧边聊天后台写入待确认。"}
            {showingConfirmation && (
              <button
                className="secondary small"
                onClick={() => setConfirming(undefined)}
              >
                取消
              </button>
            )}
            <button
              className="secondary small"
              disabled={
                !canInteract ||
                busy ||
                (!!closePending && !!session?.agent_session_busy)
              }
              onClick={() =>
                showingConfirmation ? confirmEnd() : setConfirming(pendingToken)
              }
            >
              {showingConfirmation
                ? "我已核对，确认结束"
                : closePending
                  ? "核对原生会话关闭"
                  : "核对后台写入已结束"}
            </button>
          </div>
        )}
        {(!connected || !supported || readError || error) && (
          <div role="alert" className="notice">
            {!connected
              ? "主机已断开，请在重连后核对记录"
              : !supported
                ? "请更新执行主机的 Server 以使用侧边聊天"
                : readError || error}
            {enabled && readError && (
              <button
                className="secondary small"
                onClick={() => refresh((v) => v + 1)}
              >
                重新读取
              </button>
            )}
          </div>
        )}
        <Composer
          focusRequest={focus}
          inputLabel="侧边聊天输入"
          hasContext={quotes.length > 0 || annotations.length > 0}
          annotations={annotations}
          sideChat
          context={
            <>
              <AnnotationSummary
                entries={annotations}
                onSave={saveAnnotation}
                onRemove={removeAnnotation}
                onClear={() => drafts.update(key, { annotations: [] })}
                onFocusComposer={() => setFocus((value) => value + 1)}
                disabled={busy || parent.archived}
                active={active}
              />
              {quotes.length > 0 && (
                <div
                  className="composer-references side-chat-quotes"
                  aria-label="引用的文本片段"
                >
                  {quotes.map((quote, index) => (
                    <span key={index}>
                      <details>
                        <summary>
                          <Quote size={14} /> 文本片段
                          {quotes.length > 1 ? ` ${index + 1}` : ""}
                        </summary>
                        <p>{quote}</p>
                      </details>
                      <button
                        aria-label={`移除文本片段 ${index + 1}`}
                        disabled={busy}
                        onClick={() =>
                          drafts.update(key, {
                            quotes: quotes.filter((_, i) => i !== index),
                          })
                        }
                      >
                        <X size={13} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </>
          }
          referenceState={draft.references}
          onReferencesChange={(references) =>
            drafts.update(key, { references })
          }
          agent={parent.agent}
          hostId={hostId}
          projectId={parent.project_id}
          sessionId={session?.id}
          connected={connected}
          hidden={!active}
          disabled={parent.archived}
          sending={busy}
          value={draft.text}
          onChange={(text) => drafts.update(key, { text })}
          onSubmit={submit}
          onOpenModelSettings={(target, isCurrent) =>
            picker.current?.openMenu(target, isCurrent) ?? null
          }
          placeholder="在侧边聊天中提问…"
          toolbar={(send, hasContent, navigation) => (
            <>
              <PermissionPicker
                hostId={hostId}
                agent={parent.agent}
                connected={connected}
                hidden={!active || (!isDraft && !session)}
                value={permission}
                onChange={(permission) =>
                  setSelection({ model, effort, permission })
                }
                disabled={disabled || running || (!isDraft && !session)}
                sideChat
                allowInherit={supportsInheritPermission}
              />
              <ModelPicker
                ref={picker}
                onReadyChange={setModelReadiness}
                hostId={hostId}
                projectId={parent.project_id}
                agent={parent.agent}
                conversationKey={key}
                connected={connected}
                settingsOpen={!active || (!isDraft && !session)}
                preserveUnavailableModel
                value={model}
                onChange={(model) =>
                  setSelection({ model, effort, permission })
                }
                onProviderFallback={(model) =>
                  setSelection({ model, effort, permission })
                }
                effort={effort}
                onEffortChange={(effort) =>
                  setSelection({ model, effort, permission })
                }
                onEffortInvalid={() =>
                  setSelection({ model, effort: null, permission })
                }
                disabled={disabled || running || (!isDraft && !session)}
              />
              <ComposerAction
                active={running}
                label={running ? "停止侧边聊天" : "发送侧边聊天消息"}
                sending={busy}
                disabled={
                  disabled ||
                  (!running && (!hasContent || (!navigation && !modelReady)))
                }
                onClick={
                  running && session
                    ? () =>
                        void perform({
                          method: "cancel",
                          session_id: session.id,
                        })
                    : send
                }
              />
            </>
          )}
        />
      </div>
    </div>
  );
}
