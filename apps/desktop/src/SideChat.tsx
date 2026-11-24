import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Quote, X } from "lucide-react";
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
import { settledSideChatTitle } from "./SideChatHistory";
import { TurnTranscript } from "./TurnTranscript";
import { ToolGroup, ToolRow } from "./ToolActivity";
import { ToolImages } from "./ToolImages";
import { TurnErrorRow } from "./TurnErrorRow";
import { UserMessage } from "./UserMessage";
import { WorkingStatus } from "./WorkingStatus";
import { executionStatus } from "./executionStatus";
import type { Effort, Event, Request, Session } from "./protocol";
import {
  clearSideWriteConfirmation,
  useSideWriteConfirmationRequested,
} from "./sideWritePrompts";
import { LIVE_POLL_MS } from "./usePollingSnapshot";
import {
  readWorkspace,
  setSideChatDraft,
  setSideChatTitle,
  sideChatId,
} from "./workspaceState";
import { Button } from "./ui";

const FOLLOW_THRESHOLD = 90;
const SIDE_TITLE_SETTLE_MS = 2500;
const MAX_READING_POSITIONS = 64;

type CachedSideChat = {
  hostId: string;
  serverId?: string;
  session: Session;
  events: Event[];
  after: number;
  ready: boolean;
  size: number;
};

class SideChatTranscriptCache {
  private entries = new Map<string, CachedSideChat>();
  private totalSize = 0;
  constructor(
    private maxEntries = 24,
    private maxSize = 16 * 1024 * 1024,
  ) {}
  get(key: string, hostId: string, serverId?: string) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (serverId && entry.serverId && entry.serverId !== serverId) {
      this.clearHost(hostId, serverId);
      return undefined;
    }
    const updated =
      serverId && entry.serverId !== serverId ? { ...entry, serverId } : entry;
    this.entries.delete(key);
    this.entries.set(key, updated);
    return updated;
  }
  set(key: string, value: Omit<CachedSideChat, "size">) {
    const previous = this.entries.get(key);
    if (
      previous?.session === value.session &&
      previous.events === value.events &&
      previous.after === value.after &&
      previous.ready === value.ready &&
      previous.serverId === value.serverId
    ) {
      return;
    }
    this.totalSize -= previous?.size ?? 0;
    this.entries.delete(key);
    const size = JSON.stringify(value.events).length * 2;
    if (size > this.maxSize) return;
    this.entries.set(key, { ...value, size });
    this.totalSize += size;
    while (
      this.entries.size > this.maxEntries ||
      this.totalSize > this.maxSize
    ) {
      const oldest = this.entries.keys().next().value!;
      this.totalSize -= this.entries.get(oldest)!.size;
      this.entries.delete(oldest);
    }
  }
  delete(key: string) {
    const previous = this.entries.get(key);
    if (!previous) return;
    this.totalSize -= previous.size;
    this.entries.delete(key);
  }
  clearHost(hostId: string, keepServerId?: string) {
    for (const [key, entry] of this.entries) {
      if (
        entry.hostId === hostId &&
        (!keepServerId || (entry.serverId && entry.serverId !== keepServerId))
      ) {
        this.totalSize -= entry.size;
        this.entries.delete(key);
      }
    }
  }
}

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
const caches = new WeakMap<DraftStore, SideChatTranscriptCache>();
const readingPositions = new WeakMap<
  DraftStore,
  Map<string, { top: number; follow: boolean }>
>();

function sideCache(drafts: DraftStore) {
  let cache = caches.get(drafts);
  if (!cache) {
    cache = new SideChatTranscriptCache();
    caches.set(drafts, cache);
  }
  return cache;
}

function sidePositions(drafts: DraftStore) {
  let map = readingPositions.get(drafts);
  if (!map) {
    map = new Map();
    readingPositions.set(drafts, map);
  }
  return map;
}

function setSidePosition(
  drafts: DraftStore,
  key: string,
  value: { top: number; follow: boolean },
) {
  const map = sidePositions(drafts);
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_READING_POSITIONS) {
    map.delete(map.keys().next().value!);
  }
}

function initialPromptPrefix(events: Event[]) {
  const firstUser = events.find((entry) => entry.event.kind === "user")?.event;
  if (firstUser?.kind !== "user") return undefined;
  const line =
    firstUser.text
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => item.length > 0 && !item.startsWith(">")) ??
    firstUser.text.trim();
  return [...line].slice(0, 48).join("");
}

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
    sidePositions(drafts).delete(key);
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
  serverId,
  projectPath,
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
  serverId?: string;
  projectPath?: string;
  drafts: DraftStore;
  active: boolean;
  connected: boolean;
  supported: boolean;
  supportsInheritPermission?: boolean;
}) {
  const key = sideDraftKey(hostId, parent.id, sideId);
  const draft = useDraft(drafts, key);
  const cached = isDraft
    ? undefined
    : sideCache(drafts).get(key, hostId, serverId);
  const [session, setSession] = useState<Session | undefined>(
    () => cached?.session,
  );
  const [events, setEvents] = useState<Event[]>(() => cached?.events ?? []);
  const eventsRef = useRef(events);
  eventsRef.current = events;
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
  const [ready, setReady] = useState(() => cached?.ready ?? false);
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
  const savedPosition = sidePositions(drafts).get(key);
  const follow = useRef(savedPosition?.follow ?? true);
  const [away, setAway] = useState(() => !(savedPosition?.follow ?? true));
  const wasActive = useRef(false);
  const after = useRef(cached?.after ?? 0);
  const lastServerId = useRef(serverId);
  useEffect(() => {
    if (serverId && lastServerId.current && lastServerId.current !== serverId) {
      sideCache(drafts).clearHost(hostId, serverId);
      after.current = 0;
      eventsRef.current = [];
      setEvents([]);
      setSession(undefined);
      setReady(false);
    }
    if (serverId) lastServerId.current = serverId;
  }, [drafts, hostId, serverId]);
  const enabled = active && connected && supported;
  useEffect(() => {
    if (!enabled) return;
    setFocus((v) => v + 1);
  }, [enabled]);

  useEffect(() => {
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
        let nextEvents = eventsRef.current;
        if (page.events.length) {
          const next = page.events.at(-1)!.seq;
          if (
            next <= after.current ||
            page.events.some((e) => e.session_id !== sideId)
          )
            throw new Error("侧边聊天记录游标无效");
          after.current = next;
          nextEvents = [...eventsRef.current, ...page.events];
          eventsRef.current = nextEvents;
          setEvents(nextEvents);
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
        const nextReady = !page.has_more;
        setSession(page.session);
        setReady(nextReady);
        sideCache(drafts).set(key, {
          hostId,
          serverId,
          session: page.session,
          events: nextEvents,
          after: after.current,
          ready: nextReady,
        });
        setReadError("");
        timer = setTimeout(read, page.has_more ? 0 : LIVE_POLL_MS);
      } catch (cause) {
        if (!disposed) {
          if (missingSession(cause)) {
            after.current = 0;
            eventsRef.current = [];
            sideCache(drafts).delete(key);
            sidePositions(drafts).delete(key);
            setSession(undefined);
            setEvents([]);
            setReady(false);
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
    serverId,
    parent.id,
    parent.project_id,
    sideId,
    workspaceId,
    isDraft,
    revision,
    drafts,
    key,
  ]);

  const hasCompletedTurn = useMemo(
    () =>
      events.some(
        (entry) =>
          entry.event.kind === "state" && entry.event.status === "completed",
      ),
    [events],
  );
  const hasTitleFailureNotice = useMemo(
    () =>
      events.some(
        (entry) =>
          entry.event.kind === "notice" &&
          entry.event.text.startsWith("会话自动命名"),
      ),
    [events],
  );
  useEffect(() => {
    if (isDraft || !session) return;
    const candidate = settledSideChatTitle(session, hasCompletedTurn);
    if (!candidate) return;
    const prefix = initialPromptPrefix(events);
    const awaitingGenerated =
      session.title_requested &&
      !session.custom_title &&
      session.agent_session_open !== false &&
      !hasTitleFailureNotice &&
      prefix !== undefined &&
      candidate === prefix;
    if (!awaitingGenerated) {
      setSideChatTitle(workspaceId, sideId, candidate);
      return;
    }
    const timer = setTimeout(() => {
      setSideChatTitle(workspaceId, sideId, candidate);
    }, SIDE_TITLE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [
    isDraft,
    session,
    events,
    hasCompletedTurn,
    hasTitleFailureNotice,
    workspaceId,
    sideId,
  ]);

  useLayoutEffect(() => {
    const el = scroll.current;
    if (!active) {
      wasActive.current = false;
      return;
    }
    if (!el) return;
    const syncScroll = () => {
      if (follow.current) {
        el.scrollTop = el.scrollHeight;
      } else if (!wasActive.current) {
        const saved = sidePositions(drafts).get(key);
        if (saved) el.scrollTop = saved.top;
      }
    };
    syncScroll();
    wasActive.current = true;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (follow.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    const content = el.querySelector(".side-chat-messages");
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [active, events, session?.status, drafts, key]);

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
        if (response.kind === "session") {
          setSession(response.session);
          sideCache(drafts).set(key, {
            hostId,
            serverId,
            session: response.session,
            events: eventsRef.current,
            after: after.current,
            ready,
          });
        }
        accepted?.();
        if (!session) setReady(false);
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
        projectPath,
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
    setAway(false);
    setSidePosition(drafts, key, {
      top: scroll.current?.scrollHeight ?? 0,
      follow: true,
    });
    return perform(send, () => {
      drafts.clear(key, draft);
      if (requests.get(key)?.request.request_id === send.request_id)
        requests.delete(key);
    });
  }
  const status = executionStatus(session, events, connected);
  return (
    <div className="side-chat">
      <div className="side-chat-transcript-wrap">
        <div
          className="side-chat-transcript"
          ref={scroll}
          onScroll={(e) => {
            const el = e.currentTarget;
            if (!active || !el.clientHeight) return;
            const nextFollow =
              el.scrollHeight - el.clientHeight - el.scrollTop <
              FOLLOW_THRESHOLD;
            follow.current = nextFollow;
            setSidePosition(drafts, key, {
              top: el.scrollTop,
              follow: nextFollow,
            });
            setAway(!nextFollow);
          }}
        >
          <div className="side-chat-messages">
            {!isDraft && !ready && !events.length && enabled && !readError && (
              <WorkingStatus label="正在读取记录…" animated />
            )}
            <TurnTranscript key={key} events={events}>
              {(item) => {
                if (item.type === "user")
                  return (
                    <UserMessage
                      text={item.text}
                      at={item.at}
                      hostId={hostId}
                      projectId={parent.project_id}
                      projectPath={projectPath}
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
                      projectPath={projectPath}
                      loadContext={
                        session ? { hostId, sessionId: session.id } : undefined
                      }
                    />
                  );
                if (item.type === "tools")
                  return (
                    <ToolGroup
                      tools={item.tools}
                      unrecovered={item.unrecovered}
                      projectPath={projectPath}
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
                if (v.kind === "state" && v.status === "failed" && v.message)
                  return <TurnErrorRow message={v.message} />;
                if (v.kind === "state" && (v.message || v.status === "unknown"))
                  return (
                    <p className="notice">
                      {v.message || "侧边聊天状态待确认"}
                    </p>
                  );
                if (v.kind === "approval" && session)
                  return (
                    <ApprovalCard
                      request={v}
                      resolved={item.resolved}
                      decision={item.decision}
                      tool={item.approvalTool}
                      projectPath={projectPath}
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
        {away && (
          <button
            type="button"
            className="return-latest"
            aria-label="回到最新"
            title="回到最新"
            onClick={() => {
              follow.current = true;
              setAway(false);
              const el = scroll.current;
              if (el) {
                setSidePosition(drafts, key, {
                  top: el.scrollHeight,
                  follow: true,
                });
                el.scrollTop = el.scrollHeight;
                el.scrollTo?.({ top: el.scrollHeight });
              }
            }}
          >
            <ArrowDown size={15} />
            <span>回到最新</span>
          </button>
        )}
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
              <Button
                variant="subtle"
                size="xs"
                onClick={() => setConfirming(undefined)}
              >
                取消
              </Button>
            )}
            <Button
              variant="subtle"
              size="xs"
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
            </Button>
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
              <Button
                variant="subtle"
                size="xs"
                onClick={() => refresh((v) => v + 1)}
              >
                重新读取
              </Button>
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
          projectPath={projectPath}
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
                projectPath={projectPath}
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
