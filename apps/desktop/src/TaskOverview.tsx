import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, GitCompareArrows, Pin } from "lucide-react";
import { request, message } from "./api";
import type { Project } from "./protocol";
import type { SubagentsState } from "./useSubagents";
import { subagentCounts } from "./SubagentsPanel";
import { useStatusIssues } from "./statusNotices";
import { DiffStat, IconButton } from "./ui";
import { SideChatHistory, type SideChatHistoryProps } from "./SideChatHistory";
import {
  isEmptyRepositoryReviewError,
  isNotGitRepositoryError,
  isRemovedGitRepositoryError,
  normalizeGitRepoPath,
  readGitRepositories,
  useSelectedGitRepository,
} from "./gitRepositories";

export function TaskOverview({
  hostId,
  project,
  connected,
  subagents,
  openChanges,
  openSubagents,
  openInfo,
  sideChatHistory,
}: {
  hostId: string;
  project?: Project;
  connected: boolean;
  subagents: SubagentsState;
  openChanges: () => void;
  openSubagents: () => void;
  openInfo: () => void;
  sideChatHistory?: SideChatHistoryProps;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [selectedRepo, setSelectedRepo] = useSelectedGitRepository(
    hostId,
    project,
  );
  const [changes, setChanges] = useState<{
    count?: number;
    added?: number;
    removed?: number;
    binary?: number;
    truncated?: boolean;
    nonGit?: boolean;
    repoLabel?: string;
    repoCount?: number;
    error?: string;
  }>({});
  useStatusIssues([
    {
      id: `overview-changes:${hostId}:${project?.id}`,
      title: "变更概览暂不可用",
      error: connected ? (changes.error ?? "") : "",
      pending:
        open &&
        connected &&
        !!project &&
        changes.count === undefined &&
        !changes.nonGit &&
        !changes.repoCount &&
        !changes.error,
      action: {
        label: "查看变更",
        run: () => {
          setOpen(false);
          openChanges();
        },
      },
    },
  ]);
  const close = () => setOpen(false);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setChanges({});
    if (connected && project) {
      const repoArg = normalizeGitRepoPath(selectedRepo);
      void (async () => {
        try {
          const response = await request(hostId, {
            method: "git_review",
            project_id: project.id,
            scope: "branch",
            base: null,
            ...(repoArg ? { repo_path: repoArg } : {}),
          });
          if (response.kind !== "git_review") throw new Error("无法读取变更");
          if (!disposed) {
            setChanges({
              count: response.review.entries.length,
              added: response.review.added,
              removed: response.review.removed,
              binary: response.review.entries.filter((entry) => entry.binary)
                .length,
              truncated: response.review.truncated,
              repoLabel: repoArg,
            });
          }
        } catch (cause) {
          if (!isNotGitRepositoryError(cause) && !repoArg) {
            if (!disposed) setChanges({ error: message(cause) });
            return;
          }
          let discovered: {
            repositories: { path: string; name: string }[];
            truncated: boolean;
          };
          try {
            discovered = await readGitRepositories(hostId, project.id);
          } catch (scanCause) {
            if (!disposed) {
              setChanges({
                error: message(
                  isNotGitRepositoryError(cause) ? scanCause : cause,
                ),
              });
            }
            return;
          }
          if (disposed) return;
          const { repositories, truncated } = discovered;
          if (
            repoArg &&
            (truncated ||
              !isRemovedGitRepositoryError(cause) ||
              repositories.some((repo) => repo.path === repoArg))
          ) {
            setChanges({ error: message(cause) });
            return;
          }
          if (!repositories.length) {
            if (repoArg && !truncated && isRemovedGitRepositoryError(cause))
              setSelectedRepo(undefined);
            setChanges(
              truncated
                ? { error: "子目录过多，未能完成 Git 仓库扫描" }
                : { nonGit: true },
            );
            return;
          }
          const chosen =
            repositories.find((repo) => repo.path === selectedRepo) ??
            repositories[0];
          if (repoArg && chosen.path !== repoArg) {
            setSelectedRepo(chosen.path);
          }
          const fallbackArg = normalizeGitRepoPath(chosen.path);
          try {
            const response = await request(hostId, {
              method: "git_review",
              project_id: project.id,
              scope: "branch",
              base: null,
              ...(fallbackArg ? { repo_path: fallbackArg } : {}),
            });
            if (response.kind !== "git_review") throw new Error("无法读取变更");
            if (!disposed) {
              setChanges({
                count: response.review.entries.length,
                added: response.review.added,
                removed: response.review.removed,
                binary: response.review.entries.filter((entry) => entry.binary)
                  .length,
                truncated: response.review.truncated,
                repoLabel: chosen.path !== "." ? chosen.name : undefined,
                repoCount: repositories.length,
              });
            }
          } catch (childCause) {
            if (!disposed) {
              if (
                isNotGitRepositoryError(childCause) ||
                isEmptyRepositoryReviewError(childCause)
              ) {
                setChanges({
                  repoLabel: chosen.path !== "." ? chosen.name : undefined,
                  repoCount: repositories.length,
                });
              } else {
                setChanges({ error: message(childCause) });
              }
            }
          }
        }
      })();
    }
    popup.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
    const outside = (event: PointerEvent) => {
      if (
        !popup.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        close();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
        trigger.current?.focus();
      }
      if (event.key === "Tab") close();
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const buttons = [
          ...(popup.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) ?? []),
        ];
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        buttons[
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  buttons.length) %
                buttons.length
        ]?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", keyboard, true);
    window.addEventListener("resize", close);
    return () => {
      disposed = true;
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", keyboard, true);
      window.removeEventListener("resize", close);
    };
  }, [open, hostId, project?.id, project?.path, selectedRepo, connected]);
  const counts = subagentCounts(subagents.tasks);
  const choose = (action: () => void) => {
    close();
    action();
  };
  const rect = trigger.current?.getBoundingClientRect();
  return (
    <>
      <button
        ref={trigger}
        className="panel-toggle icon-button"
        aria-label="任务概览"
        title="任务概览"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx={5.5} cy={6.5} r={3} />
          <circle cx={5.5} cy={17.5} r={3} />
          <path d="M12.5 6.5h9M12.5 17.5h8" />
        </svg>
      </button>
      {open &&
        rect &&
        createPortal(
          <div
            ref={popup}
            role="dialog"
            aria-label="任务概览"
            className="task-overview-popover"
            style={{
              right: Math.max(8, window.innerWidth - rect.right),
              top: rect.bottom + 8,
            }}
          >
            <div className="task-overview-heading">
              <div className="task-overview-project">
                {project?.name ?? "新任务"}
              </div>
              <IconButton
                size="xs"
                label="固定到右侧栏"
                title="固定到右侧栏 · 任务摘要"
                onClick={() => choose(openInfo)}
              >
                <Pin size={14} />
              </IconButton>
            </div>
            <button
              type="button"
              className="task-overview-row"
              disabled={!project}
              onClick={() => choose(openChanges)}
            >
              <GitCompareArrows size={15} />
              <strong>变更</strong>
              <span>
                {!connected || changes.error
                  ? "—"
                  : changes.nonGit
                    ? "此项目无 Git 分支信息"
                    : changes.count === undefined
                      ? changes.repoCount
                        ? `${changes.repoCount} 个 Git 仓库`
                        : "读取中…"
                      : `${changes.count} 个文件${changes.truncated ? " · 部分记录" : ""}`}
              </span>
            </button>
            {changes.count !== undefined && !changes.error && (
              <div className="overview-change-stats">
                <DiffStat
                  added={changes.added ?? 0}
                  removed={changes.removed ?? 0}
                />
                <small>
                  {changes.repoLabel ? `${changes.repoLabel} · 分支` : "分支"}
                  {changes.repoCount && changes.repoCount > 1
                    ? ` · 共 ${changes.repoCount} 个仓库`
                    : ""}
                  {changes.binary ? " · 含二进制变更" : ""}
                </small>
              </div>
            )}
            <section>
              <h2>子智能体</h2>
              <button
                type="button"
                className="task-overview-row"
                disabled={!project}
                onClick={() => choose(openSubagents)}
              >
                <Bot size={15} />
                <span>
                  {counts.active > 0 && `${counts.active} 个运行中 · `}
                  {counts.completed} 完成
                  {counts.other > 0 && ` · ${counts.other} 项需查看`}
                </span>
              </button>
            </section>
            {sideChatHistory && (
              <section>
                <h2>侧边聊天</h2>
                <SideChatHistory
                  {...sideChatHistory}
                  onOpen={(id, title) =>
                    choose(() =>
                      title !== undefined
                        ? sideChatHistory.onOpen(id, title)
                        : sideChatHistory.onOpen(id),
                    )
                  }
                />
              </section>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
