import { useEffect, useId, useRef, useState } from "react";
import { request, message } from "./api";
import {
  ChevronDown,
  ChevronUp,
  FileDiff,
  SquarePlus,
  Undo2,
} from "lucide-react";
import type { TurnChanges } from "./protocol";
import {
  parsePendingSideWriteSessionId,
  requestSideWriteConfirmation,
} from "./sideWritePrompts";
import { useStatusIssues } from "./statusNotices";
import { hasTurnChangeFiles } from "./transcript";
import { Button, DiffStat } from "./ui";
import { openSideChatTab } from "./workspaceState";

export function TurnChangesCard({
  changes: saved,
  open,
  openBlockingSideChat,
  hostId,
  sessionId,
  workspaceId,
  canUndo,
}: {
  changes: TurnChanges;
  hostId: string;
  sessionId: string;
  workspaceId?: string;
  openBlockingSideChat?: (sideId: string) => void | Promise<void>;
  canUndo: boolean;
  open: (path?: string) => void;
}) {
  const [changes, setChanges] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [navigatingSide, setNavigatingSide] = useState(false);
  const [error, setError] = useState("");
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const filesId = useId();
  const scope = JSON.stringify([
    hostId,
    sessionId,
    saved.request_id,
    saved.summary.baseline_at,
  ]);
  const expanded = expandedFor === scope;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [page, setPage] = useState<{
    scope: string;
    summary: TurnChanges["summary"];
    history: number[];
  } | null>(null);
  const [pageBusy, setPageBusy] = useState<string | null>(null);
  const [pageError, setPageError] = useState("");
  const pageTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const trigger = pageTrigger.current;
    if (
      pageBusy !== scope &&
      trigger?.isConnected &&
      (document.activeElement === document.body ||
        document.activeElement === trigger)
    ) {
      const target = trigger.disabled
        ? trigger.parentElement?.querySelector<HTMLButtonElement>(
            "button:not(:disabled)",
          )
        : trigger;
      target?.focus();
    }
  }, [pageBusy, page, scope]);
  useEffect(() => {
    setPageError("");
    setPageBusy(null);
  }, [scope]);
  const pendingSideId = parsePendingSideWriteSessionId(error);
  async function inspectBlockingSideChat(sideId: string) {
    if (navigatingSide) return;
    if (!openBlockingSideChat) {
      if (workspaceId) openSideChatTab(workspaceId, sideId, false);
      return;
    }
    setNavigatingSide(true);
    try {
      await openBlockingSideChat(sideId);
    } catch (cause) {
      if (mounted.current) setError(message(cause));
    } finally {
      if (mounted.current) setNavigatingSide(false);
    }
  }
  useStatusIssues([
    {
      id: `turn-undo:${hostId}:${sessionId}:${saved.request_id}`,
      title: "撤销本轮修改未完成",
      error: changes.undo === "reverted" ? "" : error,
      pending: busy || navigatingSide,
      action:
        pendingSideId && (openBlockingSideChat || workspaceId)
          ? {
              label: "核对侧边聊天",
              run: () => void inspectBlockingSideChat(pendingSideId),
            }
          : { label: "查看变更", run: () => open() },
    },
  ]);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => setChanges(saved), [saved]);
  const { summary } = changes;
  const firstPage =
    summary.entries.length > 64
      ? {
          ...summary,
          entries: summary.entries.slice(0, 64),
          total_files: summary.entries.length,
          offset: 0,
          next_offset: 64,
        }
      : summary;
  const currentPage = page?.scope === scope ? page.summary : firstPage;
  const history = page?.scope === scope ? page.history : [];
  const total = summary.total_files ?? summary.entries.length;
  const pageOffset = currentPage.offset ?? 0;
  async function loadPage(offset: number, previous: number[]) {
    if (pageBusy === scope) return;
    setPageBusy(scope);
    setPageError("");
    try {
      const loaded =
        summary.entries.length > 64
          ? {
              ...summary,
              entries: summary.entries.slice(offset, offset + 64),
              total_files: summary.entries.length,
              offset,
              next_offset:
                offset + 64 < summary.entries.length ? offset + 64 : undefined,
            }
          : await (async () => {
              const response = await request(hostId, {
                method: "turn_change_summary",
                session_id: sessionId,
                request_id: changes.request_id,
                offset,
              });
              if (response.kind !== "turn_changes")
                throw new Error("Server 不支持文件列表分页，请更新后重试");
              return response.changes.summary;
            })();
      if (mounted.current && scopeRef.current === scope)
        setPage({ scope, summary: loaded, history: previous });
    } catch (cause) {
      if (mounted.current && scopeRef.current === scope)
        setPageError(message(cause));
    } finally {
      if (mounted.current && scopeRef.current === scope) setPageBusy(null);
    }
  }
  useStatusIssues([
    {
      id: `turn-files:${hostId}:${sessionId}:${saved.request_id}`,
      title: "本轮文件列表未能读取",
      error: pageError,
      pending: pageBusy === scope,
      action: { label: "查看变更", run: () => open() },
    },
  ]);
  const undoLabel = busy
    ? "撤销中…"
    : changes.undo === "reverted"
      ? "已撤销"
      : changes.undo === "unknown"
        ? "状态待核对"
        : "撤销";
  const undoable =
    canUndo &&
    changes.undo === "ready" &&
    !summary.truncated &&
    !summary.unavailable &&
    !changes.background_pending;
  async function undo() {
    if (!undoable || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await request(hostId, {
        method: "undo_turn_changes",
        session_id: sessionId,
        request_id: changes.request_id,
      });
      if (response.kind !== "turn_changes")
        throw new Error("Server 不支持按轮次撤销，请更新后重试");
      if (mounted.current) setChanges(response.changes);
    } catch (cause) {
      const detail = message(cause);
      const sideId = parsePendingSideWriteSessionId(detail);
      if (sideId) requestSideWriteConfirmation(hostId, sideId);
      if (mounted.current) setError(detail);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  if (!hasTurnChangeFiles(changes)) return null;
  return (
    <section className="turn-changes-card" aria-label="本轮文件变更">
      <header>
        <span className="turn-changes-icon">
          <SquarePlus size={16} aria-hidden="true" />
        </span>
        <div className="turn-changes-heading">
          <strong>
            {summary.unavailable
              ? "本轮变更未能记录"
              : `已编辑 ${total} 个文件`}
          </strong>
          {!summary.unavailable && (
            <DiffStat added={summary.added} removed={summary.removed} />
          )}
        </div>
        {!summary.unavailable && (
          <div className="turn-changes-actions">
            <Button
              variant="ghost"
              size="xs"
              className="turn-changes-undo"
              aria-label={undoLabel}
              disabled={!undoable || busy}
              title={
                undoable
                  ? "撤销此轮文件修改；文件已发生后续变化时不会覆盖"
                  : changes.undo === "reverted"
                    ? "本轮文件修改已撤销"
                    : changes.undo === "unknown"
                      ? "撤销未能确认，请核对工作区"
                      : "仅可在本轮结束后撤销最近一轮的完整快照"
              }
              onClick={() => void undo()}
            >
              <span className="turn-changes-action-label">{undoLabel}</span>
              <Undo2 size={13.5} aria-hidden="true" />
            </Button>
            <Button
              variant="subtle"
              size="xs"
              aria-label="查看变更"
              title="查看变更"
              onClick={() => open()}
            >
              <span className="turn-changes-action-label">查看变更</span>
              <FileDiff
                size={13.5}
                className="turn-changes-view-icon"
                aria-hidden="true"
              />
            </Button>
          </div>
        )}
      </header>
      <div
        id={filesId}
        className={expanded ? "turn-changes-expanded" : undefined}
      >
        {(expanded
          ? currentPage.entries.slice(0, 64)
          : summary.entries.slice(0, 3)
        ).map((entry) => {
          const split = entry.path.lastIndexOf("/") + 1;
          return (
            <button
              type="button"
              className="turn-changes-file"
              key={entry.path}
              onClick={() => open(entry.path)}
              title={entry.path}
            >
              <span className="turn-changes-path">
                {split > 0 && (
                  <span className="turn-changes-directory">
                    {entry.path.slice(0, split)}
                  </span>
                )}
                <span className="turn-changes-name">
                  {entry.path.slice(split)}
                </span>
              </span>
              <span className="change-totals">
                {entry.added === null ? (
                  "二进制"
                ) : (
                  <DiffStat
                    added={entry.added ?? 0}
                    removed={entry.removed ?? 0}
                  />
                )}
              </span>
            </button>
          );
        })}
      </div>
      {expanded && (currentPage.next_offset != null || pageOffset > 0) && (
        <div className="turn-changes-pagination" aria-label="文件列表分页">
          <Button
            variant="ghost"
            size="xs"
            disabled={pageBusy === scope || !history.length}
            onClick={(event) => {
              pageTrigger.current = event.currentTarget;
              void loadPage(history.at(-1)!, history.slice(0, -1));
            }}
          >
            上一页
          </Button>
          <span>
            {pageOffset + 1}–{pageOffset + currentPage.entries.length} / {total}
          </span>
          <Button
            variant="ghost"
            size="xs"
            disabled={pageBusy === scope || currentPage.next_offset == null}
            onClick={(event) => {
              pageTrigger.current = event.currentTarget;
              void loadPage(currentPage.next_offset!, [...history, pageOffset]);
            }}
          >
            下一页
          </Button>
        </div>
      )}
      {(total > 3 || firstPage.next_offset != null) && (
        <button
          className="turn-changes-more"
          aria-expanded={expanded}
          aria-controls={filesId}
          onClick={() => setExpandedFor(expanded ? null : scope)}
        >
          {expanded
            ? "收起文件列表"
            : firstPage.next_offset != null
              ? `展开文件列表（共 ${total} 个）`
              : `再显示 ${total - 3} 个文件`}
          {expanded ? (
            <ChevronUp size={14} aria-hidden="true" />
          ) : (
            <ChevronDown size={14} aria-hidden="true" />
          )}
        </button>
      )}
    </section>
  );
}
