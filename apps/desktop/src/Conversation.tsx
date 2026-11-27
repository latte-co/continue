import { ImageGallery } from "./ImageGallery";
import { Select } from "./Select";
import {
  annotationError,
  userMessageContent,
  type Annotation,
} from "./annotations";
import { AnnotatedMessage, AnnotationSummary } from "./AnnotationUI";
import { MessageQueue } from "./MessageQueue";
import { TurnChangesCard } from "./TurnChangesCard";
import { UserMessage } from "./UserMessage";
import { WorkingStatus } from "./WorkingStatus";
import {
  agentSessionLabels,
  type AgentSessionState,
} from "./agentSessionState";
import { modelSelectionScope } from "./modelSelectionScope";
import { executionStatus } from "./executionStatus";
import { hasRepeatedOutput } from "./repeatedOutput";
import { QuestionCard } from "./QuestionCard";
import { ApprovalCard } from "./ApprovalCard";
import { activityTranscript } from "./activity";
import { ComposerAction } from "./ComposerAction";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MessageActionsProvider } from "./MessageContent";
import { createExternalImageLoader } from "./externalImageLoader";
import { loadSource } from "./sourceLoader";
import { DraftStore, useDraft, type Draft } from "./drafts";
import { useStatusIssues } from "./statusNotices";
import { ArrowUp, ArrowDown, Bot, Quote, X } from "lucide-react";
import type {
  AgentInfo,
  Effort,
  Event,
  Session,
  TurnChanges,
} from "./protocol";
import type { Host } from "./api";
import type { HostedProject } from "./projectCatalog";
import {
  Composer,
  composerReferenceScope,
  resolveComposerReferences,
} from "./Composer";
import {
  useComposerPrediction,
  type ComposerPredictionResponse,
} from "./useComposerPrediction";
import { useAgentPreferences } from "./useAgentPreferences";
import { PermissionPicker } from "./PermissionPicker";
import { UsageIndicator } from "./UsageIndicator";
import { ModelPicker, type ModelPickerHandle } from "./ModelPicker";
import { TaskProjectPicker } from "./TaskProjectPicker";
import { TurnTranscript, turnTranscript } from "./TurnTranscript";
import {
  TURN_PAGE_SIZE,
  TurnNavigator,
  turnNavigationEntries,
} from "./TurnNavigator";
import { ToolGroup, ToolRow } from "./ToolActivity";
import { ToolImages } from "./ToolImages";
import { TurnErrorRow, type TurnErrorRecoveryAction } from "./TurnErrorRow";
import { parseTurnError } from "./turnError";
import { Button, FloatingPill } from "./ui";
export const statusNames = {
  ready: "就绪",
  running: "执行中",
  waiting: "等待你的回应",
  completed: "已完成",
  failed: "执行失败",
  stopped: "已停止",
  unknown: "状态待确认",
};
interface Props {
  composerPrediction?: ComposerPredictionResponse | null;
  captureQueuedPredictionRetirement?: (requestId: string) => () => void;
  openSideChat?: (draft?: string) => boolean | Promise<boolean>;
  openBlockingSideChat?: (sideId: string) => void | Promise<void>;
  quoteInSideChat?: (text: string) => void;
  focusRequest?: number;
  openSubagents?: () => void;
  openTurnChanges?: (changes: TurnChanges, path?: string) => void;
  openFile?: (path: string) => void;
  openModelSettings?: () => void;
  drafts: DraftStore;
  agent?: AgentInfo;
  agents?: AgentInfo[];
  selectAgent?: (id: string) => void;
  session?: Session;
  conversationKey?: string;
  hostId: string;
  settingsOpen: boolean;
  events: Event[];
  historyLoading?: boolean;
  hasEarlierHistory?: boolean;
  earlierHistoryLoading?: boolean;
  loadEarlierHistory?: (minTurns?: number) => Promise<void>;
  autoFillTurnNavigator?: boolean;
  readingScope?: string;
  readingPositions?: Map<string, { top: number; follow: boolean }>;
  onHistoryReady?: () => void;
  connected: boolean;
  connecting?: boolean;
  connectionError?: string;
  connectionLost?: boolean;
  reconnect?: () => void;
  agentSessionState?: AgentSessionState;
  agentSessionError?: string;
  onModelReady?: () => void;
  available: boolean;
  projectName?: string;
  projectId?: string;
  project?: HostedProject;
  projects: HostedProject[];
  hosts: Host[];
  selectTaskProject: (project: HostedProject) => void;
  openProject: () => void;
  send: (
    text: string,
    model: string | null,
    effort: Effort | null,
    permissionMode: string | null,
  ) => Promise<boolean>;
  cancel: () => void | Promise<boolean>;
  approve: (id: string, allow: boolean) => Promise<void>;
  answerQuestion?: (
    id: string,
    answers: import("./protocol").QuestionAnswer[] | null,
  ) => Promise<void>;
}
const FOLLOW_THRESHOLD = 90;

export function Conversation({
  composerPrediction,
  captureQueuedPredictionRetirement,
  openSubagents,
  openSideChat,
  openBlockingSideChat,
  quoteInSideChat,
  focusRequest,
  openTurnChanges,
  openFile,
  openModelSettings,
  drafts,
  agent,
  agents = [],
  selectAgent,
  session,
  conversationKey,
  hostId,
  settingsOpen,
  events,
  historyLoading = false,
  hasEarlierHistory = false,
  earlierHistoryLoading = false,
  loadEarlierHistory,
  autoFillTurnNavigator = false,
  readingScope,
  readingPositions,
  onHistoryReady,
  connected,
  connecting = false,
  connectionError,
  connectionLost = false,
  reconnect,
  agentSessionState: liveSessionState,
  agentSessionError,
  onModelReady,
  available,
  projectName,
  projectId,
  project,
  projects,
  hosts,
  selectTaskProject,
  openProject,
  send,
  cancel,
  approve,
  answerQuestion,
}: Props) {
  const projectPath = project?.path;
  const draftKey = session ? JSON.stringify([hostId, session.id]) : "new-task";
  const submissionScope = JSON.stringify(
    projectPath === undefined
      ? [hostId, projectId, session?.agent ?? agent?.id ?? "claude"]
      : [
          hostId,
          projectId,
          projectPath,
          session?.agent ?? agent?.id ?? "claude",
        ],
  );
  const draft = useDraft(drafts, draftKey);
  const editingScope = useRef(draftKey);
  editingScope.current = draftKey;
  const text = draft.text;
  const quotes = draft.quotes ?? [];
  const annotations = useMemo(
    () => draft.annotations ?? [],
    [draft.annotations],
  );
  function saveAnnotation(entry: Annotation) {
    const existing = drafts.get(draftKey).annotations ?? [];
    const next = existing.some((item) => item.id === entry.id)
      ? existing.map((item) => (item.id === entry.id ? entry : item))
      : [...existing, entry];
    const error = annotationError(next);
    if (error) return error;
    drafts.update(draftKey, { annotations: next });
    return null;
  }
  function removeAnnotation(id: string) {
    drafts.update(draftKey, {
      annotations: (drafts.get(draftKey).annotations ?? []).filter(
        (entry) => entry.id !== id,
      ),
    });
  }
  const setText = (text: string) => drafts.update(draftKey, { text });
  const root = useRef<HTMLElement>(null);
  const modelPicker = useRef<ModelPickerHandle>(null);
  const [sending, setSending] = useState(false);
  const [queueEdits, setQueueEdits] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const queueEditing = (queueEdits.get(draftKey) ?? 0) > 0;
  const [composerFocus, setComposerFocus] = useState(0);
  useEffect(() => {
    if (draft.skillCreator && projectName && !settingsOpen)
      setComposerFocus((value) => value + 1);
  }, [draft.skillCreator, projectName, settingsOpen]);
  const previousDraftKey = useRef(draftKey);
  const migrated = useRef<string | null>(null);
  const submission = useRef<{
    key: string;
    scope: string;
    draft: Draft;
    preserveDraft?: boolean;
    accepted?: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    if (
      submission.current?.key === "new-task" &&
      !submission.current.preserveDraft &&
      previousDraftKey.current === "new-task" &&
      draftKey !== "new-task"
    ) {
      const submitted = submission.current;
      drafts.adopt(draftKey, submitted.draft);
      migrated.current = draftKey;
      if (submitted.accepted !== undefined) {
        if (submitted.accepted) drafts.clear(draftKey, submitted.draft);
        drafts.clear(submitted.key, submitted.draft);
      }
    }
    previousDraftKey.current = draftKey;
  }, [draftKey, sending, drafts]);
  const currentSubmission = submission.current;
  const sendingInCurrentScope =
    sending &&
    !!currentSubmission &&
    currentSubmission.scope === submissionScope &&
    (currentSubmission.key === draftKey || migrated.current === draftKey);
  const concealSubmitted =
    sendingInCurrentScope &&
    !currentSubmission?.preserveDraft &&
    connected &&
    !!currentSubmission &&
    drafts.isCurrent(draftKey, currentSubmission.draft);
  const agentId = session?.agent ?? agent?.id ?? "claude";
  const agentName =
    agent?.id === agentId
      ? agent.name
      : agentId === "claude"
        ? "Claude Code"
        : agentId;
  const effectiveConversationKey = conversationKey ?? session?.id ?? draftKey;
  const preferences = useAgentPreferences(
    hostId,
    agentId,
    projectId,
    session,
    sending,
    effectiveConversationKey,
  );
  const { model, effort, permissionMode } = preferences;
  const [modelReadiness, setModelReadiness] = useState<{
    scope: string;
    ready: boolean;
  }>();
  const modelScope = modelSelectionScope(
    hostId,
    projectId,
    agentId,
    model,
    effort,
    projectPath,
  );
  const modelReady =
    modelReadiness?.scope === modelScope && modelReadiness.ready;
  useEffect(() => {
    if (modelReady) onModelReady?.();
  }, [modelReady, onModelReady]);
  const [approving, setApproving] = useState<{
    scope: string;
    id: string;
  } | null>(null);
  const approvalSubmissions = useRef(new Set<string>());
  const submittingApproval =
    approving?.scope === draftKey ? approving.id : null;
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const historyScope = JSON.stringify([hostId, session?.id ?? null]);
  const localPositions = useRef(
    new Map<string, { top: number; follow: boolean }>(),
  );
  const positions = readingPositions ?? localPositions.current;
  const positionScope = readingScope ?? historyScope;
  const [visibleHistoryScope, setVisibleHistoryScope] = useState<string | null>(
    null,
  );
  const preparingHistory =
    historyLoading ||
    (events.length > 0 && visibleHistoryScope !== positionScope);
  const openingSession =
    session &&
    connected &&
    (liveSessionState === "opening" || liveSessionState === "restoring");
  const [away, setAway] = useState(false);
  const turns = useMemo(() => turnTranscript(events), [events]);
  const turnEntries = useMemo(() => turnNavigationEntries(turns), [turns]);
  const showTurnNavigation =
    !preparingHistory &&
    (turnEntries.length > 1 || (hasEarlierHistory && turnEntries.length > 0));
  const [stopping, setStopping] = useState(false);
  const [inlineRefError, setInlineRefError] = useState("");
  const stopGeneration = useRef(0);
  const active = session && ["running", "waiting"].includes(session.status);
  const pendingQuestions = useMemo(
    () =>
      session && active && !session.archived && !preparingHistory
        ? activityTranscript(
            events.filter((event) => event.session_id === session.id),
          ).flatMap((item) =>
            item.type === "event" &&
            item.value.kind === "question" &&
            !item.resolved
              ? [item.value]
              : [],
          )
        : [],
    [events, session, active, preparingHistory],
  );
  const pendingApprovals = useMemo(
    () =>
      session && active && !session.archived && !preparingHistory
        ? activityTranscript(
            events.filter((e) => e.session_id === session.id),
          ).flatMap((item) =>
            item.type === "event" &&
            item.value.kind === "approval" &&
            !item.resolved
              ? [{ request: item.value, tool: item.approvalTool }]
              : [],
          )
        : [],
    [events, session, active, preparingHistory],
  );
  const prediction = useComposerPrediction(
    JSON.stringify([hostId, projectId, session?.id, agentId]),
    session?.id,
    agentId,
    composerPrediction,
  );
  const predictionBlocked =
    session?.status !== "completed" ||
    !modelReady ||
    !available ||
    preparingHistory ||
    !!openingSession ||
    stopping ||
    queueEditing ||
    !!pendingQuestions.length ||
    !!pendingApprovals.length ||
    !!submittingApproval ||
    ["opening", "restoring", "error", "unknown"].includes(
      liveSessionState ?? "",
    );
  useEffect(() => {
    stopGeneration.current++;
    setStopping(false);
  }, [draftKey, active]);
  const workingStatus = executionStatus(
    session,
    events,
    connected,
    stopping,
    sendingInCurrentScope,
  );
  const repeatedOutput = useMemo(
    () =>
      !!session &&
      session.status === "running" &&
      !session.archived &&
      connected &&
      !preparingHistory &&
      !stopping &&
      hasRepeatedOutput(events, session.id),
    [events, session, connected, preparingHistory, stopping],
  );
  async function stop() {
    if (stopping) return;
    const generation = ++stopGeneration.current;
    setStopping(true);
    try {
      if ((await cancel()) === false && stopGeneration.current === generation)
        setStopping(false);
    } catch {
      if (stopGeneration.current === generation) setStopping(false);
    }
  }
  useLayoutEffect(() => {
    const saved = positions.get(positionScope);
    setVisibleHistoryScope(null);
    follow.current = saved?.follow ?? true;
    setAway(!follow.current);
  }, [positionScope, positions]);
  const previousHistoryLayout = useRef<
    | {
        scope: string;
        first?: number;
        height: number;
      }
    | undefined
  >(undefined);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const previous = previousHistoryLayout.current;
    if (
      previous?.scope === positionScope &&
      previous.first !== undefined &&
      events[0]?.seq < previous.first &&
      !follow.current
    ) {
      el.scrollTop += el.scrollHeight - previous.height;
      positions.set(positionScope, { top: el.scrollTop, follow: false });
    }
    previousHistoryLayout.current = {
      scope: positionScope,
      first: events[0]?.seq,
      height: el.scrollHeight,
    };
  }, [events, positionScope, positions]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const scrollToLatest = () => {
      if (follow.current) el.scrollTo({ top: el.scrollHeight });
    };
    scrollToLatest();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(scrollToLatest);
    observer.observe(el);
    const content = el.querySelector(".messages, .welcome");
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [hostId, session?.id, events]);
  useLayoutEffect(() => {
    if (historyLoading) {
      setVisibleHistoryScope(null);
      return;
    }
    if (visibleHistoryScope === positionScope) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const el = scroller.current;
        if (el) {
          const saved = positions.get(positionScope);
          el.scrollTop = follow.current ? el.scrollHeight : (saved?.top ?? 0);
        }
        setVisibleHistoryScope(positionScope);
        setAway(!follow.current);
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [
    historyLoading,
    historyScope,
    visibleHistoryScope,
    events,
    positionScope,
    positions,
  ]);
  useEffect(() => {
    if (!preparingHistory) onHistoryReady?.();
  }, [preparingHistory, historyScope, onHistoryReady]);
  const lastViewportFill = useRef<string | null>(null);
  const inFlightAutoCursor = useRef<string | null>(null);
  const wasEarlierLoading = useRef(earlierHistoryLoading);
  const [stalledCursor, setStalledCursor] = useState<string | null>(null);
  const currentHistoryCursor = JSON.stringify([positionScope, events[0]?.seq]);

  function triggerAutoLoadEarlier(cursor: string) {
    if (
      !loadEarlierHistory ||
      !hasEarlierHistory ||
      earlierHistoryLoading ||
      lastViewportFill.current === cursor
    )
      return;
    lastViewportFill.current = cursor;
    inFlightAutoCursor.current = cursor;
    setStalledCursor(null);
    void loadEarlierHistory();
  }

  useEffect(() => {
    if (wasEarlierLoading.current && !earlierHistoryLoading) {
      if (inFlightAutoCursor.current === currentHistoryCursor) {
        setStalledCursor(currentHistoryCursor);
      }
      inFlightAutoCursor.current = null;
    }
    wasEarlierLoading.current = earlierHistoryLoading;
  }, [earlierHistoryLoading, currentHistoryCursor]);

  useEffect(() => {
    setStalledCursor((prev) =>
      prev && prev !== currentHistoryCursor ? null : prev,
    );
  }, [currentHistoryCursor]);

  const lastTurnNavFill = useRef<string | null>(null);
  useEffect(() => {
    if (
      !autoFillTurnNavigator ||
      preparingHistory ||
      settingsOpen ||
      !connected ||
      !hasEarlierHistory ||
      earlierHistoryLoading ||
      !loadEarlierHistory ||
      turnEntries.length === 0 ||
      turnEntries.length >= TURN_PAGE_SIZE ||
      lastTurnNavFill.current === positionScope
    )
      return;
    lastTurnNavFill.current = positionScope;
    void loadEarlierHistory(TURN_PAGE_SIZE - turnEntries.length);
  }, [
    autoFillTurnNavigator,
    preparingHistory,
    settingsOpen,
    connected,
    hasEarlierHistory,
    earlierHistoryLoading,
    loadEarlierHistory,
    turnEntries.length,
    positionScope,
  ]);
  useEffect(() => {
    const el = scroller.current;
    if (
      !el ||
      preparingHistory ||
      settingsOpen ||
      !connected ||
      !hasEarlierHistory ||
      earlierHistoryLoading ||
      !loadEarlierHistory
    )
      return;
    // Event pages can collapse to just a few visible lines. A short transcript
    // cannot scroll out of the follow threshold to request a page. Fill enough
    // space for an upward scroll to enter history-reading mode.
    // Keep a failed/non-advancing cursor attempted until an explicit retry moves
    // it forward; resize notifications must not cause an automatic retry loop.
    const cursor = currentHistoryCursor;
    let active = true;
    const fillViewport = () => {
      if (
        !active ||
        document.visibilityState === "hidden" ||
        el.clientHeight <= 0
      )
        return;
      const needsViewportFill =
        el.scrollHeight - el.clientHeight < FOLLOW_THRESHOLD;
      const needsTopPrefetch =
        !follow.current && el.scrollTop < Math.max(320, el.clientHeight * 0.65);
      if (!needsViewportFill && !needsTopPrefetch) return;
      triggerAutoLoadEarlier(cursor);
    };
    fillViewport();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(fillViewport);
    observer?.observe(el);
    const content = el.querySelector(".messages");
    if (content) observer?.observe(content);
    document.addEventListener("visibilitychange", fillViewport);
    return () => {
      active = false;
      observer?.disconnect();
      document.removeEventListener("visibilitychange", fillViewport);
    };
  }, [
    preparingHistory,
    settingsOpen,
    connected,
    hasEarlierHistory,
    earlierHistoryLoading,
    loadEarlierHistory,
    positionScope,
    events,
  ]);
  async function submit(
    prompt: string,
    options?: { preserveDraft?: boolean },
  ): Promise<boolean> {
    if (
      !prompt.trim() ||
      sending ||
      queueEditing ||
      !connected ||
      !available ||
      !modelReady ||
      liveSessionState === "opening" ||
      liveSessionState === "restoring" ||
      liveSessionState === "error" ||
      liveSessionState === "unknown" ||
      session?.archived
    )
      return false;
    migrated.current = null;
    const submitted = {
      key: draftKey,
      scope: submissionScope,
      draft,
      preserveDraft: options?.preserveDraft,
      accepted: undefined as boolean | undefined,
    };
    submission.current = submitted;
    setSending(true);
    try {
      submitted.accepted = await send(prompt, model, effort, permissionMode);
      if (submitted.accepted) {
        if (!submitted.preserveDraft) {
          drafts.clear(draftKey, draft);
          if (migrated.current) drafts.clear(migrated.current, draft);
        }
        follow.current = true;
        return true;
      }
      return false;
    } finally {
      submitted.accepted ??= false;
      if (!submitted.preserveDraft && migrated.current)
        drafts.clear(draftKey, draft);
      setSending(false);
    }
  }
  async function decide(id: string, allow: boolean) {
    const key = JSON.stringify([draftKey, id]);
    if (
      !connected ||
      stopping ||
      submittingApproval ||
      approvalSubmissions.current.has(key) ||
      !pendingApprovals.some(({ request }) => request.request_id === id)
    )
      return;
    const submission = { scope: draftKey, id };
    approvalSubmissions.current.add(key);
    setApproving(submission);
    try {
      await approve(id, allow);
    } finally {
      approvalSubmissions.current.delete(key);
      setApproving((current) => (current === submission ? null : current));
    }
  }
  async function answer(
    id: string,
    answers: import("./protocol").QuestionAnswer[] | null,
  ) {
    const key = JSON.stringify([draftKey, id]);
    if (
      !answerQuestion ||
      !connected ||
      stopping ||
      submittingApproval ||
      approvalSubmissions.current.has(key) ||
      !pendingQuestions.some((question) => question.request_id === id)
    )
      return;
    const submission = { scope: draftKey, id };
    approvalSubmissions.current.add(key);
    setApproving(submission);
    try {
      await answerQuestion(id, answers);
    } finally {
      approvalSubmissions.current.delete(key);
      setApproving((current) => (current === submission ? null : current));
    }
  }
  const hostName = hosts.find((host) => host.id === hostId)?.name ?? "主机";
  useStatusIssues([
    {
      id: `connection:${hostId}`,
      title: `${hostName} ${connectionLost ? "连接已断开" : "暂时无法连接"}`,
      error: !connected && !connecting ? (connectionError ?? "") : "",
      action: reconnect ? { label: "重新连接", run: reconnect } : undefined,
    },
    {
      id: `agent-session:${draftKey}`,
      title: "对话状态待确认",
      error:
        session &&
        connected &&
        liveSessionState &&
        ["error", "unknown"].includes(liveSessionState)
          ? agentSessionError || agentSessionLabels[liveSessionState]
          : "",
      action: reconnect
        ? {
            label: liveSessionState === "unknown" ? "重新连接" : "重新打开",
            run: reconnect,
          }
        : undefined,
    },
    {
      id: `preferences:${hostId}:${agentId}:${projectId}`,
      title: "模型参数未能保存",
      error: preferences.error,
    },
    {
      id: `repeated-output:${draftKey}`,
      title: "检测到重复输出",
      level: "warning",
      error: repeatedOutput ? "回复内容似乎在重复，可停止任务后重试。" : "",
      pending: stopping,
      action: { label: "停止当前任务", run: stop },
    },
    {
      id: `inline-refs:${hostId}`,
      title: "文件操作未完成",
      error: inlineRefError,
      action: { label: "知道了", run: () => setInlineRefError("") },
    },
  ]);
  return (
    <section
      className="conversation"
      ref={root}
      data-preparing={!connected && (connecting || !connectionError)}
    >
      <div
        className="conversation-history"
        data-turn-navigation={showTurnNavigation}
      >
        <div
          className={`conversation-scroll${events.length === 0 ? " empty" : ""}`}
          ref={scroller}
          aria-busy={preparingHistory}
          data-history-loading={preparingHistory}
          onWheel={(event) => {
            if (
              preparingHistory ||
              event.deltaY >= 0 ||
              !hasEarlierHistory ||
              earlierHistoryLoading ||
              !connected ||
              settingsOpen
            )
              return;
            const el = scroller.current;
            if (el && el.scrollTop <= Math.max(320, el.clientHeight * 0.65)) {
              triggerAutoLoadEarlier(currentHistoryCursor);
            }
          }}
          onScroll={() => {
            if (preparingHistory) return;
            const el = scroller.current!;
            follow.current =
              el.scrollHeight - el.scrollTop - el.clientHeight <
              FOLLOW_THRESHOLD;
            positions.set(positionScope, {
              top: el.scrollTop,
              follow: follow.current,
            });
            setAway(!follow.current);
            if (
              !follow.current &&
              hasEarlierHistory &&
              !earlierHistoryLoading &&
              connected &&
              !settingsOpen &&
              el.scrollTop < Math.max(320, el.clientHeight * 0.65)
            ) {
              triggerAutoLoadEarlier(currentHistoryCursor);
            }
          }}
        >
          {events.length === 0 ? (
            <div className="welcome" aria-hidden={preparingHistory}>
              <h1>{projectName ? "从一个想法开始" : "开始一项新任务"}</h1>
              <p>
                {projectName
                  ? `在 ${projectName} 中与 ${agentName} 一起工作。`
                  : `选择本地或远程项目，与 ${agentName} 一起工作。`}
              </p>
              {!text.trim() && (
                <div className="suggestions">
                  {["梳理项目结构", "帮我实现一个功能", "检查最近的改动"].map(
                    (s) => (
                      <button
                        key={s}
                        disabled={!projectName || !!session?.archived}
                        onClick={() => {
                          setText(s);
                          root.current
                            ?.querySelector<HTMLElement>(
                              '[aria-label="任务输入"]',
                            )
                            ?.focus();
                        }}
                      >
                        {s}
                        <ArrowUp size={14} />
                      </button>
                    ),
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="messages" aria-hidden={preparingHistory}>
              {hasEarlierHistory &&
                (earlierHistoryLoading ||
                  stalledCursor === currentHistoryCursor) && (
                  <div className="earlier-history">
                    {earlierHistoryLoading ? (
                      <WorkingStatus label="正在加载更早内容…" animated />
                    ) : (
                      <button
                        type="button"
                        className="ui-btn ui-btn--subtle ui-btn--sm"
                        onClick={() => {
                          setStalledCursor(null);
                          void loadEarlierHistory?.();
                        }}
                      >
                        加载之前的记录
                      </button>
                    )}
                  </div>
                )}
              <ImageGallery
                scope={historyScope}
                active={!settingsOpen && !preparingHistory}
              >
                <MessageActionsProvider
                  value={{
                    openFile,
                    localHost: hostId === "local",
                    projectRoot: project?.path,
                    readProjectFile: projectId
                      ? (path, valid = () => true) =>
                          loadSource(
                            hostId,
                            projectId,
                            undefined,
                            path,
                            valid,
                            true,
                          )
                      : undefined,
                    loadExternalImage: projectId
                      ? createExternalImageLoader(hostId, projectId)
                      : undefined,
                    reportError: setInlineRefError,
                  }}
                >
                  <TurnTranscript
                    key={JSON.stringify([hostId, session?.id])}
                    events={events}
                    turns={turns}
                    askInSideChat={quoteInSideChat}
                  >
                    {(item, { turn, isLatestTurn }) =>
                      item.type === "user" ? (
                        <UserMessage
                          key={item.key}
                          text={item.text}
                          at={item.at}
                          hostId={hostId}
                          projectId={projectId}
                          projectPath={project?.path}
                          sessionId={session?.id}
                          connected={connected}
                          active={!settingsOpen && !preparingHistory}
                        />
                      ) : item.type === "assistant" ? (
                        <AnnotatedMessage
                          key={`${historyScope}:${item.key}`}
                          message={item.key}
                          text={item.text}
                          entries={annotations}
                          enabled={
                            !settingsOpen &&
                            !preparingHistory &&
                            !sendingInCurrentScope &&
                            !queueEditing &&
                            !session?.archived
                          }
                          onSave={saveAnnotation}
                          onRemove={removeAnnotation}
                          askInSideChat={quoteInSideChat}
                        />
                      ) : item.type === "tool_images" ? (
                        <ToolImages
                          key={item.key}
                          images={item.images}
                          active={!settingsOpen && !preparingHistory}
                        />
                      ) : item.type === "tool" ? (
                        <ToolRow
                          key={item.key}
                          tool={item}
                          projectPath={project?.path}
                          onOpenSubagents={openSubagents}
                          loadContext={
                            session
                              ? { hostId, sessionId: session.id }
                              : undefined
                          }
                        />
                      ) : item.type === "tools" ? (
                        <ToolGroup
                          key={item.key}
                          tools={item.tools}
                          unrecovered={item.unrecovered}
                          projectPath={project?.path}
                          onOpenSubagents={openSubagents}
                          loadContext={
                            session
                              ? { hostId, sessionId: session.id }
                              : undefined
                          }
                        />
                      ) : (
                        (() => {
                          const v = item.value;
                          if (v.kind === "turn_changes" && openTurnChanges)
                            return (
                              <TurnChangesCard
                                key={`${hostId}:${session?.id}:${item.key}`}
                                hostId={hostId}
                                sessionId={session?.id ?? ""}
                                workspaceId={conversationKey}
                                openBlockingSideChat={openBlockingSideChat}
                                canUndo={
                                  connected &&
                                  !!session &&
                                  !["running", "waiting"].includes(
                                    session.status,
                                  ) &&
                                  latestRequestId(events) ===
                                    v.changes.request_id
                                }
                                changes={v.changes}
                                open={(path) =>
                                  openTurnChanges(v.changes, path)
                                }
                              />
                            );
                          if (v.kind === "question")
                            return (
                              <QuestionCard
                                key={item.key}
                                request={v}
                                resolved={item.resolved}
                                answers={
                                  item.type === "event"
                                    ? item.answers
                                    : undefined
                                }
                                record
                                onAnswer={() => {}}
                              />
                            );
                          if (v.kind === "approval")
                            return (
                              <ApprovalCard
                                key={item.key}
                                request={v}
                                resolved={item.resolved}
                                decision={item.decision}
                                tool={item.approvalTool}
                                presentation="record"
                                projectPath={project?.path}
                                loadContext={
                                  session
                                    ? { hostId, sessionId: session.id }
                                    : undefined
                                }
                                onDecision={(allow) =>
                                  void decide(v.request_id, allow)
                                }
                              />
                            );
                          if (v.kind === "state" && v.message) {
                            if (v.status === "failed") {
                              const turnItems = turn.segments.flatMap(
                                (segment) => segment.items,
                              );
                              const lastFailed = [...turnItems]
                                .reverse()
                                .find(
                                  (entry) =>
                                    entry.type === "event" &&
                                    entry.value.kind === "state" &&
                                    entry.value.status === "failed" &&
                                    !!entry.value.message,
                                );
                              const canAct =
                                isLatestTurn &&
                                lastFailed?.key === item.key &&
                                !active &&
                                !sendingInCurrentScope &&
                                !stopping &&
                                !queueEditing &&
                                !preparingHistory &&
                                !session?.archived &&
                                ![
                                  "opening",
                                  "restoring",
                                  "error",
                                  "unknown",
                                ].includes(liveSessionState ?? "");
                              let recoveryAction:
                                TurnErrorRecoveryAction | undefined;
                              if (canAct) {
                                const parsed = parseTurnError(v.message);
                                if (
                                  parsed.category === "auth" &&
                                  openModelSettings
                                ) {
                                  recoveryAction = {
                                    label: "模型设置",
                                    onClick: openModelSettings,
                                  };
                                } else if (
                                  parsed.category !== "context" &&
                                  connected &&
                                  available &&
                                  modelReady
                                ) {
                                  const itemIdx = turnItems.indexOf(item);
                                  const priorItems =
                                    itemIdx >= 0
                                      ? turnItems.slice(0, itemIdx)
                                      : turnItems;
                                  const hasPriorProgress = priorItems.some(
                                    (prior) =>
                                      prior.type === "tool" ||
                                      prior.type === "tools" ||
                                      prior.type === "tool_images" ||
                                      prior.type === "assistant" ||
                                      (prior.type === "event" &&
                                        (prior.value.kind === "turn_changes" ||
                                          ((prior.value.kind === "approval" ||
                                            prior.value.kind === "question") &&
                                            !!prior.resolved))),
                                  );
                                  if (hasPriorProgress) {
                                    recoveryAction = {
                                      label: "继续",
                                      onClick: () =>
                                        void submit("继续", {
                                          preserveDraft: true,
                                        }),
                                    };
                                  } else if (turn.user?.text) {
                                    const retryPrompt = turn.user.text;
                                    recoveryAction = {
                                      label: "重试",
                                      onClick: () =>
                                        void submit(retryPrompt, {
                                          preserveDraft: true,
                                        }),
                                    };
                                  }
                                }
                              }
                              return (
                                <TurnErrorRow
                                  key={item.key}
                                  message={v.message}
                                  action={recoveryAction}
                                />
                              );
                            }
                            return (
                              <div className="notice" key={item.key}>
                                {v.message}
                              </div>
                            );
                          }
                          if (v.kind === "notice")
                            return (
                              <div className="notice" key={item.key}>
                                {v.text}
                              </div>
                            );
                          return null;
                        })()
                      )
                    }
                  </TurnTranscript>
                </MessageActionsProvider>
              </ImageGallery>
              {workingStatus && (
                <WorkingStatus
                  label={workingStatus}
                  animated={
                    connected && (session?.status !== "waiting" || stopping)
                  }
                />
              )}
            </div>
          )}
        </div>
        {showTurnNavigation && (
          <TurnNavigator
            key={positionScope}
            entries={turnEntries}
            scroller={scroller}
            onNavigate={(top) => {
              follow.current = false;
              setAway(true);
              positions.set(positionScope, { top, follow: false });
              scroller.current?.scrollTo({ top });
            }}
            hasEarlierHistory={hasEarlierHistory}
            earlierHistoryLoading={earlierHistoryLoading}
            onLoadEarlier={
              loadEarlierHistory
                ? (minTurns) => {
                    if (!follow.current) {
                      positions.set(positionScope, {
                        top: scroller.current?.scrollTop ?? 0,
                        follow: false,
                      });
                    }
                    void loadEarlierHistory(minTurns);
                  }
                : undefined
            }
          />
        )}
      </div>
      <div className="composer-wrap">
        <div className="composer-context">
          {!connected && (connecting || !connectionError) && text.trim() && (
            <WorkingStatus label="正在准备…" animated />
          )}
          {openingSession && (
            <div className="agent-session-opening">
              <WorkingStatus
                label={agentSessionLabels[liveSessionState!]}
                animated
              />
            </div>
          )}
          {away && !openingSession && (
            <FloatingPill
              className="return-latest"
              aria-label="回到最新"
              title="回到最新"
              onClick={() => {
                follow.current = true;
                setAway(false);
                scroller.current?.scrollTo({
                  top: scroller.current.scrollHeight,
                });
              }}
            >
              <ArrowDown size={14} />
              <span>回到最新</span>
            </FloatingPill>
          )}

          {!session && (
            <TaskProjectPicker
              project={project}
              projects={projects}
              hosts={hosts}
              disabled={sending}
              onSelect={selectTaskProject}
              onAddProject={openProject}
            />
          )}
          {!session && draft.skillCreator && !projectName && (
            <div className="skill-creator-context">
              <span>先选择工作目录，再描述要创建的技能。</span>
              <Button
                variant="subtle"
                size="xs"
                disabled={sending}
                onClick={openProject}
              >
                选择工作目录
              </Button>
            </div>
          )}
          {!session && selectAgent && agents.length > 1 ? (
            <div className="agent-picker">
              <Select
                label="Code Agent"
                value={agentId}
                options={agents
                  .filter((a) => a.available || a.id === agentId)
                  .map((a) => ({
                    value: a.id,
                    label: a.name,
                    description: a.available ? undefined : "暂不可用",
                  }))}
                onChange={selectAgent}
                disabled={
                  sending || !connected || !agents.some((a) => a.available)
                }
                compact
                minMenuWidth={180}
              />
            </div>
          ) : (
            <span className="agent-badge" title={agentName}>
              {agentId === "claude" ? (
                <span className="claude-mark" aria-hidden="true">
                  ✳
                </span>
              ) : (
                <Bot size={15} aria-hidden="true" />
              )}
              <span>{agentName}</span>
            </span>
          )}
        </div>
        {pendingQuestions.length > 0 && (
          <section
            className="approval-dock question-dock"
            aria-label="待回答问题"
          >
            {pendingQuestions.map((question) => (
              <QuestionCard
                key={JSON.stringify([draftKey, question.request_id])}
                request={question}
                disabled={
                  !connected ||
                  stopping ||
                  !!submittingApproval ||
                  !answerQuestion
                }
                busy={submittingApproval === question.request_id}
                onAnswer={(answers) =>
                  void answer(question.request_id, answers)
                }
              />
            ))}
          </section>
        )}
        {pendingApprovals.length > 0 && (
          <section className="approval-dock" aria-label="待审批操作">
            {pendingApprovals.length > 1 && (
              <p className="approval-dock-count">
                {pendingApprovals.length} 项操作等待确认
              </p>
            )}
            {pendingApprovals.map(({ request, tool }) => (
              <ApprovalCard
                key={JSON.stringify([draftKey, request.request_id])}
                request={request}
                tool={tool}
                projectPath={project?.path}
                disabled={!connected || stopping || !!submittingApproval}
                busy={submittingApproval === request.request_id}
                loadContext={
                  session ? { hostId, sessionId: session.id } : undefined
                }
                onDecision={(allow) => void decide(request.request_id, allow)}
              />
            ))}
          </section>
        )}
        <MessageQueue
          key={`${hostId}:${session?.id}`}
          hostId={hostId}
          sessionId={session?.id}
          connected={connected}
          active={!settingsOpen}
          revision={String(sending)}
          running={!!active}
          editingBlocked={sending}
          captureQueuedPredictionRetirement={captureQueuedPredictionRetirement}
          onEditPending={(pending) =>
            setQueueEdits((previous) => {
              const next = new Map(previous);
              const count = (next.get(draftKey) ?? 0) + (pending ? 1 : -1);
              if (count > 0) next.set(draftKey, count);
              else next.delete(draftKey);
              return next;
            })
          }
          onEdit={(entry) => {
            const current = drafts.get(draftKey);
            const restored = userMessageContent(entry.text);
            const scope = composerReferenceScope(
              hostId,
              projectId,
              agentId,
              projectPath,
            );
            const existing = resolveComposerReferences(
              current.references,
              hostId,
              projectId,
              agentId,
              projectPath,
            );
            const combined = [
              ...existing,
              ...restored.references.filter(
                (item) => !existing.some((old) => old.path === item.path),
              ),
            ];
            const combinedAnnotations = [
              ...(current.annotations ?? []),
              ...restored.annotations.map((item) => ({
                ...item,
                id: crypto.randomUUID(),
              })),
            ];
            const canRestore =
              combined.length <= 20 && !annotationError(combinedAnnotations);
            drafts.update(draftKey, {
              text: [current.text, canRestore ? restored.text : entry.text]
                .filter(Boolean)
                .join("\n\n"),
              references: {
                scope,
                entries: canRestore ? combined : existing,
              },
              annotations: canRestore
                ? combinedAnnotations
                : current.annotations,
            });
            if (editingScope.current === draftKey)
              setComposerFocus((v) => v + 1);
          }}
        />
        <Composer
          prediction={prediction.prediction}
          onDismissPrediction={prediction.dismiss}
          predictionBlocked={predictionBlocked}
          quotes={quotes}
          annotations={annotations}
          hasContext={annotations.length > 0 || quotes.length > 0}
          context={
            annotations.length > 0 || quotes.length > 0 ? (
              <>
                {annotations.length > 0 && (
                  <AnnotationSummary
                    key={draftKey}
                    entries={annotations}
                    onSave={saveAnnotation}
                    onRemove={removeAnnotation}
                    onClear={() => drafts.update(draftKey, { annotations: [] })}
                    onFocusComposer={() =>
                      setComposerFocus((value) => value + 1)
                    }
                    disabled={sending || queueEditing || !!session?.archived}
                    active={!settingsOpen}
                  />
                )}
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
                          type="button"
                          aria-label={`移除文本片段 ${index + 1}`}
                          disabled={
                            sending || queueEditing || !!session?.archived
                          }
                          onClick={() => {
                            const next = quotes.filter((_, i) => i !== index);
                            drafts.update(draftKey, {
                              quotes: next.length ? next : undefined,
                            });
                            setComposerFocus((value) => value + 1);
                          }}
                        >
                          <X size={13} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </>
            ) : null
          }
          focusRequest={composerFocus + (focusRequest ?? 0)}
          skillCreator={draft.skillCreator}
          onRemoveSkillCreator={() =>
            drafts.update(draftKey, { skillCreator: undefined })
          }
          referenceState={draft.references}
          onReferencesChange={(references) =>
            drafts.update(draftKey, { references })
          }
          agent={agentId}
          hostId={hostId}
          projectId={projectId}
          projectPath={projectPath}
          sessionId={session?.id}
          connected={connected}
          hidden={settingsOpen}
          disabled={!projectName || !!session?.archived || queueEditing}
          sending={sending}
          concealSubmitted={concealSubmitted}
          value={text}
          onChange={setText}
          onSubmit={submit}
          onOpenSubagents={openSubagents}
          onOpenSideChat={openSideChat}
          onOpenModelSettings={(target, isCurrent) =>
            modelPicker.current?.openMenu(target, isCurrent) ??
            (modelPicker.current ? null : "无法打开模型设置。")
          }
          placeholder={
            concealSubmitted
              ? "正在发送任务…"
              : !connected
                ? connecting || !connectionError
                  ? "正在准备…"
                  : "暂时无法连接"
                : session?.archived
                  ? "会话已归档，请通过右键菜单取消归档后继续"
                  : projectName
                    ? draft.skillCreator
                      ? "描述你想创建的技能…"
                      : "描述任务，@ 添加引用，/ 调用命令和技能…"
                    : draft.skillCreator
                      ? "先选择工作目录以创建技能"
                      : "先添加或选择一个项目"
          }
          toolbar={(submit, hasContent, localNavigation) => (
            <>
              <PermissionPicker
                key={JSON.stringify([hostId, agentId])}
                hostId={hostId}
                agent={agentId}
                connected={connected}
                hidden={settingsOpen}
                value={permissionMode}
                onChange={preferences.choosePermissionMode}
                disabled={
                  !!active || sending || !projectName || !!session?.archived
                }
              />
              <UsageIndicator
                key={draftKey}
                events={events}
                sessionId={session?.id}
                hidden={settingsOpen}
              />
              <ModelPicker
                ref={modelPicker}
                onReadyChange={setModelReadiness}
                hostId={hostId}
                projectId={projectId}
                projectPath={projectPath}
                agent={agentId}
                conversationKey={effectiveConversationKey}
                connected={connected}
                settingsOpen={settingsOpen}
                preserveUnavailableModel={!!session}
                value={model}
                onChange={preferences.chooseModel}
                onProviderFallback={preferences.replaceUnsupportedModel}
                effort={effort}
                onEffortChange={preferences.chooseEffort}
                onEffortInvalid={preferences.clearUnsupportedEffort}
                disabled={
                  !!active || sending || !projectName || !!session?.archived
                }
              />
              <ComposerAction
                active={!!active && !hasContent && !localNavigation}
                label={
                  localNavigation === "side"
                    ? "打开侧边聊天"
                    : localNavigation === "subagents"
                      ? "打开子智能体"
                      : localNavigation === "model"
                        ? "选择模型"
                        : localNavigation === "effort"
                          ? "思考强度"
                          : active && hasContent
                            ? "加入队列"
                            : undefined
                }
                sending={sending}
                disabled={
                  (queueEditing &&
                    (!active || hasContent || !!localNavigation)) ||
                  (localNavigation
                    ? !!session?.archived || !projectName || sending
                    : active
                      ? !connected ||
                        sending ||
                        (hasContent && (!modelReady || !available))
                      : !!session?.archived ||
                        !modelReady ||
                        liveSessionState === "opening" ||
                        liveSessionState === "restoring" ||
                        liveSessionState === "error" ||
                        liveSessionState === "unknown" ||
                        !hasContent ||
                        !projectName ||
                        !connected ||
                        !available ||
                        sending)
                }
                onClick={
                  active && !hasContent && !localNavigation ? stop : submit
                }
              />
            </>
          )}
        />
      </div>
    </section>
  );
}

function latestRequestId(events: Event[]) {
  const event = [...events]
    .reverse()
    .find((event) => event.event.kind === "user")?.event;
  return event?.kind === "user" ? event.request_id : undefined;
}
