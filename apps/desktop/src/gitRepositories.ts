import { useSyncExternalStore } from "react";
import { request } from "./api";
import type { GitRepository, Project } from "./protocol";
import type { SelectOption } from "./Select";

const MAX_SELECTED_REPOSITORIES = 128;
const selectedRepositories = new Map<string, string>();
const listeners = new Set<() => void>();

function projectScopeKey(
  hostId: string,
  project?: Pick<Project, "id" | "path">,
) {
  return project ? JSON.stringify([hostId, project.id, project.path]) : "";
}

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isNotGitRepositoryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "not_git_repository"
  );
}

export function isRemovedGitRepositoryError(error: unknown): boolean {
  if (isNotGitRepositoryError(error)) return true;
  const text = error instanceof Error ? error.message : String(error);
  return /子仓库目录不存在|子仓库路径不是目录|不是独立的 Git 仓库|无法解析 Git (?:共享)?元数据路径/.test(
    text,
  );
}

export function isEmptyRepositoryReviewError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /仓库尚无提交/.test(text);
}

export function normalizeGitRepoPath(
  repoPath?: string | null,
): string | undefined {
  return repoPath && repoPath !== "." ? repoPath : undefined;
}

export function getSelectedGitRepository(
  hostId: string,
  project?: Pick<Project, "id" | "path">,
): string | undefined {
  const key = projectScopeKey(hostId, project);
  return key ? selectedRepositories.get(key) : undefined;
}

export function setSelectedGitRepository(
  hostId: string,
  project: Pick<Project, "id" | "path">,
  repoPath?: string,
) {
  const key = projectScopeKey(hostId, project);
  const value = repoPath || undefined;
  const previous = selectedRepositories.get(key);
  if (previous === value) return;
  selectedRepositories.delete(key);
  if (value !== undefined) {
    selectedRepositories.set(key, value);
    while (selectedRepositories.size > MAX_SELECTED_REPOSITORIES) {
      selectedRepositories.delete(selectedRepositories.keys().next().value!);
    }
  }
  notify();
}

export function clearSelectedGitRepositoriesForTests() {
  selectedRepositories.clear();
  notify();
}

export function useSelectedGitRepository(
  hostId: string,
  project?: Pick<Project, "id" | "path">,
): [string | undefined, (repoPath?: string) => void] {
  const value = useSyncExternalStore(subscribe, () =>
    getSelectedGitRepository(hostId, project),
  );
  return [
    value,
    (repoPath?: string) => {
      if (project) setSelectedGitRepository(hostId, project, repoPath);
    },
  ];
}

export async function readGitRepositories(
  hostId: string,
  projectId: string,
): Promise<{ repositories: GitRepository[]; truncated: boolean }> {
  try {
    const response = await request(hostId, {
      method: "git_repositories",
      project_id: projectId,
    });
    if (response.kind !== "git_repositories") {
      throw new Error("Server 不支持子仓库扫描，请更新后重试");
    }
    return {
      repositories: response.repositories,
      truncated: response.truncated,
    };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "invalid_request"
    ) {
      return { repositories: [], truncated: false };
    }
    throw error;
  }
}

export function matchRepositoryForPath(
  repositories: GitRepository[],
  filePath?: string,
): GitRepository | undefined {
  if (!filePath || !repositories.length) return undefined;
  const candidates = repositories
    .filter(
      (repo) =>
        repo.path !== "." &&
        (filePath === repo.path || filePath.startsWith(`${repo.path}/`)),
    )
    .sort((a, b) => b.path.length - a.path.length);
  return candidates[0];
}

export function stripRepositoryPrefix(
  filePath: string | undefined,
  repoPath?: string,
): string {
  if (!filePath) return "";
  const normalized = normalizeGitRepoPath(repoPath);
  if (!normalized) return filePath;
  if (filePath === normalized) return "";
  return filePath.startsWith(`${normalized}/`)
    ? filePath.slice(normalized.length + 1)
    : filePath;
}

export function formatGitRepositoryOption(repo: GitRepository): SelectOption {
  const description =
    repo.kind === "root"
      ? "项目根目录"
      : repo.kind === "submodule"
        ? "子模块"
        : repo.kind === "worktree"
          ? repo.path !== repo.name
            ? `工作树 · ${repo.path}`
            : "工作树"
          : repo.path !== repo.name
            ? repo.path
            : undefined;
  return {
    value: repo.path,
    label: repo.name,
    ...(description ? { description } : {}),
  };
}
