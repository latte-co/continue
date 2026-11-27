//! Resolve the active working directory of a Code Agent session for terminal launch.
//!
//! Different agents expose working-directory changes through different native
//! channels (explicit command `cwd`/`workdir`, `EnterWorktree`/`ExitWorktree`,
//! shell `cd <dir> && ...` prefixes, OpenCode session directories, or file
//! mutations inside a linked worktree / child repository). Candidates are
//! verified against the project root or linked Git worktrees owned by the
//! project, and missing directories gracefully fall back to `project.path`.

use crate::{
    agents, files, git_review,
    runtime::{self, db},
};
use latte_work_protocol::{Project, Session};
use serde_json::Value;
use std::path::{Path, PathBuf};

const RECENT_TOOL_EVENT_LIMIT: usize = 64;
const WORKDIR_SCAN_PAGE_SIZE: usize = 256;
const WORKDIR_SCAN_MAX_PAGES: usize = 16;
const PATCH_PATH_LIMIT: usize = 8;

pub(crate) struct RawWorkdirEventRow {
    pub seq: i64,
    pub kind: Option<String>,
    pub id: Option<String>,
    pub is_error: bool,
    pub raw_tool: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) enum DirectorySignal {
    /// Explicit exit back to the project's primary root (e.g. `ExitWorktree`).
    ResetToProjectRoot,
    /// Explicit working directory from a command tool, `cd` prefix, or `EnterWorktree`.
    ExplicitDirectory {
        path: PathBuf,
        allow_project_root: bool,
    },
    /// Mutated file path whose enclosing Git worktree / repository root should be used.
    MutatedFile(PathBuf),
}

pub(crate) async fn resolve_terminal_cwd(
    service: &crate::Service,
    project: &Project,
    session_id: Option<&str>,
    repo_path: Option<&str>,
) -> Option<PathBuf> {
    let project_root = Path::new(&project.path);
    let canonical_project = tokio::fs::canonicalize(project_root).await.ok()?;

    if let Some(id) = session_id.filter(|s| !s.is_empty() && s.len() <= 128)
        && let Ok(session) = db(&service.database, |d| d.session(id))
        && session.project_id == project.id
    {
        if let Some(found) =
            resolve_for_session(service, project_root, &canonical_project, &session).await
        {
            return Some(found);
        }
        // If a side chat has not established its own working directory yet,
        // inherit the parent conversation's active working directory.
        if let Ok(Some((parent_id, _))) = db(&service.database, |d| d.side_parent(&session.id))
            && let Ok(parent) = db(&service.database, |d| d.session(&parent_id))
            && parent.project_id == project.id
            && let Some(found) =
                resolve_for_session(service, project_root, &canonical_project, &parent).await
        {
            return Some(found);
        }
    }

    if let Some(subpath) = repo_path.filter(|p| !p.is_empty() && *p != ".")
        && let Ok(repo_dir) =
            git_review::resolve_repository(&canonical_project, Some(subpath)).await
    {
        return Some(repo_dir);
    }

    Some(canonical_project)
}

async fn resolve_for_session(
    service: &crate::Service,
    project_root: &Path,
    canonical_project: &Path,
    session: &Session,
) -> Option<PathBuf> {
    let live_cwd = runtime::session_agent_cwd(&service.runs, &session.id)
        .await
        .and_then(|raw| {
            let p = PathBuf::from(raw);
            p.is_absolute().then_some(p)
        });
    let base_cwd = match &live_cwd {
        Some(dir) => validate_explicit_directory(canonical_project, dir)
            .await
            .unwrap_or_else(|| canonical_project.to_path_buf()),
        None => canonical_project.to_path_buf(),
    };

    let signals = collect_recent_workdir_signals(
        &service.database,
        &session.id,
        project_root,
        canonical_project,
        &base_cwd,
        RECENT_TOOL_EVENT_LIMIT,
    )
    .await;

    if let Some(resolved) = resolve_from_signals(canonical_project, &signals).await {
        return Some(resolved);
    }

    if base_cwd != canonical_project {
        return Some(base_cwd);
    }

    // OpenCode sessions may be pinned to a worktree directory in native storage
    // even before a new turn is recorded in this daemon lifecycle.
    if session.agent == "opencode"
        && let Some(native_id) = session.native_id.as_deref()
        && let Ok(binary) = service.agent_binary("opencode")
    {
        let former_paths = db(&service.database, |d| {
            d.project_former_paths(&session.project_id)
        })
        .unwrap_or_default();
        let config = service
            .providers
            .lock()
            .ok()
            .and_then(|p| p.turn_config("opencode", None, None).ok());
        if let Some(config) = config
            && let Ok(Some(exported)) = agents::resume_directory(
                "opencode",
                binary,
                canonical_project,
                &former_paths,
                native_id,
                &config,
            )
            .await
            && let Some(valid) =
                validate_explicit_directory(canonical_project, Path::new(&exported)).await
        {
            return Some(valid);
        }
    }

    None
}

async fn collect_recent_workdir_signals(
    database: &runtime::Database,
    session_id: &str,
    project_root: &Path,
    canonical_project: &Path,
    base_cwd: &Path,
    limit: usize,
) -> Vec<DirectorySignal> {
    let mut before_seq: Option<i64> = None;
    let mut outcomes = std::collections::HashMap::<String, bool>::new();
    let mut seen = std::collections::HashSet::new();
    let mut collected = Vec::new();
    'pages: for page_idx in 0..WORKDIR_SCAN_MAX_PAGES {
        if page_idx > 0 {
            tokio::task::yield_now().await;
        }
        let Ok(rows) = db(database, |d| {
            d.workdir_tool_event_page(session_id, before_seq, WORKDIR_SCAN_PAGE_SIZE)
        }) else {
            break;
        };
        if rows.is_empty() {
            break;
        }
        before_seq = rows.last().map(|r| r.seq);
        let exhausted = rows.len() < WORKDIR_SCAN_PAGE_SIZE;
        for row in rows {
            match row.kind.as_deref() {
                Some("tool_result") => {
                    if let Some(id) = row.id {
                        outcomes.entry(id).or_insert(row.is_error);
                    }
                }
                Some("tool") => {
                    let Some(raw) = row.raw_tool else {
                        continue;
                    };
                    let Ok(latte_work_protocol::EventKind::Tool { id, name, input }) =
                        serde_json::from_str::<latte_work_protocol::EventKind>(&raw)
                    else {
                        continue;
                    };
                    let outcome = outcomes.get(&id).copied();
                    for signal in extract_tool_signals(
                        &name,
                        &input,
                        outcome,
                        project_root,
                        canonical_project,
                        base_cwd,
                    ) {
                        let is_reset = signal == DirectorySignal::ResetToProjectRoot;
                        if seen.insert(signal.clone()) {
                            collected.push(signal);
                            if is_reset || collected.len() >= limit {
                                break 'pages;
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        if exhausted {
            break;
        }
    }
    collected
}

async fn resolve_from_signals(
    canonical_project: &Path,
    signals: &[DirectorySignal],
) -> Option<PathBuf> {
    for signal in signals {
        match signal {
            DirectorySignal::ResetToProjectRoot => {
                return Some(canonical_project.to_path_buf());
            }
            DirectorySignal::ExplicitDirectory {
                path: candidate,
                allow_project_root,
            } => {
                if let Some(valid) = validate_explicit_directory(canonical_project, candidate).await
                    && (*allow_project_root || valid != canonical_project)
                {
                    return Some(valid);
                }
            }
            DirectorySignal::MutatedFile(candidate) => {
                if let Some(valid) =
                    validate_mutated_file_worktree(canonical_project, candidate).await
                {
                    return Some(valid);
                }
            }
        }
    }
    None
}

#[cfg(test)]
async fn resolve_from_tool_events(
    project_root: &Path,
    canonical_project: &Path,
    base_cwd: &Path,
    events: &[(latte_work_protocol::EventKind, Option<bool>)],
) -> Option<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    let mut signals = Vec::new();
    'events: for (event, outcome) in events {
        let latte_work_protocol::EventKind::Tool { name, input, .. } = event else {
            continue;
        };
        for signal in extract_tool_signals(
            name,
            input,
            *outcome,
            project_root,
            canonical_project,
            base_cwd,
        ) {
            let is_reset = signal == DirectorySignal::ResetToProjectRoot;
            if seen.insert(signal.clone()) {
                signals.push(signal);
                if is_reset || signals.len() >= RECENT_TOOL_EVENT_LIMIT {
                    break 'events;
                }
            }
        }
    }
    resolve_from_signals(canonical_project, &signals).await
}

fn resolve_against(base: &Path, raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim_matches(|c| c == '\r' || c == '\n');
    if trimmed.is_empty() || trimmed.len() > 4096 || trimmed.contains('\0') {
        return None;
    }
    let path = Path::new(trimmed);
    Some(if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    })
}

fn normalized_input_object(input: &Value) -> Option<serde_json::Map<String, Value>> {
    match input {
        Value::Object(map) => Some(map.clone()),
        // Cursor generic `function` tool calls carry serialized JSON arguments as a string.
        Value::String(raw) if raw.len() <= 262_144 => serde_json::from_str::<Value>(raw)
            .ok()?
            .as_object()
            .cloned(),
        _ => None,
    }
}

pub(crate) fn extract_tool_signals(
    raw_name: &str,
    raw_input: &Value,
    outcome: Option<bool>,
    project_root: &Path,
    canonical_project: &Path,
    base_cwd: &Path,
) -> Vec<DirectorySignal> {
    // Only a confirmed, non-error tool execution (`ToolResult { is_error: false }`)
    // may establish or reset the session's active working directory. Pending (`None`),
    // interrupted (`None`), or rejected/failed (`Some(true)`) tool calls never move
    // new terminals into an unconfirmed or failed directory.
    if outcome != Some(false) {
        return Vec::new();
    }

    let stripped = raw_name
        .strip_prefix("mcp__")
        .and_then(|s| s.split_once("__").map(|(_, tool)| tool))
        .unwrap_or(raw_name);
    let lower = stripped.to_ascii_lowercase();

    if matches!(lower.as_str(), "exitworktree" | "exit_worktree") {
        return vec![DirectorySignal::ResetToProjectRoot];
    }

    let Some(map) = normalized_input_object(raw_input) else {
        return Vec::new();
    };

    if matches!(lower.as_str(), "enterworktree" | "enter_worktree") {
        let mut out = Vec::new();
        for key in ["path", "worktree_path", "worktreePath", "directory", "cwd"] {
            if let Some(raw) = map.get(key).and_then(Value::as_str)
                && let Some(resolved) = resolve_against(base_cwd, raw)
            {
                out.push(DirectorySignal::ExplicitDirectory {
                    path: resolved,
                    allow_project_root: true,
                });
            }
        }
        if let Some(name) = map.get("name").and_then(Value::as_str)
            && !name.is_empty()
            && !name.contains(['/', '\\', '\0'])
            && name != "."
            && name != ".."
        {
            out.push(DirectorySignal::ExplicitDirectory {
                path: base_cwd.join(".claude/worktrees").join(name),
                allow_project_root: true,
            });
        }
        return out;
    }

    let is_shell = matches!(
        lower.as_str(),
        "bash"
            | "shell"
            | "shelltoolcall"
            | "exec_command"
            | "run_terminal_cmd"
            | "execute_command"
            | "commandexecution"
    );
    if is_shell {
        let explicit_cwd = ["workdir", "workingDirectory", "working_directory", "cwd"]
            .into_iter()
            .find_map(|key| map.get(key).and_then(Value::as_str))
            .and_then(|raw| resolve_against(base_cwd, raw));
        let cmd_base = explicit_cwd.as_deref().unwrap_or(base_cwd);
        let mut signals = Vec::new();

        if let Some(cmd_text) = extract_command_string(&map)
            && let Some(cd_arg) = parse_leading_cd_target(&cmd_text)
            && let Some(cd_path) = resolve_against(cmd_base, &cd_arg)
        {
            signals.push(DirectorySignal::ExplicitDirectory {
                path: cd_path,
                allow_project_root: true,
            });
        }

        // Only treat the tool's explicit `cwd` field as a specific working-directory
        // choice when it differs from the default project root; commands without
        // `workdir` default `cwd` to `project.path` even while operating on a worktree.
        // Symlink equivalence to `canonical_project` is checked asynchronously in
        // `resolve_from_signals` (`allow_project_root: false`) without blocking I/O here.
        if let Some(dir) = explicit_cwd
            && dir != project_root
            && dir != canonical_project
        {
            signals.push(DirectorySignal::ExplicitDirectory {
                path: dir,
                allow_project_root: false,
            });
        }
        return signals;
    }

    let is_mutating_file_tool = matches!(
        lower.as_str(),
        "edit"
            | "multiedit"
            | "write"
            | "notebookedit"
            | "patch"
            | "apply_patch"
            | "applypatch"
            | "filechange"
            | "create_file"
            | "edit_file"
            | "write_file"
            | "replace_in_file"
            | "str_replace_editor"
            | "edittoolcall"
            | "writetoolcall"
            | "createfiletoolcall"
            | "applypatchtoolcall"
            | "editfiletoolcall"
    );
    if is_mutating_file_tool {
        let mut signals = Vec::new();
        for key in [
            "file_path",
            "filePath",
            "path",
            "notebook_path",
            "target_file",
            "targetFile",
        ] {
            if let Some(raw) = map.get(key).and_then(Value::as_str)
                && let Some(resolved) = resolve_against(base_cwd, raw)
            {
                signals.push(DirectorySignal::MutatedFile(resolved));
            }
        }
        for array_key in ["changes", "files", "edits"] {
            if let Some(items) = map.get(array_key).and_then(Value::as_array) {
                for item in items.iter().take(PATCH_PATH_LIMIT) {
                    let raw = item
                        .as_str()
                        .or_else(|| item.get("path").and_then(Value::as_str))
                        .or_else(|| item.get("file_path").and_then(Value::as_str))
                        .or_else(|| item.get("filePath").and_then(Value::as_str));
                    if let Some(raw) = raw
                        && let Some(resolved) = resolve_against(base_cwd, raw)
                    {
                        signals.push(DirectorySignal::MutatedFile(resolved));
                    }
                }
            }
        }
        for patch_key in ["patch", "input", "diff"] {
            if let Some(patch) = map.get(patch_key).and_then(Value::as_str) {
                for raw in extract_apply_patch_paths(patch) {
                    if let Some(resolved) = resolve_against(base_cwd, &raw) {
                        signals.push(DirectorySignal::MutatedFile(resolved));
                    }
                }
            }
        }
        return signals;
    }

    Vec::new()
}

fn extract_command_string(map: &serde_json::Map<String, Value>) -> Option<String> {
    for key in ["command", "cmd"] {
        match map.get(key)? {
            Value::String(text) => return Some(text.clone()),
            Value::Array(args) => {
                let strs: Vec<&str> = args.iter().take(8).filter_map(Value::as_str).collect();
                if strs.len() >= 3 && matches!(strs[1], "-c" | "-lc" | "-ic") {
                    return Some(strs[2].to_owned());
                }
                return Some(strs.join(" "));
            }
            _ => {}
        }
    }
    None
}

fn extract_apply_patch_paths(patch: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in patch.lines().take(256) {
        for prefix in ["*** Update File: ", "*** Add File: ", "+++ b/"] {
            if let Some(rest) = line.strip_prefix(prefix)
                && !rest.is_empty()
                && rest != "/dev/null"
            {
                out.push(rest.to_owned());
                if out.len() >= PATCH_PATH_LIMIT {
                    return out;
                }
            }
        }
    }
    out
}

/// Extract the target of a leading `cd <dir>` / `pushd <dir>` setup clause
/// (including subshell forms such as `(cd .oh-my-code/worktree/foo && cargo test)`
/// or `(set -euo pipefail && cd "path/with space" && make)`).
fn parse_leading_cd_target(command: &str) -> Option<String> {
    let trimmed = command.trim_start();
    if trimmed.is_empty() || trimmed.len() > 65_536 {
        return None;
    }
    for clause in split_top_level_clauses(trimmed).into_iter().take(4) {
        let s = clause.trim_start().trim_start_matches('(').trim_start();
        if s.is_empty() {
            continue;
        }
        if let Some(target) = parse_cd_clause(s) {
            return Some(target);
        }
        if is_benign_preamble_clause(s) {
            continue;
        }
        break;
    }
    None
}

fn is_benign_preamble_clause(clause: &str) -> bool {
    if clause.starts_with("set ") || clause.starts_with("export ") || clause == "true" {
        return true;
    }
    // Leading `KEY=VALUE` assignment without command execution.
    if let Some((lhs, _)) = clause.split_once('=')
        && !lhs.is_empty()
        && lhs.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        && !clause.contains(' ')
    {
        return true;
    }
    false
}

fn split_top_level_clauses(command: &str) -> Vec<&str> {
    let bytes = command.as_bytes();
    let mut clauses = Vec::new();
    let mut start = 0;
    let mut i = 0;
    let mut single = false;
    let mut double = false;
    while i < bytes.len() {
        let b = bytes[i];
        if single {
            if b == b'\'' {
                single = false;
            }
            i += 1;
            continue;
        }
        if double {
            if b == b'\\' {
                i = (i + 2).min(bytes.len());
                continue;
            }
            if b == b'"' {
                double = false;
            }
            i += 1;
            continue;
        }
        match b {
            b'\\' => {
                i = (i + 2).min(bytes.len());
                continue;
            }
            b'\'' => single = true,
            b'"' => double = true,
            b';' | b'\n' => {
                clauses.push(&command[start..i]);
                start = i + 1;
            }
            b'&' if i + 1 < bytes.len() && bytes[i + 1] == b'&' => {
                clauses.push(&command[start..i]);
                i += 2;
                start = i;
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    if start <= bytes.len() {
        clauses.push(&command[start..]);
    }
    clauses
}

fn parse_cd_clause(clause: &str) -> Option<String> {
    let rest = clause
        .strip_prefix("builtin ")
        .unwrap_or(clause)
        .trim_start();
    let rest = rest
        .strip_prefix("cd")
        .or_else(|| rest.strip_prefix("pushd"))?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let mut rest = rest.trim_start();
    while let Some(flag_rest) = rest.strip_prefix("-P").or_else(|| rest.strip_prefix("-L")) {
        if !flag_rest.starts_with(char::is_whitespace) {
            break;
        }
        rest = flag_rest.trim_start();
    }
    if let Some(after_dashdash) = rest.strip_prefix("--")
        && after_dashdash.starts_with(char::is_whitespace)
    {
        rest = after_dashdash.trim_start();
    }
    let token = parse_shell_path_token(rest)?;
    if token.is_empty() || token == "." || token == "-" || token.starts_with('~') {
        return None;
    }
    Some(token)
}

fn parse_shell_path_token(s: &str) -> Option<String> {
    let mut chars = s.chars().peekable();
    let mut out = String::new();
    let mut single = false;
    let mut double = false;

    while let Some(ch) = chars.next() {
        if single {
            if ch == '\'' {
                single = false;
            } else {
                if ch == '\0' || ch == '\n' {
                    return None;
                }
                out.push(ch);
            }
            continue;
        }
        if double {
            match ch {
                '"' => double = false,
                '$' | '`' | '\0' | '\n' => return None,
                '\\' => {
                    let next = chars.next()?;
                    if matches!(next, '"' | '\\' | '$' | '`') {
                        out.push(next);
                    } else {
                        out.push('\\');
                        out.push(next);
                    }
                }
                _ => out.push(ch),
            }
            continue;
        }
        match ch {
            '\'' => single = true,
            '"' => double = true,
            '\\' => {
                let next = chars.next()?;
                if next == '\n' || next == '\0' {
                    return None;
                }
                out.push(next);
            }
            '$' | '`' | '*' | '?' | '[' | '|' | '&' | ';' | ')' | '(' | '<' | '>' | '\0' => {
                if ch == ')' && !out.is_empty() {
                    break;
                }
                return None;
            }
            c if c.is_whitespace() => break,
            c => out.push(c),
        }
    }
    if single || double || out.is_empty() {
        return None;
    }
    Some(out)
}

async fn git_toplevel_and_common_dir(dir: &Path) -> Option<(PathBuf, PathBuf)> {
    let (output, partial) = files::git(dir, &["rev-parse", "--show-toplevel", "--git-common-dir"])
        .await
        .ok()?;
    if partial {
        return None;
    }
    let mut lines = output.lines();
    let raw_top = lines.next()?;
    let raw_common = lines.next()?;
    let toplevel = tokio::fs::canonicalize(dir.join(raw_top)).await.ok()?;
    let common_dir = tokio::fs::canonicalize(dir.join(raw_common)).await.ok()?;
    Some((toplevel, common_dir))
}

async fn validate_explicit_directory(
    canonical_project: &Path,
    candidate: &Path,
) -> Option<PathBuf> {
    let meta = tokio::fs::metadata(candidate).await.ok()?;
    if !meta.is_dir() {
        return None;
    }
    let canonical_dir = tokio::fs::canonicalize(candidate).await.ok()?;
    if canonical_dir.starts_with(canonical_project) {
        return Some(canonical_dir);
    }
    // Allow external directories only when Git proves they belong to a linked
    // worktree whose shared `.git` common dir resides inside `canonical_project`.
    let (_, common_dir) = git_toplevel_and_common_dir(&canonical_dir).await?;
    common_dir
        .starts_with(canonical_project)
        .then_some(canonical_dir)
}

async fn validate_mutated_file_worktree(
    canonical_project: &Path,
    candidate_file: &Path,
) -> Option<PathBuf> {
    let parent = candidate_file.parent()?;
    let meta = tokio::fs::metadata(parent).await.ok()?;
    if !meta.is_dir() {
        return None;
    }
    let canonical_parent = tokio::fs::canonicalize(parent).await.ok()?;
    let (toplevel, common_dir) = git_toplevel_and_common_dir(&canonical_parent).await?;
    if toplevel.starts_with(canonical_project) || common_dir.starts_with(canonical_project) {
        Some(toplevel)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use latte_work_protocol::EventKind;
    use serde_json::json;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn init_repo(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q", "-b", "main"]);
        git(dir, &["config", "user.name", "Fixture"]);
        git(dir, &["config", "user.email", "fixture@example.test"]);
        std::fs::write(dir.join("README.md"), "# repo\n").unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-qm", "init"]);
    }

    #[test]
    fn parses_leading_cd_across_subshells_quotes_and_preambles() {
        assert_eq!(
            parse_leading_cd_target("(cd .oh-my-code/worktree/continue/fix-ux && cargo test)"),
            Some(".oh-my-code/worktree/continue/fix-ux".into())
        );
        assert_eq!(
            parse_leading_cd_target("set -euo pipefail && cd \"deps/deep/vendor \" && git status"),
            Some("deps/deep/vendor ".into())
        );
        assert_eq!(
            parse_leading_cd_target("export RUST_LOG=info; builtin cd -- 'my worktree' && ls"),
            Some("my worktree".into())
        );
        // Dynamic shell expansions or non-leading `cd` must not guess a directory.
        assert_eq!(parse_leading_cd_target("cd \"$WORKTREE\" && ls"), None);
        assert_eq!(
            parse_leading_cd_target("cargo build && cd dist && ls"),
            None
        );
        assert_eq!(parse_leading_cd_target("cd -"), None);
    }

    #[tokio::test]
    async fn resolves_worktree_across_all_five_agent_tool_shapes_and_guards_boundaries() {
        let workspace = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let unrelated = tempfile::tempdir().unwrap();

        let repo = workspace.path().join("continue");
        init_repo(&repo);
        init_repo(unrelated.path());

        let internal_wt = workspace
            .path()
            .join(".oh-my-code/worktree/continue/fix-ux");
        std::fs::create_dir_all(internal_wt.parent().unwrap()).unwrap();
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "fix/ux",
                internal_wt.to_str().unwrap(),
                "HEAD",
            ],
        );

        let external_wt = external.path().join("codex-wt");
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feat/ext",
                external_wt.to_str().unwrap(),
                "HEAD",
            ],
        );

        let claude_wt = repo.join(".claude/worktrees/claude-feat");
        std::fs::create_dir_all(claude_wt.parent().unwrap()).unwrap();
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feat/claude",
                claude_wt.to_str().unwrap(),
                "HEAD",
            ],
        );

        let canonical_project = workspace.path().canonicalize().unwrap();
        let canonical_internal_wt = internal_wt.canonicalize().unwrap();
        let canonical_external_wt = external_wt.canonicalize().unwrap();
        let canonical_claude_wt = claude_wt.canonicalize().unwrap();

        // 1. Codex/Traex `commandExecution` with external linked worktree `cwd`, followed by
        //    a default-cwd command (`gh auth status` at `project.path`) and `/tmp` escape attempt.
        let codex_events = vec![
            (
                EventKind::Tool {
                    id: "t3".into(),
                    name: "Bash".into(),
                    input: json!({
                        "command": "ls -la",
                        "cwd": "/tmp",
                    }),
                },
                Some(false),
            ),
            (
                EventKind::Tool {
                    id: "t2".into(),
                    name: "Bash".into(),
                    input: json!({
                        "command": "gh auth status",
                        "cwd": canonical_project,
                    }),
                },
                Some(false),
            ),
            (
                EventKind::Tool {
                    id: "t1".into(),
                    name: "Bash".into(),
                    input: json!({
                        "command": ["/bin/zsh", "-lc", "cargo test"],
                        "cwd": external_wt,
                    }),
                },
                Some(false),
            ),
        ];
        assert_eq!(
            resolve_from_tool_events(
                workspace.path(),
                &canonical_project,
                &canonical_project,
                &codex_events
            )
            .await,
            Some(canonical_external_wt.clone())
        );

        // >64 default-cwd `git status` calls and repeated `/tmp` commands must not
        // evict an earlier active worktree.
        let mut noisy_events = Vec::new();
        for idx in 0..80 {
            noisy_events.push((
                EventKind::Tool {
                    id: format!("gs-{idx}"),
                    name: "Bash".into(),
                    input: json!({
                        "command": "git status",
                        "cwd": workspace.path(),
                    }),
                },
                Some(false),
            ));
            noisy_events.push((
                EventKind::Tool {
                    id: format!("tmp-{idx}"),
                    name: "Bash".into(),
                    input: json!({
                        "command": "ls -la",
                        "cwd": "/tmp",
                    }),
                },
                Some(false),
            ));
        }
        noisy_events.push(codex_events[2].clone());
        assert_eq!(
            resolve_from_tool_events(
                workspace.path(),
                &canonical_project,
                &canonical_project,
                &noisy_events
            )
            .await,
            Some(canonical_external_wt.clone())
        );

        // Unrelated external Git repositories must never be accepted.
        let foreign_events = vec![(
            EventKind::Tool {
                id: "f1".into(),
                name: "Bash".into(),
                input: json!({
                    "command": "git status",
                    "cwd": unrelated.path(),
                }),
            },
            Some(false),
        )];
        assert_eq!(
            resolve_from_tool_events(
                workspace.path(),
                &canonical_project,
                &canonical_project,
                &foreign_events
            )
            .await,
            None
        );

        // 2. Claude Code: `Read` on primary checkout does NOT override worktree `Edit`,
        //    and `Edit` inside deep `src/ui/` snaps cleanly to the worktree root.
        let deep_src = internal_wt.join("apps/desktop/src");
        std::fs::create_dir_all(&deep_src).unwrap();
        let claude_events = vec![
            (
                EventKind::Tool {
                    id: "c2".into(),
                    name: "Read".into(),
                    input: json!({ "file_path": repo.join("README.md") }),
                },
                Some(false),
            ),
            (
                EventKind::Tool {
                    id: "c1".into(),
                    name: "Edit".into(),
                    input: json!({ "file_path": deep_src.join("App.tsx") }),
                },
                Some(false),
            ),
        ];
        assert_eq!(
            resolve_from_tool_events(
                workspace.path(),
                &canonical_project,
                &canonical_project,
                &claude_events
            )
            .await,
            Some(canonical_internal_wt.clone())
        );

        // 3. Claude Code `EnterWorktree` (by name), pending/rejected tools, and `ExitWorktree`:
        //    pending (`None`) or failed/rejected (`Some(true)`) `EnterWorktree`, `Bash`, `Edit`,
        //    or `ExitWorktree` must never change the active worktree.
        let claude_wt_next = repo.join(".claude/worktrees/claude-next");
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feat/claude-next",
                claude_wt_next.to_str().unwrap(),
                "HEAD",
            ],
        );
        let enter_events = vec![(
            EventKind::Tool {
                id: "cw1".into(),
                name: "EnterWorktree".into(),
                input: json!({ "name": "claude-feat" }),
            },
            Some(false),
        )];
        let canonical_repo = repo.canonicalize().unwrap();
        assert_eq!(
            resolve_from_tool_events(&repo, &canonical_repo, &canonical_repo, &enter_events).await,
            Some(canonical_claude_wt.clone())
        );
        let unconfirmed_or_rejected_events = vec![
            (
                EventKind::Tool {
                    id: "enter_pending".into(),
                    name: "EnterWorktree".into(),
                    input: json!({ "name": "claude-next" }),
                },
                None,
            ),
            (
                EventKind::Tool {
                    id: "enter_rejected".into(),
                    name: "EnterWorktree".into(),
                    input: json!({ "name": "claude-next" }),
                },
                Some(true),
            ),
            (
                EventKind::Tool {
                    id: "bash_pending".into(),
                    name: "Bash".into(),
                    input: json!({ "command": "cd .claude/worktrees/claude-next && pwd" }),
                },
                None,
            ),
            (
                EventKind::Tool {
                    id: "bash_rejected".into(),
                    name: "Bash".into(),
                    input: json!({ "command": "cd .claude/worktrees/claude-next && pwd" }),
                },
                Some(true),
            ),
            (
                EventKind::Tool {
                    id: "edit_pending".into(),
                    name: "Edit".into(),
                    input: json!({ "file_path": claude_wt_next.join("README.md") }),
                },
                None,
            ),
            (
                EventKind::Tool {
                    id: "cw_pending".into(),
                    name: "ExitWorktree".into(),
                    input: json!({}),
                },
                None,
            ),
            (
                EventKind::Tool {
                    id: "cw_failed".into(),
                    name: "ExitWorktree".into(),
                    input: json!({}),
                },
                Some(true),
            ),
            enter_events[0].clone(),
        ];
        assert_eq!(
            resolve_from_tool_events(
                &repo,
                &canonical_repo,
                &canonical_repo,
                &unconfirmed_or_rejected_events
            )
            .await,
            Some(canonical_claude_wt)
        );
        let exit_events = vec![
            (
                EventKind::Tool {
                    id: "cw2".into(),
                    name: "ExitWorktree".into(),
                    input: json!({}),
                },
                Some(false),
            ),
            enter_events[0].clone(),
        ];
        assert_eq!(
            resolve_from_tool_events(&repo, &canonical_repo, &canonical_repo, &exit_events).await,
            Some(canonical_repo)
        );

        // 4. OpenCode `workdir` and camelCase `filePath`.
        let opencode_events = vec![(
            EventKind::Tool {
                id: "o1".into(),
                name: "Edit".into(),
                input: json!({ "filePath": deep_src.join("main.tsx") }),
            },
            Some(false),
        )];
        assert_eq!(
            resolve_from_tool_events(
                workspace.path(),
                &canonical_project,
                &canonical_project,
                &opencode_events
            )
            .await,
            Some(canonical_internal_wt.clone())
        );

        // 5. Cursor `shellToolCall` (`workingDirectory`) and generic `function` string JSON.
        let cursor_events = vec![(
            EventKind::Tool {
                id: "cu1".into(),
                name: "shellToolCall".into(),
                input: json!({
                    "command": "npm test",
                    "workingDirectory": internal_wt,
                }),
            },
            Some(false),
        )];
        assert_eq!(
            resolve_from_tool_events(
                workspace.path(),
                &canonical_project,
                &canonical_project,
                &cursor_events
            )
            .await,
            Some(canonical_internal_wt.clone())
        );
        let cursor_fn_events = vec![(
            EventKind::Tool {
                id: "cu2".into(),
                name: "edit_file".into(),
                input: Value::String(
                    json!({ "target_file": deep_src.join("index.ts") }).to_string(),
                ),
            },
            Some(false),
        )];
        assert_eq!(
            resolve_from_tool_events(
                workspace.path(),
                &canonical_project,
                &canonical_project,
                &cursor_fn_events
            )
            .await,
            Some(canonical_internal_wt)
        );

        // 6. Once the worktree is removed on disk, stale events pointing to it are skipped.
        git(
            &repo,
            &[
                "worktree",
                "remove",
                "--force",
                internal_wt.to_str().unwrap(),
            ],
        );
        assert_eq!(
            resolve_from_tool_events(
                workspace.path(),
                &canonical_project,
                &canonical_project,
                &cursor_events
            )
            .await,
            None
        );
    }
}
