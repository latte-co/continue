import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Quote, X } from "lucide-react";
import { ApprovalCard } from "./ApprovalCard";
import { Composer } from "./Composer";
import { ComposerAction } from "./ComposerAction";
import { leadingSlashCommand, referencePrompt } from "./composerActions";
import { referenceMessage } from "./referenceMessage";
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
  sideWriteConfirmationVersion,
  useSideWriteConfirmationVersion,
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
const SIDE_BG_TITLE_POLL_MS = 180000;
const MAX_READING_POSITIONS = 64;
const eventArraySizes = new WeakMap<Event[], number>();

function estimateEventsByteSize(events: Event[]): number {
  const cached = eventArraySizes.get(events);
  if (cached !== undefined) return cached;
  const size = JSON.stringify(events).length * 2;
  eventArraySizes.set(events, size);
  return size;
}

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
    const currentServerId = serverId || undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (currentServerId && entry.serverId !== currentServerId) {
      this.clearHost(hostId, currentServerId);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }
  set(key: string, value: Omit<CachedSideChat, "size">) {
    const previous = this.entries.get(key);
    const nextServerId = value.serverId || previous?.serverId || undefined;
    if (
      previous?.session === value.session &&
      previous.events === value.events &&
      previous.after === value.after &&
      previous.ready === value.ready &&
      previous.serverId === nextServerId
    ) {
      return;
    }
    const size =
      previous?.events === value.events
        ? previous.size
        : estimateEventsByteSize(value.events);
    this.totalSize -= previous?.size ?? 0;
    this.entries.delete(key);
    if (size > this.maxSize) return;
    this.entries.set(key, { ...value, serverId: nextServerId, size });
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
        (!keepServerId || entry.serverId !== keepServerId)
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

type SideChatComponentProps = {
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
  onStatusChange?: (status: Session["status"]) => void;
  addToMainChat?: (quote: string) => void;
};

export function SideChat(props: SideChatComponentProps) {
  const key = sideDraftKey(props.hostId, props.parent.id, props.sideId);
  return <SideChatPane key={key} {...props} draftKey={key} />;
}

function SideChatPane({
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
  onStatusChange,
  addToMainChat,
  draftKey: key,
}: SideChatComponentProps & { draftKey: string }) {
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  const lastPublishedStatus = useRef<Session["status"] | undefined>(undefined);
  function publishLiveStatus(nextStatus: Session["status"]) {
    if (lastPublishedStatus.current === nextStatus) return;
    lastPublishedStatus.current = nextStatus;
    onStatusChangeRef.current?.(nextStatus);
  }
  const draft = useDraft(drafts, key);
  const knownServerId = serverId || undefined;
  const [initial] = useState(() =>
    isDraft ? undefined : sideCache(drafts).get(key, hostId, knownServerId),
  );
  const [session, setSession] = useState<Session | undefined>(
    () => initial?.session,
  );
  const [events, setEvents] = useState<Event[]>(() => initial?.events ?? []);
  const [ready, setReady] = useState(() => initial?.ready ?? false);
  const after = useRef(initial?.after ?? 0);
  const lastServerId = useRef<string | undefined>(
    knownServerId ?? initial?.serverId,
  );
  const serverChanged = Boolean(
    knownServerId &&
    (lastServerId.current
      ? lastServerId.current !== knownServerId
      : after.current > 0 || session !== undefined),
  );
  const effectiveSession = serverChanged ? undefined : session;
  const effectiveEvents = serverChanged ? [] : events;
  const effectiveReady = serverChanged ? false : ready;
  const eventsRef = useRef(effectiveEvents);
  eventsRef.current = effectiveEvents;
  const [readError, setReadError] = useState("");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<string>();
  const writeConfirmVersion = useSideWriteConfirmationVersion(hostId, sideId);
  const writeConfirmRequested = writeConfirmVersion > 0;
  const closePending = effectiveSession?.agent_close_pending;
  const sideWritePending =
    !closePending &&
    effectiveSession?.side_write_pending &&
    (effectiveSession.status === "unknown" || writeConfirmRequested)
      ? effectiveSession.side_write_pending
      : undefined;
  const pendingToken = closePending
    ? `close:${closePending}`
    : sideWritePending
      ? `write:${sideWritePending}`
      : undefined;
  const showingConfirmation = !!confirming && confirming === pendingToken;
  const [busy, setBusy] = useState(false);
  const [revision, refresh] = useState(0);
  const lastConfirmVersion = useRef(writeConfirmVersion);
  useEffect(() => {
    if (
      writeConfirmVersion > 0 &&
      writeConfirmVersion !== lastConfirmVersion.current
    ) {
      refresh((v) => v + 1);
    }
    lastConfirmVersion.current = writeConfirmVersion;
  }, [writeConfirmVersion]);
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
    : ((effectiveSession ?? parent).model ?? null);
  const effort = selection
    ? selection.effort
    : ((effectiveSession ?? parent).effort ?? null);
  const hadDraft = useRef(isDraft);
  if (isDraft) hadDraft.current = true;
  if (effectiveSession) hadDraft.current = false;
  const rawPermission = selection
    ? selection.permission
    : effectiveSession
      ? (effectiveSession.permission_mode ?? null)
      : hadDraft.current
        ? (parent.permission_mode ??
          (supportsInheritPermission ? "inherit" : null))
        : null;
  const permission =
    !effectiveSession &&
    !supportsInheritPermission &&
    rawPermission === "inherit"
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
  const restoredPosition = useRef(false);
  const [titleSettleExpired, setTitleSettleExpired] = useState(false);
  const [bgTitlePollExpired, setBgTitlePollExpired] = useState(false);
  const [turnSubmitted, setTurnSubmitted] = useState(false);

  useEffect(() => {
    if (
      knownServerId &&
      (lastServerId.current
        ? lastServerId.current !== knownServerId
        : after.current > 0 || session !== undefined)
    ) {
      sideCache(drafts).clearHost(hostId, knownServerId);
      sidePositions(drafts).delete(key);
      follow.current = true;
      restoredPosition.current = false;
      setAway(false);
      setTitleSettleExpired(false);
      setBgTitlePollExpired(false);
      setTurnSubmitted(false);
      lastPublishedStatus.current = undefined;
      after.current = 0;
      eventsRef.current = [];
      setEvents([]);
      setSession(undefined);
      setReady(false);
      setReadError("");
    }
    if (knownServerId) {
      lastServerId.current = knownServerId;
    }
  }, [drafts, hostId, key, knownServerId, session]);

  const hasCompletedTurn = useMemo(
    () =>
      effectiveEvents.some(
        (entry) =>
          entry.event.kind === "state" && entry.event.status === "completed",
      ),
    [effectiveEvents],
  );
  const hasTitleFailureNotice = useMemo(
    () =>
      effectiveEvents.some(
        (entry) =>
          entry.event.kind === "notice" &&
          entry.event.text.startsWith("会话自动命名"),
      ),
    [effectiveEvents],
  );
  const promptPrefix = useMemo(
    () => initialPromptPrefix(effectiveEvents),
    [effectiveEvents],
  );
  const candidateTitle =
    !isDraft && effectiveSession
      ? settledSideChatTitle(effectiveSession, hasCompletedTurn)
      : undefined;
  const titleGenerationPending = Boolean(
    candidateTitle &&
    effectiveSession?.title_requested &&
    !effectiveSession.custom_title &&
    effectiveSession.agent_session_open !== false &&
    !hasTitleFailureNotice &&
    promptPrefix !== undefined &&
    candidateTitle === promptPrefix,
  );
  const awaitingGeneratedTitle = titleGenerationPending && !titleSettleExpired;
  const awaitingBackgroundTitle = titleGenerationPending && !bgTitlePollExpired;
  useEffect(() => {
    if (!awaitingGeneratedTitle) return;
    const timer = setTimeout(() => {
      setTitleSettleExpired(true);
    }, SIDE_TITLE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [awaitingGeneratedTitle, key]);

  useEffect(() => {
    if (!awaitingBackgroundTitle) return;
    const timer = setTimeout(() => {
      setBgTitlePollExpired(true);
    }, SIDE_BG_TITLE_POLL_MS);
    return () => clearTimeout(timer);
  }, [awaitingBackgroundTitle, key]);

  useEffect(() => {
    if (!candidateTitle || awaitingGeneratedTitle) return;
    setSideChatTitle(workspaceId, sideId, candidateTitle);
    if (turnSubmitted) setTurnSubmitted(false);
  }, [
    awaitingGeneratedTitle,
    candidateTitle,
    sideId,
    turnSubmitted,
    workspaceId,
  ]);

  useEffect(() => {
    if (
      turnSubmitted &&
      effectiveSession &&
      effectiveSession.status !== "running" &&
      effectiveSession.status !== "waiting" &&
      effectiveSession.status !== "ready"
    ) {
      setTurnSubmitted(false);
    }
  }, [effectiveSession, turnSubmitted]);

  const unsettledFirstTurn =
    !isDraft &&
    (awaitingBackgroundTitle ||
      (!candidateTitle &&
        (turnSubmitted ||
          effectiveSession?.status === "running" ||
          effectiveSession?.status === "waiting")));
  const enabled = active && connected && supported;
  const shouldPoll =
    (active || unsettledFirstTurn) && connected && supported && !serverChanged;
  useEffect(() => {
    if (!enabled) return;
    setFocus((v) => v + 1);
  }, [enabled]);

  useEffect(() => {
    if (!shouldPoll || busy || isDraft) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        await sideOperations(drafts).get(key);
        if (disposed) return;
        const confirmVersion = sideWriteConfirmationVersion(hostId, sideId);
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
        if (
          nextReady &&
          confirmVersion > 0 &&
          !page.session.side_write_pending &&
          !page.session.agent_close_pending
        ) {
          clearSideWriteConfirmation(hostId, sideId, confirmVersion);
        }
        setSession(page.session);
        setReady(nextReady);
        if (nextReady) publishLiveStatus(page.session.status);
        sideCache(drafts).set(key, {
          hostId,
          serverId: knownServerId,
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
            follow.current = true;
            restoredPosition.current = false;
            setAway(false);
            setTitleSettleExpired(false);
            setBgTitlePollExpired(false);
            setTurnSubmitted(false);
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
    shouldPoll,
    enabled,
    busy,
    hostId,
    knownServerId,
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
    const el = scroll.current;
    if (!active) {
      restoredPosition.current = false;
      return;
    }
    if (!effectiveReady && !isDraft) {
      restoredPosition.current = false;
    }
    if (!el) return;
    if (follow.current) {
      el.scrollTop = el.scrollHeight;
    } else if (!restoredPosition.current) {
      const saved = sidePositions(drafts).get(key);
      if (saved) el.scrollTop = saved.top;
    }
    if (effectiveReady || isDraft) {
      restoredPosition.current = true;
    }
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (follow.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    const content = el.querySelector(".side-chat-messages");
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [
    active,
    effectiveEvents,
    effectiveReady,
    isDraft,
    effectiveSession?.status,
    drafts,
    key,
  ]);

  const canInteract = enabled && (effectiveReady || isDraft);
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
          if (!effectiveSession?.side_write_pending) {
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
          publishLiveStatus(response.session.status);
          sideCache(drafts).set(key, {
            hostId,
            serverId: knownServerId,
            session: response.session,
            events: eventsRef.current,
            after: after.current,
            ready: effectiveReady,
          });
        }
        if (action.method === "send") {
          publishLiveStatus("running");
          if (!candidateTitle) setTurnSubmitted(true);
        }
        accepted?.();
        if (!effectiveSession) setReady(false);
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
    effectiveSession?.status === "running" ||
    effectiveSession?.status === "waiting";
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
    const formattedQuotes = quotes.map((quote) =>
      quote
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n"),
    );
    const sendText =
      formattedQuotes.length && leadingSlashCommand(prompt)
        ? (() => {
            const parsed = referenceMessage(prompt);
            return referencePrompt(
              [parsed.text.trim(), ...formattedQuotes]
                .filter(Boolean)
                .join("\n\n"),
              parsed.references,
            );
          })()
        : [...formattedQuotes, prompt || "请结合主会话解释引用的文本。"].join(
            "\n\n",
          );
    const send: Send =
      old && drafts.isCurrent(key, old.draft)
        ? old.request
        : {
            method: "send",
            session_id: sideId,
            request_id: crypto.randomUUID(),
            text: sendText,
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
  const status = executionStatus(effectiveSession, effectiveEvents, connected);
  return (
    <div className="side-chat">
      <div className="side-chat-transcript-wrap">
        <div
          className="side-chat-transcript"
          ref={scroll}
          onScroll={(e) => {
            const el = e.currentTarget;
            if (!active || (!effectiveReady && !isDraft) || !el.clientHeight)
              return;
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
            {!isDraft &&
              !effectiveReady &&
              !effectiveEvents.length &&
              enabled &&
              !readError && <WorkingStatus label="正在读取记录…" animated />}
            <TurnTranscript key={key} events={effectiveEvents}>
              {(item) => {
                if (item.type === "user")
                  return (
                    <UserMessage
                      text={item.text}
                      at={item.at}
                      hostId={hostId}
                      projectId={parent.project_id}
                      projectPath={projectPath}
                      sessionId={effectiveSession?.id}
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
                      addToMainChat={
                        !parent.archived ? addToMainChat : undefined
                      }
                    />
                  );
                if (item.type === "tool")
                  return (
                    <ToolRow
                      tool={item}
                      projectPath={projectPath}
                      loadContext={
                        effectiveSession
                          ? { hostId, sessionId: effectiveSession.id }
                          : undefined
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
                        effectiveSession
                          ? { hostId, sessionId: effectiveSession.id }
                          : undefined
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
                if (v.kind === "approval" && effectiveSession)
                  return (
                    <ApprovalCard
                      request={v}
                      resolved={item.resolved}
                      decision={item.decision}
                      tool={item.approvalTool}
                      projectPath={projectPath}
                      loadContext={{ hostId, sessionId: effectiveSession.id }}
                      disabled={disabled || !running}
                      busy={busy}
                      onDecision={(allow) =>
                        void perform({
                          method: "approve",
                          session_id: effectiveSession.id,
                          request_id: v.request_id,
                          allow,
                        })
                      }
                    />
                  );
                if (v.kind === "question" && effectiveSession)
                  return (
                    <QuestionCard
                      request={v}
                      resolved={item.resolved}
                      answers={item.answers}
                      disabled={disabled || !running}
                      onAnswer={(answers) =>
                        void perform({
                          method: "answer_question",
                          session_id: effectiveSession.id,
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
                (!!closePending && !!effectiveSession?.agent_session_busy)
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
          sessionId={effectiveSession?.id}
          connected={connected}
          hidden={!active || (!isDraft && !effectiveSession)}
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
                hidden={!active || (!isDraft && !effectiveSession)}
                value={permission}
                onChange={(permission) =>
                  setSelection({ model, effort, permission })
                }
                disabled={
                  disabled || running || (!isDraft && !effectiveSession)
                }
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
                settingsOpen={!active || (!isDraft && !effectiveSession)}
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
                disabled={
                  disabled || running || (!isDraft && !effectiveSession)
                }
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
                  running && effectiveSession
                    ? () =>
                        void perform({
                          method: "cancel",
                          session_id: effectiveSession.id,
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
