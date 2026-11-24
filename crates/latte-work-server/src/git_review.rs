//! Bounded, read-only Git review. Branch diffs use resolved commit IDs, not live refs.
use crate::files;
use anyhow::{Context, Result, bail};
use latte_work_protocol::{
    ChangeSection, GitCommit, GitInfo, GitRef, GitRepository, GitRepositoryKind, GitReview,
    GitReviewFile, GitReviewScope,
};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Component, Path, PathBuf},
    time::Duration,
};
use tokio::io::AsyncReadExt;
const FILE_LIMIT: usize = 1000;
const CONTENT_LIMIT: usize = 512 * 1024;
const REPO_SCAN_DIR_LIMIT: usize = 512;
const REPO_DIR_ENTRY_LIMIT: usize = 512;
const REPO_RESULT_LIMIT: usize = 64;
const REPO_CHILD_DEPTH_LIMIT: usize = 3;
const REPO_ROOT_NESTED_DEPTH_LIMIT: usize = 2;
const WORKTREE_CONTAINER_DEPTH_LIMIT: usize = 2;

async fn command(root: &Path, args: &[&str]) -> Result<String> {
    let (text, truncated) = files::git(root, args).await?;
    if truncated {
        bail!("Git 元数据超出读取上限，请缩小项目范围");
    }
    Ok(text.trim_end_matches('\n').into())
}
async fn commit(root: &Path, reference: &str) -> Result<String> {
    if reference.is_empty()
        || reference.len() > 256
        || reference.starts_with('-')
        || reference.chars().any(char::is_control)
        || reference.contains([':', '~', '^', '*', '?', '[', '\\'])
        || reference.contains("..")
    {
        bail!("无效的 Git 比较基准");
    }
    command(
        root,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{reference}^{{commit}}"),
        ],
    )
    .await
    .context("比较基准不存在或不是提交")
}
fn valid_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn valid_path(path: &str) -> Result<()> {
    if path.is_empty()
        || path.len() > 4096
        || path.contains('\0')
        || Path::new(path).is_absolute()
        || Path::new(path)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        bail!("路径必须位于项目目录内");
    }
    Ok(())
}
pub async fn info(root: &Path) -> Result<GitInfo> {
    tokio::time::timeout(Duration::from_secs(20), async {
        command(root, &["rev-parse", "--show-prefix"]).await?;
        let branch = command(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
            .await
            .ok();
        let head = commit(root, "HEAD").await.ok();
        let (text, mut truncated) = files::git(
            root,
            &[
                "for-each-ref",
                "--format=%(refname)%09%(refname:short)%09%(symref)",
                "refs/heads",
                "refs/remotes",
            ],
        )
        .await?;
        let mut refs = Vec::new();
        for line in text.lines() {
            let fields: Vec<_> = line.split('\t').collect();
            if fields.len() != 3 || !fields[2].is_empty() {
                continue;
            }
            if refs.len() == FILE_LIMIT {
                truncated = true;
                break;
            }
            refs.push(GitRef {
                full_name: fields[0].into(),
                name: fields[1].into(),
            });
        }
        let upstream = command(root, &["rev-parse", "--symbolic-full-name", "@{upstream}"])
            .await
            .ok();
        let default_base = upstream
            .filter(|refname| refs.iter().any(|r| &r.full_name == refname))
            .or_else(|| {
                [
                    "refs/remotes/origin/main",
                    "refs/remotes/origin/master",
                    "refs/heads/main",
                    "refs/heads/master",
                ]
                .iter()
                .find(|name| refs.iter().any(|r| r.full_name == **name))
                .map(|name| (*name).into())
            })
            .or_else(|| head.as_ref().map(|_| "HEAD".into()));
        Ok(GitInfo {
            branch,
            head,
            default_base,
            refs,
            truncated,
            repositories: None,
            repositories_truncated: None,
        })
    })
    .await
    .context("读取分支超时")?
}

fn is_ignored_scan_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules"
            | "target"
            | "dist"
            | "build"
            | "out"
            | "__pycache__"
            | "venv"
            | "Pods"
            | "DerivedData"
    )
}

fn repository_display_name(rel_path: &str, kind: GitRepositoryKind) -> String {
    if kind != GitRepositoryKind::Worktree {
        return rel_path.to_owned();
    }
    for prefix in [
        ".oh-my-code/worktree/",
        ".oh-my-code/worktrees/",
        ".claude/worktrees/",
        ".claude/worktree/",
        ".worktrees/",
        ".worktree/",
    ] {
        if let Some(rest) = rel_path.strip_prefix(prefix).filter(|s| !s.is_empty()) {
            return rest.to_owned();
        }
    }
    for infix in [
        "/.oh-my-code/worktree/",
        "/.oh-my-code/worktrees/",
        "/.claude/worktrees/",
        "/.claude/worktree/",
        "/.worktrees/",
        "/.worktree/",
    ] {
        if let Some((head, tail)) = rel_path.split_once(infix)
            && !head.is_empty()
            && !tail.is_empty()
        {
            return format!("{head}/{tail}");
        }
    }
    rel_path.to_owned()
}

async fn verify_contained_repository(
    canonical_root: &Path,
    canonical_repo: &Path,
    submodule_hint: bool,
) -> Result<GitRepositoryKind> {
    tokio::fs::symlink_metadata(canonical_repo.join(".git"))
        .await
        .map_err(|_| files::NotGitRepository)?;
    let output = command(
        canonical_repo,
        &[
            "rev-parse",
            "--show-toplevel",
            "--git-dir",
            "--git-common-dir",
        ],
    )
    .await?;
    let mut lines = output.lines();
    let (Some(raw_top), Some(raw_git_dir), Some(raw_common_dir)) =
        (lines.next(), lines.next(), lines.next())
    else {
        bail!("Git 仓库路径元数据不完整");
    };
    let toplevel = tokio::fs::canonicalize(canonical_repo.join(raw_top))
        .await
        .context("无法解析 Git 工作区路径")?;
    anyhow::ensure!(toplevel == canonical_repo, "所选子目录不是独立的 Git 仓库");
    let git_dir = tokio::fs::canonicalize(canonical_repo.join(raw_git_dir))
        .await
        .context("无法解析 Git 元数据路径")?;
    let git_common_dir = tokio::fs::canonicalize(canonical_repo.join(raw_common_dir))
        .await
        .context("无法解析 Git 共享元数据路径")?;
    anyhow::ensure!(
        git_dir.starts_with(canonical_root) && git_common_dir.starts_with(canonical_root),
        "拒绝访问指向项目外部的 Git 仓库"
    );
    Ok(if git_dir != git_common_dir {
        GitRepositoryKind::Worktree
    } else if submodule_hint || git_dir != canonical_repo.join(".git") {
        GitRepositoryKind::Submodule
    } else {
        GitRepositoryKind::Repository
    })
}

pub async fn resolve_repository(project_root: &Path, repo_path: Option<&str>) -> Result<PathBuf> {
    let Some(subpath) = repo_path
        .map(str::trim)
        .filter(|path| !path.is_empty() && *path != ".")
    else {
        return Ok(project_root.to_path_buf());
    };
    valid_path(subpath)?;
    let canonical_root = tokio::fs::canonicalize(project_root)
        .await
        .context("项目目录不存在或无法访问")?;
    let mut cursor = canonical_root.clone();
    for component in Path::new(subpath).components() {
        cursor.push(component);
        let meta = tokio::fs::symlink_metadata(&cursor)
            .await
            .context("子仓库目录不存在")?;
        anyhow::ensure!(!meta.file_type().is_symlink(), "拒绝访问符号链接仓库路径");
    }
    let meta = tokio::fs::symlink_metadata(&cursor)
        .await
        .context("子仓库目录不存在")?;
    anyhow::ensure!(meta.file_type().is_dir(), "子仓库路径不是目录");
    let canonical_repo = tokio::fs::canonicalize(&cursor).await?;
    anyhow::ensure!(
        canonical_repo.starts_with(&canonical_root),
        "拒绝访问指向项目外部的路径"
    );
    verify_contained_repository(&canonical_root, &canonical_repo, false).await?;
    Ok(canonical_repo)
}

#[derive(Clone, Copy)]
enum ScanMode {
    Normal { remaining: usize },
    ToolWorktreeParent,
    WorktreeContainer { remaining: usize },
}

async fn enqueue_worktree_containers(
    dir: &Path,
    rel_prefix: &str,
    queue: &mut VecDeque<(PathBuf, String, ScanMode)>,
) {
    for (name, mode) in [
        (
            ".worktree",
            ScanMode::WorktreeContainer {
                remaining: WORKTREE_CONTAINER_DEPTH_LIMIT,
            },
        ),
        (
            ".worktrees",
            ScanMode::WorktreeContainer {
                remaining: WORKTREE_CONTAINER_DEPTH_LIMIT,
            },
        ),
        (".oh-my-code", ScanMode::ToolWorktreeParent),
        (".claude", ScanMode::ToolWorktreeParent),
    ] {
        let candidate = dir.join(name);
        if tokio::fs::symlink_metadata(&candidate)
            .await
            .is_ok_and(|meta| meta.file_type().is_dir())
        {
            let rel = if rel_prefix.is_empty() {
                name.to_owned()
            } else {
                format!("{rel_prefix}/{name}")
            };
            queue.push_back((candidate, rel, mode));
        }
    }
}

async fn discover_submodules_for(
    canonical_root: &Path,
    initial_dir: &Path,
    initial_rel: &str,
    found_paths: &mut HashSet<String>,
    found: &mut Vec<GitRepository>,
    truncated: &mut bool,
) {
    let mut sub_queue =
        VecDeque::from([(initial_dir.to_path_buf(), initial_rel.to_owned(), 0_usize)]);
    while let Some((repo_dir, repo_rel, depth)) = sub_queue.pop_front() {
        if !tokio::fs::symlink_metadata(repo_dir.join(".gitmodules"))
            .await
            .is_ok_and(|meta| meta.file_type().is_file())
        {
            continue;
        }
        let Ok((output, partial)) = files::git(
            &repo_dir,
            &[
                "config",
                "--file",
                ".gitmodules",
                "--null",
                "--get-regexp",
                "^submodule\\..*\\.path$",
            ],
        )
        .await
        else {
            continue;
        };
        *truncated |= partial;
        for record in output.split('\0').filter(|entry| !entry.is_empty()) {
            let Some((_, raw_subpath)) = record.split_once('\n') else {
                continue;
            };
            let subpath = raw_subpath.trim();
            if valid_path(subpath).is_err() {
                continue;
            }
            let mut cursor = repo_dir.clone();
            let mut valid_dir = true;
            for component in Path::new(subpath).components() {
                cursor.push(component);
                if !tokio::fs::symlink_metadata(&cursor)
                    .await
                    .is_ok_and(|meta| meta.file_type().is_dir())
                {
                    valid_dir = false;
                    break;
                }
            }
            if !valid_dir {
                continue;
            }
            let Ok(canonical_sub) = tokio::fs::canonicalize(&cursor).await else {
                continue;
            };
            if !canonical_sub.starts_with(canonical_root) {
                continue;
            }
            let full_rel = if repo_rel.is_empty() {
                subpath.to_owned()
            } else {
                format!("{repo_rel}/{subpath}")
            };
            if found_paths.contains(&full_rel) {
                continue;
            }
            if verify_contained_repository(canonical_root, &canonical_sub, true)
                .await
                .is_ok()
            {
                if found.len() >= REPO_RESULT_LIMIT {
                    *truncated = true;
                    return;
                }
                found_paths.insert(full_rel.clone());
                found.push(GitRepository {
                    name: full_rel.clone(),
                    path: full_rel.clone(),
                    kind: GitRepositoryKind::Submodule,
                });
                if depth + 1 < 2 {
                    sub_queue.push_back((canonical_sub, full_rel, depth + 1));
                }
            }
        }
    }
}

pub async fn discover_repositories(project_root: &Path) -> Result<(Vec<GitRepository>, bool)> {
    tokio::time::timeout(Duration::from_secs(10), async {
        let canonical_root = tokio::fs::canonicalize(project_root)
            .await
            .context("项目目录不存在或无法访问")?;
        let mut found = Vec::new();
        let mut found_paths = HashSet::new();
        let mut truncated = false;
        let mut queue = VecDeque::new();

        let root_is_git = match command(&canonical_root, &["rev-parse", "--show-prefix"]).await {
            Ok(_) => true,
            Err(error) if error.is::<files::NotGitRepository>() => false,
            Err(error) => return Err(error),
        };
        if root_is_git {
            let root_name = project_root
                .file_name()
                .or_else(|| canonical_root.file_name())
                .and_then(|name| name.to_str())
                .filter(|name| !name.is_empty())
                .unwrap_or(".")
                .to_owned();
            found_paths.insert(".".into());
            found.push(GitRepository {
                path: ".".into(),
                name: root_name,
                kind: GitRepositoryKind::Root,
            });
            discover_submodules_for(
                &canonical_root,
                &canonical_root,
                "",
                &mut found_paths,
                &mut found,
                &mut truncated,
            )
            .await;
            enqueue_worktree_containers(&canonical_root, "", &mut queue).await;
            queue.push_back((
                canonical_root.clone(),
                String::new(),
                ScanMode::Normal {
                    remaining: REPO_ROOT_NESTED_DEPTH_LIMIT,
                },
            ));
        } else {
            queue.push_back((
                canonical_root.clone(),
                String::new(),
                ScanMode::Normal {
                    remaining: REPO_CHILD_DEPTH_LIMIT,
                },
            ));
        }

        let mut scanned_dirs = 0_usize;
        while let Some((dir, rel, mode)) = queue.pop_front() {
            if !rel.is_empty()
                && matches!(
                    mode,
                    ScanMode::Normal { .. } | ScanMode::WorktreeContainer { .. }
                )
                && tokio::fs::symlink_metadata(dir.join(".git")).await.is_ok()
            {
                if found_paths.contains(&rel) {
                    continue;
                }
                if let Ok(detected_kind) =
                    verify_contained_repository(&canonical_root, &dir, false).await
                {
                    if found.len() >= REPO_RESULT_LIMIT {
                        truncated = true;
                        break;
                    }
                    let kind = if matches!(mode, ScanMode::WorktreeContainer { .. }) {
                        GitRepositoryKind::Worktree
                    } else {
                        detected_kind
                    };
                    let name = repository_display_name(&rel, kind);
                    found_paths.insert(rel.clone());
                    found.push(GitRepository {
                        path: rel.clone(),
                        name,
                        kind,
                    });
                    if kind != GitRepositoryKind::Worktree {
                        discover_submodules_for(
                            &canonical_root,
                            &dir,
                            &rel,
                            &mut found_paths,
                            &mut found,
                            &mut truncated,
                        )
                        .await;
                        enqueue_worktree_containers(&dir, &rel, &mut queue).await;
                    }
                    continue;
                }
            }

            let can_descend = match mode {
                ScanMode::Normal { remaining } | ScanMode::WorktreeContainer { remaining } => {
                    remaining > 0
                }
                ScanMode::ToolWorktreeParent => true,
            };
            if !can_descend {
                continue;
            }
            if scanned_dirs >= REPO_SCAN_DIR_LIMIT {
                truncated = true;
                continue;
            }
            scanned_dirs += 1;

            let Ok(mut entries_iter) = tokio::fs::read_dir(&dir).await else {
                continue;
            };
            let mut children = Vec::new();
            while let Ok(Some(entry)) = entries_iter.next_entry().await {
                if children.len() >= REPO_DIR_ENTRY_LIMIT {
                    truncated = true;
                    break;
                }
                let Ok(file_type) = entry.file_type().await else {
                    continue;
                };
                if !file_type.is_dir() {
                    continue;
                }
                let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                children.push((name, entry.path()));
            }
            children.sort_by(|a, b| a.0.cmp(&b.0));

            for (name, child_path) in children {
                let next_mode = match mode {
                    ScanMode::ToolWorktreeParent => {
                        if matches!(name.as_str(), "worktree" | "worktrees") {
                            Some(ScanMode::WorktreeContainer {
                                remaining: WORKTREE_CONTAINER_DEPTH_LIMIT,
                            })
                        } else {
                            None
                        }
                    }
                    ScanMode::WorktreeContainer { remaining } => {
                        if name.starts_with('.') || is_ignored_scan_dir(&name) {
                            None
                        } else {
                            Some(ScanMode::WorktreeContainer {
                                remaining: remaining - 1,
                            })
                        }
                    }
                    ScanMode::Normal { remaining } => match name.as_str() {
                        ".worktree" | ".worktrees" => {
                            if root_is_git && rel.is_empty() {
                                None
                            } else {
                                Some(ScanMode::WorktreeContainer {
                                    remaining: WORKTREE_CONTAINER_DEPTH_LIMIT,
                                })
                            }
                        }
                        ".oh-my-code" | ".claude" => {
                            if root_is_git && rel.is_empty() {
                                None
                            } else {
                                Some(ScanMode::ToolWorktreeParent)
                            }
                        }
                        _ if name.starts_with('.') || is_ignored_scan_dir(&name) => None,
                        _ => Some(ScanMode::Normal {
                            remaining: remaining - 1,
                        }),
                    },
                };
                let Some(next_mode) = next_mode else {
                    continue;
                };
                let Ok(canonical_child) = tokio::fs::canonicalize(&child_path).await else {
                    continue;
                };
                if !canonical_child.starts_with(&canonical_root) {
                    continue;
                }
                let next_rel = if rel.is_empty() {
                    name
                } else {
                    format!("{rel}/{name}")
                };
                queue.push_back((canonical_child, next_rel, next_mode));
            }
        }

        let rank = |kind: GitRepositoryKind| match kind {
            GitRepositoryKind::Root => 0_u8,
            GitRepositoryKind::Repository => 1,
            GitRepositoryKind::Submodule => 2,
            GitRepositoryKind::Worktree => 3,
        };
        found.sort_by(|a, b| {
            rank(a.kind)
                .cmp(&rank(b.kind))
                .then_with(|| a.path.cmp(&b.path))
        });
        Ok((found, truncated))
    })
    .await
    .context("扫描 Git 仓库超时")?
}

pub async fn info_for_project(project_root: &Path, repo_path: Option<&str>) -> Result<GitInfo> {
    let trimmed = repo_path
        .map(str::trim)
        .filter(|path| !path.is_empty() && *path != ".");
    if let Some(subpath) = trimmed {
        let repo_root = resolve_repository(project_root, Some(subpath)).await?;
        return info(&repo_root).await;
    }
    let mut git_info = info(project_root).await?;
    if let Ok((repositories, repositories_truncated)) = discover_repositories(project_root).await
        && repositories.len() > 1
    {
        git_info.repositories = Some(repositories);
        if repositories_truncated {
            git_info.repositories_truncated = Some(true);
        }
    }
    Ok(git_info)
}
/// Pages follow a fixed first-parent lineage even when the working branch moves.
pub async fn commits(
    root: &Path,
    head: Option<&str>,
    offset: u32,
) -> Result<(Option<String>, Vec<GitCommit>, bool)> {
    tokio::time::timeout(Duration::from_secs(20), async {
        command(root, &["rev-parse", "--show-prefix"]).await?;
        let head = match head {
            Some(oid) if valid_oid(oid) => Some(commit(root, oid).await?),
            Some(_) => bail!("无效的提交游标"),
            None => commit(root, "HEAD").await.ok(),
        };
        let Some(oid) = &head else {
            return Ok((None, Vec::new(), false));
        };
        let text = command(
            root,
            &[
                "log",
                "--first-parent",
                "--no-decorate",
                "--no-show-signature",
                "--format=%H%x09%s",
                "--max-count=51",
                &format!("--skip={offset}"),
                oid,
                "--",
            ],
        )
        .await?;
        let mut rows = Vec::new();
        for line in text.lines() {
            let (oid, subject) = line.split_once('\t').context("无法读取提交记录")?;
            if !valid_oid(oid) {
                bail!("无效的提交记录");
            }
            rows.push(GitCommit {
                oid: oid.into(),
                subject: subject.into(),
            });
        }
        let has_more = rows.len() > 50;
        rows.truncate(50);
        Ok((head, rows, has_more))
    })
    .await
    .context("读取提交历史超时")?
}
fn arguments(scope: GitReviewScope, base: Option<&str>, head: Option<&str>) -> Result<Vec<String>> {
    let mut args: Vec<String> = [
        "diff",
        "--relative",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
    ]
    .map(str::to_owned)
    .into();
    match scope {
        GitReviewScope::Commit if base.is_none() => {
            let head = head
                .filter(|oid| valid_oid(oid))
                .context("缺少有效的提交，请刷新")?;
            args[0] = "diff-tree".into();
            args.extend([
                "--root".into(),
                "--no-commit-id".into(),
                "-r".into(),
                head.into(),
            ]);
        }
        GitReviewScope::Branch | GitReviewScope::Commit => {
            let base = base
                .filter(|oid| valid_oid(oid))
                .context("缺少有效的基准提交，请刷新")?;
            let head = head
                .filter(|oid| valid_oid(oid))
                .context("缺少有效的分支提交，请刷新")?;
            args.extend([base.into(), head.into()]);
        }
        GitReviewScope::Worktree => args.push(
            head.filter(|oid| valid_oid(oid))
                .context("仓库尚无提交，请使用已暂存或未暂存范围")?
                .into(),
        ),
        GitReviewScope::Staged => {
            args.push("--cached".into());
            if let Some(head) = head {
                if !valid_oid(head) {
                    bail!("无效的提交");
                }
                args.push(head.into());
            }
        }
        GitReviewScope::Unstaged => {}
    }
    Ok(args)
}
async fn listing(root: &Path, args: &[String]) -> Result<(Vec<GitReviewFile>, bool)> {
    let mut names = args.to_vec();
    names.extend(["--name-status".into(), "-z".into(), "--".into(), ".".into()]);
    let (text, mut truncated) =
        files::git(root, &names.iter().map(String::as_str).collect::<Vec<_>>()).await?;
    let mut records = text.split('\0');
    let mut entries: Vec<GitReviewFile> = Vec::new();
    while let Some(status) = records.next() {
        if status.is_empty() {
            continue;
        }
        let Some(first) = records.next() else {
            truncated = true;
            break;
        };
        let (path, previous_path) = if status.starts_with(['R', 'C']) {
            let Some(second) = records.next() else {
                truncated = true;
                break;
            };
            (second, Some(first.into()))
        } else {
            (first, None)
        };
        if valid_path(path).is_err()
            || previous_path
                .as_deref()
                .is_some_and(|p| valid_path(p).is_err())
        {
            truncated = true;
            continue;
        }
        if let Some(existing) = entries.iter_mut().find(|entry| entry.path == path) {
            if status.starts_with('U') {
                existing.status = "U".into();
            }
            continue;
        }
        if entries.len() == FILE_LIMIT {
            truncated = true;
            break;
        }
        entries.push(GitReviewFile {
            path: path.into(),
            previous_path,
            status: status[..1].into(),
            added: None,
            removed: None,
            binary: false,
            untracked: false,
        });
    }
    Ok((entries, truncated))
}
async fn untracked_content(root: &Path, path: &str) -> Result<(Vec<u8>, bool)> {
    valid_path(path)?;
    let metadata = tokio::fs::symlink_metadata(root.join(path)).await?;
    if metadata.file_type().is_symlink() {
        bail!("未跟踪符号链接不支持内容预览");
    }
    let target = files::resolve(root, path)?;
    if !target.is_file() {
        bail!("只能预览普通文件");
    }
    let file = tokio::fs::File::open(target).await?;
    let mut data = Vec::new();
    file.take((CONTENT_LIMIT + 1) as u64)
        .read_to_end(&mut data)
        .await?;
    let truncated = data.len() > CONTENT_LIMIT;
    data.truncate(CONTENT_LIMIT);
    Ok((data, truncated))
}
pub async fn review(
    root: &Path,
    scope: GitReviewScope,
    reference: Option<&str>,
) -> Result<GitReview> {
    tokio::time::timeout(Duration::from_secs(25), async {
        let head = if scope == GitReviewScope::Commit {
            let reference = reference.context("请选择要查看的提交")?;
            if !valid_oid(reference) {
                bail!("无效的提交");
            }
            Some(commit(root, reference).await?)
        } else {
            commit(root, "HEAD").await.ok()
        };
        let base = if scope == GitReviewScope::Branch {
            let info = info(root).await?;
            let reference = reference
                .or(info.default_base.as_deref())
                .context("仓库尚无提交，无法比较分支")?;
            let tip = commit(root, reference).await?;
            Some(
                command(
                    root,
                    &["merge-base", head.as_deref().context("仓库尚无提交")?, &tip],
                )
                .await
                .context("两个分支没有共同祖先")?,
            )
        } else if scope == GitReviewScope::Commit {
            let parents = command(
                root,
                &[
                    "rev-list",
                    "--parents",
                    "--max-count=1",
                    head.as_deref().context("缺少提交")?,
                    "--",
                ],
            )
            .await?;
            parents.split_whitespace().nth(1).map(str::to_owned)
        } else {
            None
        };
        let args = arguments(scope, base.as_deref(), head.as_deref())?;
        let (mut entries, mut truncated) = listing(root, &args).await?;
        let mut stat_args = args;
        stat_args.extend(["--numstat".into(), "-z".into(), "--".into(), ".".into()]);
        let (text, partial) = files::git(
            root,
            &stat_args.iter().map(String::as_str).collect::<Vec<_>>(),
        )
        .await?;
        truncated |= partial;
        let mut records = text.split('\0');
        let mut stats = HashMap::new();
        while let Some(record) = records.next() {
            if record.is_empty() {
                continue;
            }
            let mut parts = record.splitn(3, '\t');
            let (Some(added), Some(removed), Some(path)) =
                (parts.next(), parts.next(), parts.next())
            else {
                truncated = true;
                break;
            };
            let path = if path.is_empty() {
                records.next();
                let Some(new) = records.next() else {
                    truncated = true;
                    break;
                };
                new
            } else {
                path
            };
            stats.insert(
                path,
                (
                    added.parse::<u32>().ok(),
                    removed.parse::<u32>().ok(),
                    added == "-",
                ),
            );
        }
        for entry in &mut entries {
            if let Some((added, removed, binary)) = stats.get(entry.path.as_str()) {
                entry.added = *added;
                entry.removed = *removed;
                entry.binary = *binary;
            } else {
                truncated = true;
            }
        }
        if matches!(scope, GitReviewScope::Worktree | GitReviewScope::Unstaged) {
            let (changes, partial) = files::changes(root).await?;
            truncated |= partial;
            let mut bytes = 0;
            for change in changes
                .into_iter()
                .filter(|entry| entry.section == ChangeSection::Untracked)
            {
                if entries.len() == FILE_LIMIT {
                    truncated = true;
                    break;
                }
                let mut entry = GitReviewFile {
                    path: change.path,
                    status: "A".into(),
                    previous_path: None,
                    added: None,
                    removed: None,
                    binary: false,
                    untracked: true,
                };
                if bytes < 2 * CONTENT_LIMIT {
                    match untracked_content(root, &entry.path).await {
                        Ok((data, partial)) => {
                            bytes += data.len();
                            truncated |= partial;
                            entry.binary = data.contains(&0);
                            if !partial && !entry.binary {
                                entry.added =
                                    Some(data.split(|b| *b == b'\n').count().saturating_sub(
                                        usize::from(data.ends_with(b"\n") || data.is_empty()),
                                    ) as u32);
                                entry.removed = Some(0);
                            }
                        }
                        Err(_) => truncated = true,
                    }
                } else {
                    truncated = true;
                }
                entries.push(entry);
            }
        }
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(GitReview {
            base,
            head,
            added: entries
                .iter()
                .fold(0_u32, |n, e| n.saturating_add(e.added.unwrap_or(0))),
            removed: entries
                .iter()
                .fold(0_u32, |n, e| n.saturating_add(e.removed.unwrap_or(0))),
            entries,
            truncated,
        })
    })
    .await
    .context("读取变更超时，请缩小项目范围")?
}
fn quote_path(path: &str) -> String {
    let mut quoted = String::from("\"");
    for byte in path.bytes() {
        match byte {
            b'"' | b'\\' => {
                quoted.push('\\');
                quoted.push(char::from(byte));
            }
            32..=126 => quoted.push(char::from(byte)),
            _ => quoted.push_str(&format!("\\{byte:03o}")),
        }
    }
    quoted.push('"');
    quoted
}
pub async fn diff(
    root: &Path,
    scope: GitReviewScope,
    base: Option<&str>,
    head: Option<&str>,
    path: &str,
    full_context: bool,
) -> Result<(String, bool)> {
    tokio::time::timeout(Duration::from_secs(20), async {
        valid_path(path)?;
        if matches!(scope, GitReviewScope::Worktree | GitReviewScope::Staged)
            && commit(root, "HEAD").await.ok().as_deref() != head
        {
            bail!("分支提交已变化，请刷新变更后重试");
        }
        let mut args = arguments(scope, base, head)?;
        let (entries, _) = listing(root, &args).await?;
        if let Some(entry) = entries.iter().find(|e| e.path == path) {
            args.push(
                if full_context {
                    "--unified=100000"
                } else {
                    "--unified=3"
                }
                .into(),
            );
            args.extend(["--".into(), path.into()]);
            if let Some(previous) = &entry.previous_path {
                args.push(previous.clone());
            }
            return files::git(root, &args.iter().map(String::as_str).collect::<Vec<_>>()).await;
        }
        if matches!(scope, GitReviewScope::Worktree | GitReviewScope::Unstaged) {
            let (entries, _) = files::changes(root).await?;
            if entries
                .iter()
                .any(|e| e.path == path && e.section == ChangeSection::Untracked)
            {
                let (data, truncated) = untracked_content(root, path).await?;
                if data.contains(&0) {
                    return Ok(("Binary files differ\n".into(), truncated));
                }
                let text = String::from_utf8_lossy(&data);
                let quoted_path = quote_path(&format!("b/{path}"));
                let mut patch = format!(
                    "--- /dev/null\n+++ {quoted_path}\n@@ -0,0 +1,{} @@\n",
                    text.lines().count()
                );
                for line in text.lines() {
                    patch.push('+');
                    patch.push_str(line);
                    patch.push('\n');
                }
                if !data.is_empty() && !data.ends_with(b"\n") {
                    patch.push_str("\\ No newline at end of file\n");
                }
                return Ok((patch, truncated));
            }
        }
        Ok((String::new(), false))
    })
    .await
    .context("读取 diff 超时")?
}
/// Read a blob range without text conversion or external diff commands.
pub async fn image_chunk(
    root: &Path,
    scope: GitReviewScope,
    base: Option<&str>,
    head: Option<&str>,
    path: &str,
    before: bool,
    offset: u64,
) -> Result<Option<latte_work_protocol::ImagePreviewChunk>> {
    valid_path(path)?;
    if matches!(scope, GitReviewScope::Worktree | GitReviewScope::Staged)
        && commit(root, "HEAD").await.ok().as_deref() != head
    {
        bail!("分支提交已变化，请刷新变更后重试");
    }
    let args = arguments(scope, base, head)?;
    let (entries, _) = listing(root, &args).await?;
    let entry = entries.iter().find(|entry| entry.path == path);
    let untracked = if entry.is_none()
        && matches!(scope, GitReviewScope::Worktree | GitReviewScope::Unstaged)
    {
        files::changes(root)
            .await?
            .0
            .iter()
            .any(|e| e.path == path && e.section == ChangeSection::Untracked)
    } else {
        false
    };
    anyhow::ensure!(
        entry.is_some() || untracked,
        "文件不属于当前比较范围，请刷新"
    );
    if (before && (untracked || entry.is_some_and(|e| e.status == "A")))
        || (!before && entry.is_some_and(|e| e.status == "D"))
    {
        return Ok(None);
    }
    let path = if before {
        entry
            .and_then(|e| e.previous_path.as_deref())
            .unwrap_or(path)
    } else {
        path
    };
    valid_path(path)?;
    if !before && matches!(scope, GitReviewScope::Worktree | GitReviewScope::Unstaged) {
        // Refuse links in every path component, including links contained in root.
        let mut target = root.to_path_buf();
        for part in Path::new(path).components() {
            target.push(part);
            anyhow::ensure!(
                !target.symlink_metadata()?.file_type().is_symlink(),
                "符号链接不支持图片预览"
            );
        }
        return crate::image_preview::file(&files::resolve(root, path)?, offset, None, None)
            .await
            .map(Some);
    }
    let index =
        before && scope == GitReviewScope::Unstaged || !before && scope == GitReviewScope::Staged;
    let record = if index {
        command(root, &["ls-files", "--stage", "-z", "--", path]).await?
    } else {
        let reference = if before {
            if matches!(scope, GitReviewScope::Branch | GitReviewScope::Commit) {
                base
            } else {
                head
            }
        } else {
            head
        };
        let Some(reference) = reference else {
            return Ok(None);
        };
        anyhow::ensure!(valid_oid(reference), "无效的提交");
        command(root, &["ls-tree", "-z", reference, "--", path]).await?
    };
    let mut records = record.split('\0').filter(|r| !r.is_empty());
    let record = records.next().context("此版本的文件不存在，请刷新")?;
    anyhow::ensure!(records.next().is_none(), "图片路径匹配不唯一");
    let metadata = record.split_once('\t').context("Git 文件元数据无效")?.0;
    let parts: Vec<_> = metadata.split_whitespace().collect();
    anyhow::ensure!(
        parts.len() == 3 && matches!(parts[0], "100644" | "100755"),
        "此版本不是普通图片文件"
    );
    if index {
        anyhow::ensure!(parts[2] == "0", "冲突文件没有可预览的暂存版本");
    }
    let oid = parts[if index { 1 } else { 2 }];
    anyhow::ensure!(valid_oid(oid), "Git 对象无效");
    let size: u64 = command(root, &["cat-file", "-s", oid]).await?.parse()?;
    anyhow::ensure!(
        size <= crate::image_preview::LIMIT && offset <= size,
        "图片过大或预览偏移无效"
    );
    let mut child = tokio::process::Command::new("git")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .args(["cat-file", "blob", oid])
        .current_dir(root)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut output = child.stdout.take().context("Git 图片输出缺失")?;
    let mut header = vec![0; size.min(512) as usize];
    output.read_exact(&mut header).await?;
    let mut data = Vec::new();
    if offset < header.len() as u64 {
        data.extend_from_slice(&header[offset as usize..]);
    } else {
        let skip = offset - header.len() as u64;
        anyhow::ensure!(
            tokio::io::copy(&mut (&mut output).take(skip), &mut tokio::io::sink()).await? == skip,
            "Git 图片内容不完整"
        );
    }
    (&mut output)
        .take(65536 - data.len() as u64)
        .read_to_end(&mut data)
        .await?;
    let next = offset + data.len() as u64;
    if next < size {
        child.kill().await?;
    } else {
        anyhow::ensure!(child.wait().await?.success(), "Git 图片读取失败");
    }
    crate::image_preview::chunk(data, &header, size, offset, oid.into(), None).map(Some)
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn image_versions_follow_index_commits_renames_and_reject_links() {
        let root = fixture();
        let sub = root.path().join("project");
        let image = |n: u8| {
            let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
            bytes.resize(70000, n);
            bytes
        };
        std::fs::write(sub.join("old.png"), image(1)).unwrap();
        run(root.path(), &["add", "project/old.png"]);
        run(root.path(), &["commit", "-qm", "image"]);
        let base = commit(root.path(), "HEAD").await.unwrap();
        run(root.path(), &["mv", "project/old.png", "project/new.png"]);
        run(root.path(), &["commit", "-qm", "rename"]);
        let head = commit(root.path(), "HEAD").await.unwrap();
        let first = image_chunk(
            &sub,
            GitReviewScope::Commit,
            Some(&base),
            Some(&head),
            "new.png",
            true,
            0,
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(first.data.len(), 65536);
        assert!(first.has_more);
        let tail = image_chunk(
            &sub,
            GitReviewScope::Commit,
            Some(&base),
            Some(&head),
            "new.png",
            false,
            first.next,
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(tail.data, image(1)[65536..]);
        assert_eq!(first.version, tail.version);
        std::fs::write(sub.join("new.png"), image(2)).unwrap();
        run(root.path(), &["add", "project/new.png"]);
        std::fs::write(sub.join("new.png"), image(3)).unwrap();
        for (scope, before, expected) in [
            (GitReviewScope::Staged, true, 1),
            (GitReviewScope::Staged, false, 2),
            (GitReviewScope::Unstaged, true, 2),
            (GitReviewScope::Unstaged, false, 3),
            (GitReviewScope::Worktree, true, 1),
            (GitReviewScope::Worktree, false, 3),
        ] {
            let data = image_chunk(&sub, scope, None, Some(&head), "new.png", before, 0)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(data.data[20], expected);
        }
        std::fs::write(sub.join("add.png"), image(4)).unwrap();
        assert!(
            image_chunk(
                &sub,
                GitReviewScope::Unstaged,
                None,
                None,
                "add.png",
                true,
                0
            )
            .await
            .unwrap()
            .is_none()
        );
        std::os::unix::fs::symlink(sub.join("new.png"), sub.join("link.png")).unwrap();
        for path in ["link.png", "../outside.png", "/etc/passwd"] {
            assert!(
                image_chunk(&sub, GitReviewScope::Unstaged, None, None, path, false, 0)
                    .await
                    .is_err()
            );
        }
        assert!(
            image_chunk(
                &sub,
                GitReviewScope::Staged,
                None,
                Some(&head),
                "new.png",
                true,
                70001
            )
            .await
            .is_err()
        );
    }
    use super::*;
    use std::process::Command;
    fn run(root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        run(root.path(), &["init", "-q", "-b", "main"]);
        run(root.path(), &["config", "user.name", "Fixture"]);
        run(
            root.path(),
            &["config", "user.email", "fixture@example.test"],
        );
        std::fs::create_dir(root.path().join("project")).unwrap();
        for (name, text) in [
            ("file.txt", "original\n"),
            ("old.txt", "rename\n"),
            ("base.txt", "base\n"),
        ] {
            std::fs::write(root.path().join("project").join(name), text).unwrap();
        }
        std::fs::write(root.path().join("outside.txt"), "outside\n").unwrap();
        run(root.path(), &["add", "."]);
        run(root.path(), &["commit", "-qm", "initial"]);
        root
    }
    #[tokio::test]
    async fn committed_reviews_pin_first_parent_and_support_root_commits() {
        let root = fixture();
        let sub = root.path().join("project");
        let (_, history, _) = commits(&sub, None, 0).await.unwrap();
        let initial = history[0].oid.clone();
        let saved = review(&sub, GitReviewScope::Commit, Some(&initial))
            .await
            .unwrap();
        assert!(saved.base.is_none());
        assert_eq!(saved.entries.len(), 3);
        let patch = diff(
            &sub,
            GitReviewScope::Commit,
            None,
            saved.head.as_deref(),
            "file.txt",
            false,
        )
        .await
        .unwrap()
        .0;
        assert!(patch.contains("+original"));
        assert!(!patch.contains("outside"));
        run(root.path(), &["checkout", "-qb", "feature"]);
        std::fs::write(sub.join("file.txt"), "feature\n").unwrap();
        run(root.path(), &["add", "."]);
        run(root.path(), &["commit", "-qm", "feature"]);
        run(root.path(), &["checkout", "-q", "main"]);
        std::fs::write(sub.join("base.txt"), "main\n").unwrap();
        run(root.path(), &["add", "."]);
        run(root.path(), &["commit", "-qm", "main"]);
        let parent = commit(&sub, "HEAD").await.unwrap();
        run(
            root.path(),
            &["merge", "--no-ff", "-qm", "merge feature", "feature"],
        );
        let (head, history, _) = commits(&sub, None, 0).await.unwrap();
        assert_eq!(
            history
                .iter()
                .map(|c| c.subject.as_str())
                .collect::<Vec<_>>(),
            ["merge feature", "main", "initial"]
        );
        let index = std::fs::read(root.path().join(".git/index")).unwrap();
        let saved = review(&sub, GitReviewScope::Commit, head.as_deref())
            .await
            .unwrap();
        assert_eq!(saved.base.as_deref(), Some(parent.as_str()));
        assert_eq!(saved.entries.len(), 1);
        assert_eq!(saved.entries[0].path, "file.txt");
        assert_eq!(
            std::fs::read(root.path().join(".git/index")).unwrap(),
            index
        );
        run(root.path(), &["checkout", "-q", "feature"]);
        std::fs::write(sub.join("file.txt"), "working\n").unwrap();
        let patch = diff(
            &sub,
            GitReviewScope::Commit,
            saved.base.as_deref(),
            saved.head.as_deref(),
            "file.txt",
            false,
        )
        .await
        .unwrap()
        .0;
        assert!(patch.contains("+feature"));
        assert!(!patch.contains("+working"));
        // Inspection never writes the index; check before the explicit checkout changes it.
        assert_eq!(saved.head, head);
        assert!(!index.is_empty());
        for value in ["HEAD", "--output=escape", "HEAD:outside.txt", "../main"] {
            assert!(
                review(&sub, GitReviewScope::Commit, Some(value))
                    .await
                    .is_err()
            );
        }
        assert!(
            diff(
                &sub,
                GitReviewScope::Commit,
                saved.base.as_deref(),
                saved.head.as_deref(),
                "../outside.txt",
                false
            )
            .await
            .is_err()
        );
    }
    #[tokio::test]
    async fn commit_pages_keep_their_lineage_after_head_moves() {
        let root = fixture();
        // Construct enough history for two pages in one deterministic Git process.
        let initial = commit(root.path(), "HEAD").await.unwrap();
        let mut input = String::new();
        for n in 0..54 {
            let message = format!("commit {n}");
            let parent = if n == 0 {
                initial.clone()
            } else {
                format!(":{n}")
            };
            input.push_str(&format!("commit refs/heads/main\nmark :{}\ncommitter Fixture <fixture@example.test> {} +0000\ndata {}\n{}\nfrom {}\n\n", n + 1, n + 1, message.len(), message, parent));
        }
        let mut child = Command::new("git")
            .args(["fast-import", "--quiet"])
            .current_dir(root.path())
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        std::io::Write::write_all(&mut child.stdin.take().unwrap(), input.as_bytes()).unwrap();
        assert!(child.wait().unwrap().success());
        let (head, first, more) = commits(root.path(), None, 0).await.unwrap();
        assert_eq!(first.len(), 50);
        assert!(more);
        run(
            root.path(),
            &["commit", "--allow-empty", "-qm", "late commit"],
        );
        let (_, second, more) = commits(root.path(), head.as_deref(), 50).await.unwrap();
        assert_eq!(second.len(), 5);
        assert!(!more);
        assert_eq!(second.last().unwrap().subject, "initial");
        assert!(!second.iter().any(|c| c.subject == "late commit"));
        assert!(!first.iter().any(|a| second.iter().any(|b| a.oid == b.oid)));
        assert!(commits(root.path(), Some("HEAD~1"), 0).await.is_err());
        let empty = tempfile::tempdir().unwrap();
        assert!(commits(empty.path(), None, 0).await.is_err());
        run(empty.path(), &["init", "-q", "-b", "main"]);
        assert_eq!(commits(empty.path(), None, 0).await.unwrap().0, None);
    }
    #[tokio::test]
    async fn branch_review_uses_merge_base_and_pinned_commits_with_renames() {
        let root = fixture();
        let sub = root.path().join("project");
        run(root.path(), &["checkout", "-qb", "feature"]);
        std::fs::write(sub.join("file.txt"), "feature\nextra\n").unwrap();
        run(
            root.path(),
            &["mv", "project/old.txt", "project/中文 renamed.txt"],
        );
        std::fs::write(root.path().join("outside.txt"), "do not expose outside\n").unwrap();
        run(root.path(), &["add", "."]);
        run(root.path(), &["commit", "-qm", "feature"]);
        run(root.path(), &["checkout", "-q", "main"]);
        std::fs::write(sub.join("base.txt"), "base branch only\n").unwrap();
        run(root.path(), &["add", "."]);
        run(root.path(), &["commit", "-qm", "base advanced"]);
        run(
            root.path(),
            &["update-ref", "refs/remotes/origin/main", "HEAD"],
        );
        run(root.path(), &["checkout", "-q", "feature"]);
        let index = std::fs::read(root.path().join(".git/index")).unwrap();
        let metadata = info(&sub).await.unwrap();
        assert_eq!(metadata.branch.as_deref(), Some("feature"));
        assert_eq!(
            metadata.default_base.as_deref(),
            Some("refs/remotes/origin/main")
        );
        let snapshot = review(&sub, GitReviewScope::Branch, None).await.unwrap();
        assert_eq!(snapshot.entries.len(), 2);
        assert_eq!((snapshot.added, snapshot.removed), (2, 1));
        assert!(
            !snapshot
                .entries
                .iter()
                .any(|e| e.path.contains("outside") || e.path == "base.txt")
        );
        assert!(
            snapshot
                .entries
                .iter()
                .any(|e| e.path == "中文 renamed.txt"
                    && e.previous_path.as_deref() == Some("old.txt"))
        );
        assert_eq!(
            std::fs::read(root.path().join(".git/index")).unwrap(),
            index
        );
        run(root.path(), &["checkout", "-q", "main"]);
        run(
            root.path(),
            &["update-ref", "refs/remotes/origin/main", "feature"],
        );
        let patch = diff(
            &sub,
            GitReviewScope::Branch,
            snapshot.base.as_deref(),
            snapshot.head.as_deref(),
            "file.txt",
            false,
        )
        .await
        .unwrap()
        .0;
        assert!(patch.contains("+feature"));
        assert!(!patch.contains("base branch only"));
        let patch = diff(
            &sub,
            GitReviewScope::Branch,
            snapshot.base.as_deref(),
            snapshot.head.as_deref(),
            "中文 renamed.txt",
            false,
        )
        .await
        .unwrap()
        .0;
        assert!(patch.contains("rename from old.txt"));
        run(root.path(), &["checkout", "-q", "feature"]);
    }
    #[tokio::test]
    async fn index_worktree_binary_untracked_and_literal_paths_are_distinct() {
        let root = fixture();
        let sub = root.path().join("project");
        std::fs::write(sub.join("file.txt"), "staged\n").unwrap();
        run(root.path(), &["add", "project/file.txt"]);
        std::fs::write(sub.join("file.txt"), "working\nextra\n").unwrap();
        std::fs::write(sub.join("binary"), [0_u8, 1, 2]).unwrap();
        let unusual = "中文 space\nfile.txt";
        std::fs::write(sub.join(unusual), "literal\n").unwrap();
        std::fs::write(root.path().join("outside.txt"), "outside edits\n").unwrap();
        std::os::unix::fs::symlink(root.path().join("outside.txt"), sub.join("link")).unwrap();
        let index = std::fs::read(root.path().join(".git/index")).unwrap();
        for (scope, added, removed) in [
            (GitReviewScope::Staged, 1, 1),
            (GitReviewScope::Unstaged, 3, 1),
            (GitReviewScope::Worktree, 3, 1),
        ] {
            let snapshot = review(&sub, scope, None).await.unwrap();
            assert_eq!((snapshot.added, snapshot.removed), (added, removed));
            assert!(
                snapshot
                    .entries
                    .iter()
                    .all(|e| !e.path.contains("outside") && !e.path.starts_with("project/"))
            );
            let patch = diff(
                &sub,
                scope,
                snapshot.base.as_deref(),
                snapshot.head.as_deref(),
                "file.txt",
                false,
            )
            .await
            .unwrap()
            .0;
            assert!(patch.contains(if scope == GitReviewScope::Staged {
                "+staged"
            } else {
                "+working"
            }));
            if scope != GitReviewScope::Staged {
                assert!(snapshot.truncated); // The external symlink has no readable statistics.
                assert!(
                    snapshot
                        .entries
                        .iter()
                        .any(|e| e.path == "binary" && e.binary)
                );
                assert!(
                    diff(&sub, scope, None, snapshot.head.as_deref(), "link", false)
                        .await
                        .is_err()
                );
                assert!(
                    diff(&sub, scope, None, snapshot.head.as_deref(), unusual, false)
                        .await
                        .unwrap()
                        .0
                        .contains("+literal")
                );
            }
        }
        assert_eq!(
            std::fs::read(root.path().join(".git/index")).unwrap(),
            index
        );
        for path in ["../outside.txt", "/etc/passwd", ""] {
            assert!(
                diff(&sub, GitReviewScope::Unstaged, None, None, path, false)
                    .await
                    .is_err()
            );
        }
        assert_eq!(
            diff(&sub, GitReviewScope::Unstaged, None, None, ":(top)*", false)
                .await
                .unwrap()
                .0,
            ""
        );
        for base in [
            "--output=outside",
            "HEAD:outside.txt",
            "HEAD~1",
            "missing",
            "refs/heads/../main",
        ] {
            assert!(
                review(&sub, GitReviewScope::Branch, Some(base))
                    .await
                    .is_err()
            );
        }
    }
    #[tokio::test]
    async fn review_is_bounded_and_does_not_execute_external_diff() {
        let root = fixture();
        let sub = root.path().join("project");
        let marker = root.path().join("executed");
        run(
            root.path(),
            &[
                "config",
                "diff.external",
                &format!("touch {}", marker.display()),
            ],
        );
        std::fs::write(sub.join("file.txt"), "changed\n").unwrap();
        let snapshot = review(&sub, GitReviewScope::Worktree, None).await.unwrap();
        assert!(
            diff(
                &sub,
                GitReviewScope::Worktree,
                None,
                snapshot.head.as_deref(),
                "file.txt",
                true
            )
            .await
            .unwrap()
            .0
            .contains("+changed")
        );
        assert!(!marker.exists());
        for n in 0..1005 {
            std::fs::write(sub.join(format!("untracked-{n}")), "").unwrap();
        }
        let snapshot = review(&sub, GitReviewScope::Unstaged, None).await.unwrap();
        assert_eq!(snapshot.entries.len(), FILE_LIMIT);
        assert!(snapshot.truncated);
    }
    #[tokio::test]
    async fn untracked_patches_quote_paths_preserve_eof_and_reject_internal_symlinks() {
        let root = fixture();
        let sub = root.path().join("project");
        let path = "new\n\"name";
        std::fs::write(sub.join(path), "no newline").unwrap();
        std::os::unix::fs::symlink(sub.join("file.txt"), sub.join("inside-link")).unwrap();
        let snapshot = review(&sub, GitReviewScope::Unstaged, None).await.unwrap();
        assert!(snapshot.truncated);
        let patch = diff(
            &sub,
            GitReviewScope::Unstaged,
            None,
            snapshot.head.as_deref(),
            path,
            false,
        )
        .await
        .unwrap()
        .0;
        assert!(patch.contains("\\012"));
        assert!(patch.contains("\\ No newline at end of file"));
        assert!(
            diff(
                &sub,
                GitReviewScope::Unstaged,
                None,
                snapshot.head.as_deref(),
                "inside-link",
                false
            )
            .await
            .is_err()
        );
        run(root.path(), &["commit", "--allow-empty", "-qm", "advance"]);
        assert!(
            diff(
                &sub,
                GitReviewScope::Worktree,
                None,
                snapshot.head.as_deref(),
                "file.txt",
                false
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("请刷新")
        );
    }
    #[tokio::test]
    async fn unmerged_files_are_listed_once_and_preserve_combined_diff() {
        let root = fixture();
        let sub = root.path().join("project");
        run(root.path(), &["checkout", "-qb", "feature"]);
        std::fs::write(sub.join("file.txt"), "feature\n").unwrap();
        run(root.path(), &["add", "."]);
        run(root.path(), &["commit", "-qm", "feature"]);
        run(root.path(), &["checkout", "-q", "main"]);
        std::fs::write(sub.join("file.txt"), "main\n").unwrap();
        run(root.path(), &["add", "."]);
        run(root.path(), &["commit", "-qm", "main"]);
        let result = Command::new("git")
            .args(["merge", "feature"])
            .current_dir(root.path())
            .output()
            .unwrap();
        assert!(!result.status.success());
        let snapshot = review(&sub, GitReviewScope::Unstaged, None).await.unwrap();
        assert_eq!(snapshot.entries.len(), 1);
        assert_eq!(snapshot.entries[0].status, "U");
        assert!(
            diff(
                &sub,
                GitReviewScope::Unstaged,
                None,
                snapshot.head.as_deref(),
                "file.txt",
                false
            )
            .await
            .unwrap()
            .0
            .contains("diff --cc")
        );
    }
    #[tokio::test]
    async fn non_repo_unborn_and_detached_head_have_explicit_states() {
        let empty = tempfile::tempdir().unwrap();
        assert!(info(empty.path()).await.is_err());
        run(empty.path(), &["init", "-q", "-b", "main"]);
        let metadata = info(empty.path()).await.unwrap();
        assert!(metadata.head.is_none());
        assert_eq!(metadata.branch.as_deref(), Some("main"));
        assert!(
            review(empty.path(), GitReviewScope::Branch, None)
                .await
                .is_err()
        );
        assert!(
            review(empty.path(), GitReviewScope::Worktree, None)
                .await
                .is_err()
        );
        assert!(
            review(empty.path(), GitReviewScope::Staged, None)
                .await
                .unwrap()
                .entries
                .is_empty()
        );
        let root = fixture();
        run(root.path(), &["checkout", "-q", "--detach"]);
        let metadata = info(root.path()).await.unwrap();
        assert!(metadata.branch.is_none());
        assert!(metadata.head.is_some());
    }

    #[tokio::test]
    async fn discovers_child_repos_submodules_and_worktrees_within_bounds_and_rejects_escapes() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();

        let init_repo = |path: &Path, branch: &str, file: &str, content: &str| {
            std::fs::create_dir_all(path).unwrap();
            run(path, &["init", "-q", "-b", branch]);
            run(path, &["config", "user.name", "Fixture"]);
            run(path, &["config", "user.email", "fixture@example.test"]);
            std::fs::write(path.join(file), content).unwrap();
            run(path, &["add", "."]);
            run(path, &["commit", "-qm", "initial"]);
        };

        // External repo used both as submodule upstream and to verify escape rejection.
        let external_repo = outside.path().join("external");
        init_repo(&external_repo, "main", "lib.rs", "pub fn v() -> u8 { 1 }\n");

        // Primary child repositories under non-Git umbrella workspace.
        let continue_repo = workspace.path().join("continue");
        init_repo(&continue_repo, "main", "app.ts", "export const a = 1;\n");
        let code_repo = workspace.path().join("latte-code");
        init_repo(&code_repo, "main", "main.rs", "fn main() {}\n");

        // Initialized submodule inside `continue/vendor/sub-lib` + plain non-repo folder.
        std::fs::create_dir_all(continue_repo.join("vendor")).unwrap();
        run(
            &continue_repo,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "-q",
                "add",
                external_repo.to_str().unwrap(),
                "vendor/sub-lib",
            ],
        );
        run(&continue_repo, &["commit", "-qm", "add submodule"]);
        std::fs::write(
            continue_repo.join("vendor/sub-lib/lib.rs"),
            "pub fn v() -> u8 { 2 }\n",
        )
        .unwrap();
        std::fs::create_dir_all(continue_repo.join("plain-subdir")).unwrap();

        // Linked worktrees under `.oh-my-code/worktree/continue/fix-ux` and `.worktree/quick`.
        let omc_wt = workspace
            .path()
            .join(".oh-my-code/worktree/continue/fix-ux");
        std::fs::create_dir_all(omc_wt.parent().unwrap()).unwrap();
        run(
            &continue_repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "fix/ux",
                omc_wt.to_str().unwrap(),
                "HEAD",
            ],
        );
        std::fs::write(omc_wt.join("app.ts"), "export const a = 2;\n").unwrap();

        let direct_wt = workspace.path().join(".worktree/quick");
        std::fs::create_dir_all(direct_wt.parent().unwrap()).unwrap();
        run(
            &code_repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feat/quick",
                direct_wt.to_str().unwrap(),
                "HEAD",
            ],
        );

        // Out-of-bounds, ignored, hidden, symlinked, and gitfile-escaped directories must be excluded.
        init_repo(
            &workspace.path().join("a/b/c/d/too-deep"),
            "main",
            "deep.txt",
            "deep\n",
        );
        init_repo(
            &workspace.path().join("node_modules/pkg-repo"),
            "main",
            "idx.js",
            "1\n",
        );
        init_repo(
            &workspace.path().join(".cache/hidden-repo"),
            "main",
            "h.txt",
            "1\n",
        );
        std::os::unix::fs::symlink(&external_repo, workspace.path().join("linked-external"))
            .unwrap();
        let crafted_escape = workspace.path().join("crafted-gitfile");
        std::fs::create_dir_all(&crafted_escape).unwrap();
        std::fs::write(
            crafted_escape.join(".git"),
            format!("gitdir: {}\n", external_repo.join(".git").display()),
        )
        .unwrap();

        let (repos, truncated) = discover_repositories(workspace.path()).await.unwrap();
        assert!(!truncated);
        assert_eq!(
            repos,
            vec![
                GitRepository {
                    path: "continue".into(),
                    name: "continue".into(),
                    kind: GitRepositoryKind::Repository,
                },
                GitRepository {
                    path: "latte-code".into(),
                    name: "latte-code".into(),
                    kind: GitRepositoryKind::Repository,
                },
                GitRepository {
                    path: "continue/vendor/sub-lib".into(),
                    name: "continue/vendor/sub-lib".into(),
                    kind: GitRepositoryKind::Submodule,
                },
                GitRepository {
                    path: ".oh-my-code/worktree/continue/fix-ux".into(),
                    name: "continue/fix-ux".into(),
                    kind: GitRepositoryKind::Worktree,
                },
                GitRepository {
                    path: ".worktree/quick".into(),
                    name: "quick".into(),
                    kind: GitRepositoryKind::Worktree,
                },
            ]
        );

        // Scoped review on submodule and linked worktree reads their independent diffs.
        let sub_root = resolve_repository(workspace.path(), Some("continue/vendor/sub-lib"))
            .await
            .unwrap();
        let sub_review = review(&sub_root, GitReviewScope::Worktree, None)
            .await
            .unwrap();
        assert_eq!(sub_review.entries.len(), 1);
        assert_eq!(sub_review.entries[0].path, "lib.rs");

        let wt_root = resolve_repository(
            workspace.path(),
            Some(".oh-my-code/worktree/continue/fix-ux"),
        )
        .await
        .unwrap();
        let wt_info = info(&wt_root).await.unwrap();
        assert_eq!(wt_info.branch.as_deref(), Some("fix/ux"));
        let wt_review = review(&wt_root, GitReviewScope::Worktree, None)
            .await
            .unwrap();
        assert_eq!(wt_review.entries.len(), 1);
        assert_eq!(wt_review.entries[0].path, "app.ts");

        // Plain subdirectories, symlinks, crafted gitfiles, and path traversals are rejected.
        for rejected in [
            "continue/plain-subdir",
            "linked-external",
            "crafted-gitfile",
            "../external",
            "/tmp",
        ] {
            assert!(
                resolve_repository(workspace.path(), Some(rejected))
                    .await
                    .is_err(),
                "expected {rejected} to be rejected"
            );
        }

        // When opening `continue` itself as a root Git project, `info_for_project` includes its submodule.
        let root_info = info_for_project(&continue_repo, None).await.unwrap();
        let nested = root_info.repositories.expect("root + submodule list");
        assert_eq!(nested.len(), 2);
        assert_eq!(nested[0].kind, GitRepositoryKind::Root);
        assert_eq!(nested[1].path, "vendor/sub-lib");
        assert_eq!(nested[1].kind, GitRepositoryKind::Submodule);
    }
}
