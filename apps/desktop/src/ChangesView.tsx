import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowRight, MoreHorizontal } from "lucide-react";
import type {
  ChangeSummary,
  GitCommit,
  GitInfo,
  GitRepository,
  GitReview,
  Project,
  TurnChanges,
} from "./protocol";
import { request, message } from "./api";
import { ChangeScopePicker, type ReviewScope } from "./ChangeScopePicker";
import {
  formatGitRepositoryOption,
  isNotGitRepositoryError,
  isRemovedGitRepositoryError,
  matchRepositoryForPath,
  normalizeGitRepoPath,
  readGitRepositories,
  stripRepositoryPrefix,
  useSelectedGitRepository,
} from "./gitRepositories";
import { ReviewOptions } from "./ReviewOptions";
import { ReviewWorkspace } from "./ReviewWorkspace";
import { loadChangeImage } from "./changeImageLoader";
import { formatMessageTimestamp } from "./MessageTimestamp";
import { Select } from "./Select";
import { useStatusIssues } from "./statusNotices";
import { Button, IconButton, NoticeBanner } from "./ui";
type Snapshot = {
  scope: ReviewScope;
  context: string;
  review: GitReview;
  turn?: TurnChanges;
  summary?: ChangeSummary;
  sessionId?: string;
};
export function ChangesView({
  hostId,
  project,
  active,
  sessionId,
  lastTurnVersion,
  requestId,
  snapshotAt,
  initialPath,
  initialScope = requestId ? "turn" : "branch",
}: {
  hostId: string;
  project: Project;
  active: boolean;
  sessionId?: string;
  lastTurnVersion?: string;
  requestId?: string;
  snapshotAt?: number | null;
  initialPath?: string;
  initialScope?: ReviewScope;
}) {
  const [scope, setScope] = useState<ReviewScope>(initialScope);
  const userChoseScope = useRef(Boolean(requestId));
  const [selectedRepo, setSelectedRepo] = useSelectedGitRepository(
    hostId,
    project,
  );
  const projectKey = JSON.stringify([hostId, project.id, project.path]);
  const [discoveredRepos, setDiscoveredRepos] = useState<{
    scopeKey: string;
    list: GitRepository[];
    truncated: boolean;
    noGit: boolean;
  }>();
  const repositories =
    discoveredRepos?.scopeKey === projectKey ? discoveredRepos.list : [];
  const repositoriesTruncated =
    discoveredRepos?.scopeKey === projectKey
      ? discoveredRepos.truncated
      : false;
  const noGit =
    discoveredRepos?.scopeKey === projectKey ? discoveredRepos.noGit : false;
  const effectiveRepo =
    selectedRepo &&
    (!repositories.length ||
      repositories.some((repo) => repo.path === selectedRepo))
      ? selectedRepo
      : repositories[0]?.path;
  const repoArg = normalizeGitRepoPath(effectiveRepo);
  const repoScopeKey = JSON.stringify([
    hostId,
    project.id,
    project.path,
    repoArg ?? ".",
  ]);
  const [infoState, setInfoState] = useState<{
    scopeKey: string;
    info: GitInfo;
  }>();
  const info =
    infoState?.scopeKey === repoScopeKey ? infoState.info : undefined;
  const [baseState, setBaseState] = useState<{
    scopeKey: string;
    base: string;
  }>({ scopeKey: repoScopeKey, base: "" });
  const base = baseState.scopeKey === repoScopeKey ? baseState.base : "";
  const setBase = useCallback(
    (nextBase: string) =>
      setBaseState({ scopeKey: repoScopeKey, base: nextBase }),
    [repoScopeKey],
  );
  const [commitState, setCommitState] = useState<{
    scopeKey: string;
    commit: GitCommit;
  }>();
  const commit =
    commitState?.scopeKey === repoScopeKey ? commitState.commit : undefined;
  const gitMode = [
    "branch",
    "commit",
    "worktree",
    "unstaged",
    "staged",
  ].includes(scope);
  const scopedInitialPath = gitMode
    ? stripRepositoryPrefix(initialPath, effectiveRepo)
    : initialPath;
  const context = JSON.stringify([
    hostId,
    project.id,
    project.path,
    gitMode ? (repoArg ?? ".") : null,
    scope,
    gitMode ? null : sessionId,
    scope === "turn" ? requestId : null,
    scope === "lastTurn" ? lastTurnVersion : null,
    gitMode ? null : initialPath,
    scope === "branch" ? base : scope === "commit" ? commit?.oid : null,
  ]);
  const [filePage, setFilePage] = useState<{
    context: string;
    offset: number;
    history: number[];
  }>();
  const pageOffset =
    filePage?.context === context ? filePage.offset : undefined;
  const pageHistory = filePage?.context === context ? filePage.history : [];
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const review = snapshot?.context === context ? snapshot.review : undefined;
  const turn = review ? snapshot?.turn : undefined;
  const summary = review ? snapshot?.summary : undefined;
  const [selected, select] = useState(initialPath ?? "");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const pagingFocus = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const trigger = pagingFocus.current;
    if (
      !loading &&
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
  }, [loading, snapshot]);
  const [revision, refresh] = useState(0);
  const issueId = useId();
  useStatusIssues([
    {
      id: `changes:${issueId}`,
      title: `${project.name} 的变更未能读取`,
      error: active ? error : "",
      pending: active && loading,
      action: { label: "重试", run: () => refresh((value) => value + 1) },
    },
  ]);
  const [fullContext, setFullContext] = useState(false);
  const [more, setMore] = useState(false);
  const moreTrigger = useRef<HTMLButtonElement>(null);
  const closeMore = useCallback((restoreFocus = true) => {
    setMore(false);
    if (restoreFocus) moreTrigger.current?.focus();
  }, []);
  const turnRevision = gitMode ? 0 : revision;
  const lastRepoScopeKey = useRef(repoScopeKey);
  const selection = useRef(selected);
  selection.current = selected;
  useEffect(() => {
    select(scopedInitialPath ?? "");
  }, [scopedInitialPath]);
  useEffect(() => {
    userChoseScope.current = Boolean(requestId);
    setInfoState(undefined);
    setBaseState({ scopeKey: repoScopeKey, base: "" });
    setCommitState(undefined);
    setScope((previous) => (previous === "commit" ? "branch" : previous));
    setSnapshot(undefined);
    select(scopedInitialPath ?? "");
    setError("");
  }, [hostId, project.id, project.path]);
  useEffect(() => {
    if (lastRepoScopeKey.current === repoScopeKey) return;
    lastRepoScopeKey.current = repoScopeKey;
    setScope((previous) => (previous === "commit" ? "branch" : previous));
    setSnapshot(undefined);
    select(scopedInitialPath ?? "");
    setError("");
  }, [repoScopeKey, scopedInitialPath]);
  useEffect(() => {
    if (!active || !gitMode || noGit) return;
    setLoading(true);
    setError("");
    let disposed = false;
    void (async () => {
      try {
        const response = await request(hostId, {
          method: "git_info",
          project_id: project.id,
          ...(repoArg ? { repo_path: repoArg } : {}),
        });
        if (response.kind !== "git_info")
          throw new Error("Server 不支持分支审阅，请更新后重试");
        if (disposed) return;
        if (response.info.repositories?.length) {
          const matched = !selectedRepo
            ? matchRepositoryForPath(response.info.repositories, initialPath)
            : undefined;
          setDiscoveredRepos({
            scopeKey: projectKey,
            list: response.info.repositories,
            truncated: Boolean(response.info.repositories_truncated),
            noGit: false,
          });
          if (matched && matched.path !== ".") {
            setSelectedRepo(matched.path);
            return;
          }
        } else if (
          repoArg &&
          (discoveredRepos?.scopeKey !== projectKey || revision > 0)
        ) {
          try {
            const latest = await readGitRepositories(hostId, project.id);
            if (disposed) return;
            if (latest.repositories.length) {
              const list = latest.repositories.some(
                (repo) => repo.path === repoArg,
              )
                ? latest.repositories
                : [
                    ...latest.repositories,
                    {
                      path: repoArg,
                      name: repoArg,
                      kind: "repository" as const,
                    },
                  ];
              setDiscoveredRepos({
                scopeKey: projectKey,
                list,
                truncated: latest.truncated,
                noGit: false,
              });
            }
          } catch {
            if (disposed) return;
          }
        }
        setInfoState({ scopeKey: repoScopeKey, info: { ...response.info } });
        setBaseState((previous) =>
          previous.scopeKey === repoScopeKey && previous.base
            ? previous
            : {
                scopeKey: repoScopeKey,
                base: response.info.default_base || "HEAD",
              },
        );
      } catch (cause) {
        if (disposed) return;
        if (!isNotGitRepositoryError(cause) && !repoArg) {
          setError(message(cause));
          setLoading(false);
          return;
        }
        let discovered: {
          repositories: GitRepository[];
          truncated: boolean;
        };
        try {
          discovered = await readGitRepositories(hostId, project.id);
        } catch (scanCause) {
          if (!disposed) {
            setError(
              message(isNotGitRepositoryError(cause) ? scanCause : cause),
            );
            setLoading(false);
          }
          return;
        }
        if (disposed) return;
        if (
          repoArg &&
          (discovered.truncated ||
            !isRemovedGitRepositoryError(cause) ||
            discovered.repositories.some((repo) => repo.path === repoArg))
        ) {
          const list = discovered.repositories.some(
            (repo) => repo.path === repoArg,
          )
            ? discovered.repositories
            : [
                ...discovered.repositories,
                {
                  path: repoArg,
                  name: repoArg,
                  kind: "repository" as const,
                },
              ];
          setDiscoveredRepos({
            scopeKey: projectKey,
            list,
            truncated: discovered.truncated,
            noGit: false,
          });
          setInfoState(undefined);
          setError(message(cause));
          setLoading(false);
          return;
        }
        if (discovered.repositories.length > 0) {
          const matched = matchRepositoryForPath(
            discovered.repositories,
            initialPath,
          );
          const chosen =
            (selectedRepo &&
            selectedRepo !== effectiveRepo &&
            discovered.repositories.some((repo) => repo.path === selectedRepo)
              ? discovered.repositories.find(
                  (repo) => repo.path === selectedRepo,
                )
              : undefined) ??
            (matched && matched.path !== repoArg ? matched : undefined) ??
            discovered.repositories[0];
          setDiscoveredRepos({
            scopeKey: projectKey,
            list: discovered.repositories,
            truncated: discovered.truncated,
            noGit: false,
          });
          setInfoState(undefined);
          setBaseState({ scopeKey: repoScopeKey, base: "" });
          setCommitState(undefined);
          setSelectedRepo(chosen.path);
          return;
        }
        if (
          repoArg &&
          !discovered.truncated &&
          isRemovedGitRepositoryError(cause)
        ) {
          setSelectedRepo(undefined);
        }
        if (discovered.truncated) {
          setDiscoveredRepos({
            scopeKey: projectKey,
            list: [],
            truncated: true,
            noGit: false,
          });
          setInfoState(undefined);
          setError(
            "子目录过多，扫描范围内未定位到 Git 仓库；请直接打开对应子仓库目录。",
          );
          setLoading(false);
          return;
        }
        setDiscoveredRepos({
          scopeKey: projectKey,
          list: [],
          truncated: false,
          noGit: true,
        });
        setInfoState(undefined);
        setLoading(false);
        if (sessionId && !userChoseScope.current) {
          setScope("task");
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, [
    active,
    hostId,
    project.id,
    project.path,
    projectKey,
    repoArg,
    repoScopeKey,
    noGit,
    revision,
    gitMode,
  ]);
  useEffect(() => {
    if (
      !active ||
      (gitMode && (noGit || !info || (scope === "branch" && !base)))
    )
      return;
    if (scope === "commit" && !commit) return;
    let disposed = false;
    setLoading(true);
    setError("");
    setSnapshot((previous) =>
      previous?.context === context ? previous : undefined,
    );
    setMore(false);
    if (!gitMode && !sessionId) {
      setLoading(false);
      select("");
      return;
    }
    void request(
      hostId,
      scope === "lastTurn"
        ? {
            method: "last_turn_changes",
            session_id: sessionId!,
            offset: pageOffset,
            path: pageOffset === undefined ? initialPath : undefined,
          }
        : scope === "turn"
          ? {
              method: "turn_change_summary",
              session_id: sessionId!,
              request_id: requestId!,
              offset: pageOffset,
              path: pageOffset === undefined ? initialPath : undefined,
            }
          : scope === "task"
            ? {
                method: "change_summary",
                project_id: project.id,
                session_id: sessionId!,
                offset: pageOffset,
                path: pageOffset === undefined ? initialPath : undefined,
              }
            : {
                method: "git_review",
                project_id: project.id,
                scope: scope as Exclude<
                  ReviewScope,
                  "lastTurn" | "turn" | "task"
                >,
                base:
                  scope === "branch"
                    ? base
                    : scope === "commit" && commit
                      ? commit.oid
                      : null,
                ...(repoArg ? { repo_path: repoArg } : {}),
              },
    )
      .then((response) => {
        if (disposed) return;
        if (
          scope === "lastTurn" &&
          response.kind === "last_turn_changes" &&
          !response.changes
        ) {
          select("");
          return;
        }
        const changes =
          response.kind === "last_turn_changes"
            ? (response.changes ?? undefined)
            : response.kind === "turn_changes"
              ? response.changes
              : undefined;
        const summary =
          changes?.summary ??
          (response.kind === "change_summary" ? response.summary : undefined);
        const result: GitReview | undefined = !gitMode
          ? summary && {
              base: null,
              head: null,
              entries: summary.entries.map((entry) => ({
                ...entry,
                previous_path: null,
                binary: false,
                untracked: false,
              })),
              added: summary.added,
              removed: summary.removed,
              truncated: summary.truncated,
            }
          : response.kind === "git_review"
            ? response.review
            : undefined;
        if (!result)
          throw new Error(
            !gitMode
              ? "Server 不支持回合快照，请更新后重试"
              : "Server 不支持 Git 审阅，请更新后重试",
          );
        if (!disposed) {
          setSnapshot({
            scope,
            context,
            review: result,
            turn: changes,
            summary,
            sessionId,
          });
          setError(summary?.unavailable ?? "");
          select(
            result.entries.some((file) => file.path === selection.current)
              ? selection.current
              : (result.entries[0]?.path ?? ""),
          );
        }
      })
      .catch((cause) => {
        if (!disposed && !isNotGitRepositoryError(cause))
          setError(message(cause));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [
    active,
    hostId,
    project.id,
    project.path,
    repoArg,
    noGit,
    scope,
    base,
    info,
    sessionId,
    scope === "lastTurn" ? lastTurnVersion : null,
    turnRevision,
    requestId,
    commit,
    context,
    gitMode,
    pageOffset,
    initialPath,
  ]);
  const loadDiff = useCallback(
    async (path: string) => {
      const response = await request(
        hostId,
        scope === "lastTurn" || scope === "turn"
          ? {
              method: "turn_change_diff",
              session_id: snapshot!.sessionId!,
              request_id: turn!.request_id,
              path,
            }
          : scope === "task"
            ? {
                method: "task_change_diff",
                session_id: snapshot!.sessionId!,
                path,
              }
            : {
                method: "git_review_diff",
                project_id: project.id,
                scope: scope as Exclude<
                  ReviewScope,
                  "lastTurn" | "turn" | "task"
                >,
                base: review!.base,
                head: review!.head,
                path,
                full_context: fullContext,
                ...(repoArg ? { repo_path: repoArg } : {}),
              },
      );
      if (response.kind !== "content") throw new Error("无法读取文件差异");
      return response;
    },
    [
      hostId,
      project.id,
      project.path,
      repoArg,
      scope,
      snapshot,
      turn,
      review,
      fullContext,
    ],
  );
  const loadImage = useCallback(
    (path: string, before: boolean, valid: () => boolean) =>
      loadChangeImage(
        hostId,
        scope === "turn" || scope === "lastTurn"
          ? {
              kind: "turn",
              session_id: snapshot!.sessionId!,
              request_id: turn!.request_id,
            }
          : scope === "task"
            ? { kind: "task", session_id: snapshot!.sessionId! }
            : {
                kind: "git",
                project_id: project.id,
                scope: scope as Exclude<
                  ReviewScope,
                  "lastTurn" | "turn" | "task"
                >,
                base: review!.base,
                head: review!.head,
                ...(repoArg ? { repo_path: repoArg } : {}),
              },
        path,
        before,
        valid,
      ),
    [hostId, project.id, project.path, repoArg, scope, snapshot, turn, review],
  );
  const options = info
    ? [
        ...info.refs.map((ref) => ({ value: ref.full_name, label: ref.name })),
        { value: "HEAD", label: "当前提交" },
      ]
    : [];
  const showRepositoryPicker =
    gitMode &&
    (repositories.length > 1 ||
      (repositories.length === 1 && repositories[0].path !== "."));
  const repositoryOptions = repositories.map(formatGitRepositoryOption);
  const repositoryControl = showRepositoryPicker ? (
    <div className="git-review-repo-select">
      <Select
        label="Git 仓库"
        compact
        value={effectiveRepo ?? repositories[0].path}
        options={repositoryOptions}
        onChange={(nextRepo) => {
          setInfoState(undefined);
          setBaseState({ scopeKey: repoScopeKey, base: "" });
          setCommitState(undefined);
          setScope((previous) => (previous === "commit" ? "branch" : previous));
          setSnapshot(undefined);
          setSelectedRepo(nextRepo);
          select("");
        }}
        disabled={!active}
        minMenuWidth={240}
        searchable={repositories.length > 4}
        searchPlaceholder="搜索仓库、子模块或工作树"
      />
    </div>
  ) : null;
  const scopeControl = (
    <>
      <ChangeScopePicker
        hostId={hostId}
        projectId={project.id}
        repoPath={repoArg}
        sessionId={sessionId}
        requestId={requestId}
        scope={scope}
        commit={commit}
        disabled={!active}
        choose={(value, nextCommit) => {
          userChoseScope.current = true;
          setScope(value);
          if (nextCommit) {
            setCommitState({ scopeKey: repoScopeKey, commit: nextCommit });
          }
          select(value === "turn" ? (initialPath ?? "") : "");
        }}
      />
    </>
  );
  return (
    <ReviewWorkspace
      key={JSON.stringify([
        hostId,
        project.id,
        project.path,
        sessionId,
        requestId,
      ])}
      repositoryControl={repositoryControl}
      scopeControl={scopeControl}
      comparisonControl={
        scope === "branch" && !noGit ? (
          <div className="git-review-comparison">
            <span title={info?.head ?? ""}>
              {info?.branch ?? (info?.head ? "分离 HEAD" : "分支")}
            </span>
            <ArrowRight size={14} />
            <Select
              label="比较基准"
              compact
              value={base}
              options={options}
              onChange={setBase}
              disabled={!active || !info}
              minMenuWidth={200}
              searchable
              searchPlaceholder="搜索分支"
            />
          </div>
        ) : null
      }
      files={review?.entries ?? []}
      added={review?.added ?? 0}
      removed={review?.removed ?? 0}
      active={active}
      initialPath={selected}
      loading={loading || (gitMode && !noGit && !info && !error)}
      unavailable={error || undefined}
      emptyLabel={
        gitMode && noGit
          ? "此项目及子目录未发现 Git 仓库"
          : scope === "lastTurn" && !turn
            ? "当前对话尚无已保存的回合快照"
            : !gitMode
              ? summary?.truncated
                ? "采集范围内没有已记录的文件变更"
                : `${scope === "task" ? "本任务" : "本轮"}没有文件变更`
              : "此范围没有变更"
      }
      loadDiff={loadDiff}
      loadImage={loadImage}
      refresh={() => {
        setFilePage(undefined);
        if (noGit) setDiscoveredRepos(undefined);
        refresh((v) => v + 1);
      }}
      additionalActions={
        <IconButton
          ref={moreTrigger}
          size="sm"
          active={more}
          label="更多差异选项"
          aria-haspopup="menu"
          aria-expanded={more}
          disabled={!review?.entries.length || !active}
          onClick={() => setMore((v) => !v)}
        >
          <MoreHorizontal size={15.5} />
        </IconButton>
      }
      overlay={
        more && active && moreTrigger.current ? (
          <ReviewOptions
            trigger={moreTrigger.current}
            fullContext={fullContext}
            frozen={!gitMode}
            choose={() => setFullContext((v) => !v)}
            close={closeMore}
          />
        ) : null
      }
      notices={
        <>
          {summary &&
            ((summary.offset ?? 0) > 0 || summary.next_offset != null) && (
              <div
                className="turn-changes-pagination"
                aria-label="变更文件分页"
              >
                <Button
                  variant="subtle"
                  size="xs"
                  disabled={
                    loading ||
                    !active ||
                    ((summary.offset ?? 0) === 0 && !pageHistory.length)
                  }
                  onClick={(event) => {
                    pagingFocus.current = event.currentTarget;
                    setFilePage({
                      context,
                      offset: pageHistory.at(-1) ?? 0,
                      history: pageHistory.slice(0, -1),
                    });
                  }}
                >
                  {pageHistory.length ? "上一页" : "返回第一页"}
                </Button>
                <span>
                  文件 {(summary.offset ?? 0) + 1}–
                  {(summary.offset ?? 0) + summary.entries.length} /{" "}
                  {summary.total_files ?? summary.entries.length}
                </span>
                <Button
                  variant="subtle"
                  size="xs"
                  disabled={loading || !active || summary.next_offset == null}
                  onClick={(event) => {
                    pagingFocus.current = event.currentTarget;
                    setFilePage({
                      context,
                      offset: summary.next_offset!,
                      history: [...pageHistory, summary.offset ?? 0],
                    });
                  }}
                >
                  下一页
                </Button>
              </div>
            )}

          {turn &&
            (turn.undo === "reverted" ||
              turn.undo === "unknown" ||
              turn.interrupted ||
              turn.background_pending) && (
              <NoticeBanner tone="neutral" className="panel-notice">
                {[
                  turn.undo === "reverted"
                    ? "本轮修改已撤销，仍显示原始快照。"
                    : turn.undo === "unknown"
                      ? "撤销状态待核对，仍显示原始快照。"
                      : "",
                  turn.interrupted ? "本轮已中断，保留已记录的修改。" : "",
                  turn.background_pending
                    ? "采集快照时后台任务尚未结束，保留当时已记录的修改。"
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              </NoticeBanner>
            )}
          {review?.truncated && (
            <NoticeBanner tone="warning" className="panel-notice">
              部分文件或统计超出采集范围。
            </NoticeBanner>
          )}
          {gitMode && info?.truncated && (
            <NoticeBanner tone="warning" className="panel-notice">
              分支列表仅显示部分结果。
            </NoticeBanner>
          )}
          {gitMode && repositoriesTruncated && (
            <p className="panel-notice">子目录仓库列表仅显示部分结果。</p>
          )}
        </>
      }
      boundary={
        scope === "task"
          ? "任务开始后的净变更；共享目录内可能包含其他写入。"
          : scope === "turn"
            ? `${snapshotAt ? (formatMessageTimestamp(snapshotAt) ?? "") + " · " : ""}对比本轮开始与结束时保存的内容；后续修改不会改变快照。共享目录中的同期写入也可能包含在内。`
            : scope === "commit"
              ? "所选提交相对第一父级的变更；首次提交对比空目录，不包含未提交修改。"
              : scope === "lastTurn"
                ? "对比上一轮开始与结束时保存的内容；后续修改不会改变快照。共享目录中的同期写入也可能包含在内。"
                : scope === "branch"
                  ? "对比当前提交与基准分支的共同祖先；未提交的修改在未提交范围查看。"
                  : scope === "worktree"
                    ? "当前工作区相对 HEAD 的净变更，包含暂存及未跟踪文件。"
                    : scope === "staged"
                      ? "暂存区相对 HEAD 的变更。"
                      : "工作区相对暂存区的变更，包含未跟踪文件。"
      }
    />
  );
}
