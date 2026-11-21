//! Claude session metadata: bounded incremental reads and append-only offline rename.
//! Matches the official SDK customTitle > aiTitle > summary ordering. No transcript rewrite.
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::{Metadata, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Instant,
};
const WINDOW: u64 = 64 * 1024;
const SCAN_BUDGET: u64 = 4 * 1024 * 1024;
const MAX_SESSION_COPY: u64 = 256 * 1024 * 1024;
const INDEX_LIMIT: usize = 256;

#[derive(Default)]
struct Titles {
    custom: Option<String>,
    generated: Option<String>,
    summary: Option<String>,
}
impl Titles {
    fn record(&mut self, line: &[u8]) {
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            return;
        };
        // Only native metadata records may name the parent session. User messages
        // and tool payloads can contain identically named fields.
        let slot = match value.get("type").and_then(Value::as_str) {
            Some("custom-title") => (&mut self.custom, "customTitle"),
            Some("ai-title") => (&mut self.generated, "aiTitle"),
            Some("summary") => (&mut self.summary, "summary"),
            _ => return,
        };
        if let Some(text) = value
            .get(slot.1)
            .and_then(Value::as_str)
            .filter(|s| valid_title(s))
        {
            *slot.0 = Some(text.trim().to_owned());
        }
    }
    fn title(&self) -> Option<Title> {
        self.custom
            .as_ref()
            .map(|text| Title {
                text: text.clone(),
                custom: true,
            })
            .or_else(|| {
                self.generated
                    .as_ref()
                    .or(self.summary.as_ref())
                    .map(|text| Title {
                        text: text.clone(),
                        custom: false,
                    })
            })
    }
}
struct TitleIndex {
    identity: (u64, u64),
    size: u64,
    modified: (i64, i64),
    offset: u64,
    line: Vec<u8>,
    oversized: bool,
    titles: Titles,
    touched: Instant,
}
impl TitleIndex {
    fn new(meta: &Metadata) -> Self {
        Self {
            identity: (meta.dev(), meta.ino()),
            size: meta.len(),
            modified: (meta.mtime(), meta.mtime_nsec()),
            offset: 0,
            line: Vec::new(),
            oversized: false,
            titles: Titles::default(),
            touched: Instant::now(),
        }
    }
    fn read(&mut self, file: &mut std::fs::File, meta: &Metadata) -> Result<Option<Title>> {
        if self.identity != (meta.dev(), meta.ino())
            || meta.len() < self.size
            || (meta.len() == self.size && self.modified != (meta.mtime(), meta.mtime_nsec()))
        {
            *self = Self::new(meta);
        }
        self.size = meta.len();
        self.modified = (meta.mtime(), meta.mtime_nsec());
        self.touched = Instant::now();
        file.seek(SeekFrom::Start(self.offset))?;
        let mut bytes = Vec::new();
        file.take(SCAN_BUDGET.min(self.size - self.offset))
            .read_to_end(&mut bytes)?;
        for part in bytes.split_inclusive(|b| *b == b'\n') {
            if !self.oversized && self.line.len() + part.len() <= WINDOW as usize {
                self.line.extend_from_slice(part);
            } else {
                self.line.clear();
                self.oversized = true;
            }
            if part.ends_with(b"\n") {
                if !self.oversized {
                    self.titles.record(&self.line);
                }
                self.line.clear();
                self.oversized = false;
            }
        }
        self.offset += bytes.len() as u64;
        // A partial scan must never roll a confirmed name back to an older record.
        // Subsequent metadata reads continue from this offset, not from the head.
        Ok(
            (self.offset == self.size && self.line.is_empty() && !self.oversized)
                .then(|| self.titles.title())
                .flatten(),
        )
    }
}
fn indexes() -> &'static Mutex<HashMap<PathBuf, TitleIndex>> {
    static INDEXES: OnceLock<Mutex<HashMap<PathBuf, TitleIndex>>> = OnceLock::new();
    INDEXES.get_or_init(|| Mutex::new(HashMap::new()))
}
#[derive(Clone)]
pub struct Title {
    pub text: String,
    pub custom: bool,
}
fn valid_title(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 200 && !value.chars().any(char::is_control)
}
fn configured_projects(
    cwd: &Path,
    environment: &latte_work_protocol::AgentEnvironment,
) -> Result<PathBuf> {
    let config = crate::agent_environment::configured_variable("CLAUDE_CONFIG_DIR", environment)
        .map(PathBuf::from)
        .or_else(|| {
            crate::agent_environment::variable("HOME").map(|p| PathBuf::from(p).join(".claude"))
        })
        .context("无法确定 Claude 会话目录")?;
    Ok(cwd.join(config).join("projects"))
}
fn sanitize_project_path(canonical: &Path) -> String {
    canonical
        .to_string_lossy()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}
fn djb2_base36(input: &str) -> String {
    let mut hash: i32 = 0;
    for unit in input.encode_utf16() {
        hash = hash
            .wrapping_shl(5)
            .wrapping_sub(hash)
            .wrapping_add(i32::from(unit));
    }
    let mut value = hash.unsigned_abs();
    if value == 0 {
        return "0".into();
    }
    let mut digits = Vec::new();
    while value > 0 {
        let rem = (value % 36) as u8;
        digits.push(if rem < 10 {
            b'0' + rem
        } else {
            b'a' + (rem - 10)
        });
        value /= 36;
    }
    digits.reverse();
    String::from_utf8(digits).unwrap_or_else(|_| "0".into())
}
fn former_canonical(former: &str) -> Option<PathBuf> {
    let path = Path::new(former);
    if !path.is_absolute()
        || path.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return None;
    }
    // `project_former_paths` already stores canonical paths captured when the
    // project owned them. Never re-canonicalize on disk later, or a post-move
    // symlink (`ln -s new old` or `ln -s /foreign old`) would redirect lookups.
    Some(path.to_path_buf())
}
fn is_real_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_dir())
}
fn locate_in(projects: &Path, cwd: &Path, id: &str) -> Result<Option<PathBuf>> {
    let canonical = cwd.canonicalize()?;
    locate_in_canonical(projects, &canonical, id)
}
fn locate_in_canonical(projects: &Path, canonical: &Path, id: &str) -> Result<Option<PathBuf>> {
    let parsed = uuid::Uuid::parse_str(id).context("原生会话 ID 无效")?;
    // Require the canonical UUID spelling; never use an input as a free-form path.
    let filename = format!("{parsed}.jsonl");
    let sanitized = sanitize_project_path(canonical);
    let root = match projects.canonicalize() {
        Ok(root) => root,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let mut candidates = if sanitized.len() <= 200 {
        vec![root.join(&sanitized).join(&filename)]
    } else {
        // Native Bun and SDK hash suffixes differ for long paths; match the exact UUID
        // beneath the shared 200-character prefix, bounded and ambiguity checked.
        let prefix = format!("{}-", &sanitized[..200]);
        let mut paths = vec![];
        for (n, entry) in root.read_dir()?.enumerate() {
            if n >= 1024 {
                bail!("Claude 会话目录超出读取范围");
            }
            let entry = entry?;
            if entry.file_type()?.is_dir()
                && entry.file_name().to_string_lossy().starts_with(&prefix)
            {
                paths.push(entry.path().join(&filename));
            }
        }
        paths
    };
    candidates.retain(|p| p.is_file());
    if candidates.len() > 1 {
        bail!("原生会话目录存在歧义");
    }
    let Some(path) = candidates.pop() else {
        return Ok(None);
    };
    let target = path.canonicalize()?;
    if !target.starts_with(&root) || path.symlink_metadata()?.file_type().is_symlink() {
        bail!("拒绝访问 Claude 会话目录外的路径");
    }
    Ok(Some(target))
}
fn locate_in_former(
    cwd: &Path,
    former_paths: &[String],
    id: &str,
    environment: &latte_work_protocol::AgentEnvironment,
) -> Result<Option<PathBuf>> {
    let projects = configured_projects(cwd, environment)?;
    for former in former_paths {
        let Some(canonical) = former_canonical(former) else {
            continue;
        };
        if let Some(found) = locate_in_canonical(&projects, &canonical, id)? {
            return Ok(Some(found));
        }
        let raw = Path::new(former);
        if is_real_dir(raw) {
            let alt_projects = configured_projects(raw, environment)?;
            if alt_projects != projects
                && let Some(found) = locate_in_canonical(&alt_projects, &canonical, id)?
            {
                return Ok(Some(found));
            }
        }
    }
    Ok(None)
}
fn locate_any(
    cwd: &Path,
    former_paths: &[String],
    id: &str,
    environment: &latte_work_protocol::AgentEnvironment,
) -> Result<Option<PathBuf>> {
    let projects = configured_projects(cwd, environment)?;
    if let Some(found) = locate_in(&projects, cwd, id)? {
        return Ok(Some(found));
    }
    locate_in_former(cwd, former_paths, id, environment)
}
fn target_bucket_dir(root: &Path, canonical_cwd: &Path) -> Result<PathBuf> {
    let sanitized = sanitize_project_path(canonical_cwd);
    if sanitized.len() <= 200 {
        return Ok(root.join(sanitized));
    }
    let prefix = format!("{}-", &sanitized[..200]);
    let mut matches = Vec::new();
    for (n, entry) in root.read_dir()?.enumerate() {
        if n >= 1024 {
            bail!("Claude 会话目录超出读取范围");
        }
        let entry = entry?;
        if entry.file_type()?.is_dir() && entry.file_name().to_string_lossy().starts_with(&prefix) {
            matches.push(entry.path());
        }
    }
    if matches.len() > 1 {
        bail!("原生会话目录存在歧义");
    }
    if let Some(existing) = matches.pop() {
        return Ok(existing);
    }
    let hash = djb2_base36(&canonical_cwd.to_string_lossy());
    Ok(root.join(format!("{prefix}{hash}")))
}
pub fn ensure_resumable_in_cwd(
    cwd: &Path,
    former_paths: &[String],
    id: &str,
    environment: &latte_work_protocol::AgentEnvironment,
) -> Result<()> {
    if former_paths.is_empty() {
        return Ok(());
    }
    let parsed = uuid::Uuid::parse_str(id).context("原生会话 ID 无效")?;
    let projects = configured_projects(cwd, environment)?;
    if locate_in(&projects, cwd, id)?.is_some() {
        return Ok(());
    }
    let Some(source_path) = locate_in_former(cwd, former_paths, id, environment)? else {
        return Ok(());
    };
    let source = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(&source_path)?;
    let source_meta = source.metadata()?;
    if !source_meta.is_file() || source_meta.uid() != nix::unistd::Uid::current().as_raw() {
        bail!("Claude 原生会话文件不可用");
    }
    if source_meta.len() > MAX_SESSION_COPY {
        bail!("Claude 原生会话文件超出迁移大小上限");
    }
    std::fs::create_dir_all(&projects)?;
    if projects.symlink_metadata()?.file_type().is_symlink() {
        bail!("拒绝写入符号链接 Claude 会话根目录");
    }
    let root = projects.canonicalize()?;
    let canonical_cwd = cwd.canonicalize()?;
    let bucket = target_bucket_dir(&root, &canonical_cwd)?;
    match std::fs::create_dir(&bucket) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.into()),
    }
    let bucket_meta = bucket.symlink_metadata()?;
    if !bucket_meta.is_dir()
        || bucket_meta.file_type().is_symlink()
        || bucket.canonicalize()? != bucket
        || !bucket.starts_with(&root)
    {
        bail!("拒绝写入 Claude 会话目录外的路径");
    }
    let mut temp = tempfile::Builder::new()
        .prefix(".latte-claude-migrate-")
        .suffix(".tmp")
        .tempfile_in(&bucket)?;
    let mut limited = source.take(MAX_SESSION_COPY + 1);
    let copied = std::io::copy(&mut limited, temp.as_file_mut())?;
    if copied > MAX_SESSION_COPY {
        bail!("Claude 原生会话文件超出迁移大小上限");
    }
    temp.as_file_mut().sync_all()?;
    let destination = bucket.join(format!("{parsed}.jsonl"));
    match temp.persist_noclobber(&destination) {
        Ok(_) => Ok(()),
        Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(e.error.into()),
    }
}
fn read_path(path: &Path) -> Result<Option<Title>> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        bail!("Claude 会话不是普通文件");
    }
    let mut indexes = indexes()
        .lock()
        .map_err(|_| anyhow::anyhow!("原生标题索引锁异常"))?;
    if !indexes.contains_key(path)
        && indexes.len() >= INDEX_LIMIT
        && let Some(oldest) = indexes
            .iter()
            .filter(|(_, entry)| entry.offset == entry.size)
            .min_by_key(|(_, entry)| entry.touched)
            .map(|(key, _)| key.clone())
    {
        indexes.remove(&oldest);
    }
    if !indexes.contains_key(path) && indexes.len() >= INDEX_LIMIT {
        // Finish active scans before admitting more files; otherwise a long list
        // could repeatedly evict every unfinished scan before it reaches its end.
        return Ok(None);
    }
    indexes
        .entry(path.to_owned())
        .or_insert_with(|| TitleIndex::new(&metadata))
        .read(&mut file, &metadata)
}
/// Offline rename always verifies the latest bounded tail, even if a large file's
/// incremental index has not caught up yet. Partial tail records are ignored.
fn read_tail(path: &Path) -> Result<Option<Title>> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        bail!("Claude 会话不是普通文件");
    }
    let start = metadata.len().saturating_sub(WINDOW);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(WINDOW).read_to_end(&mut bytes)?;
    let mut records = bytes.split_inclusive(|b| *b == b'\n');
    if start != 0 {
        records.next();
    }
    let mut titles = Titles::default();
    for line in records.filter(|line| line.ends_with(b"\n")) {
        titles.record(line);
    }
    Ok(titles.title())
}

pub fn read(
    cwd: &Path,
    former_paths: &[String],
    id: &str,
    environment: &latte_work_protocol::AgentEnvironment,
) -> Result<Option<Title>> {
    let Some(path) = locate_any(cwd, former_paths, id, environment)? else {
        return Ok(None);
    };
    read_path(&path)
}

pub(super) struct ChildBytes {
    pub bytes: Vec<u8>,
    pub start: u64,
    pub truncated: bool,
}

fn candidate_parents(
    cwd: &Path,
    former_paths: &[String],
    parent: &str,
    environment: &latte_work_protocol::AgentEnvironment,
) -> Result<Vec<PathBuf>> {
    let mut parents = Vec::new();
    let projects = configured_projects(cwd, environment)?;
    if let Some(primary) = locate_in(&projects, cwd, parent)? {
        parents.push(primary);
    }
    for former in former_paths {
        let Some(canonical) = former_canonical(former) else {
            continue;
        };
        if let Some(found) = locate_in_canonical(&projects, &canonical, parent)?
            && !parents.contains(&found)
        {
            parents.push(found);
        }
        let raw = Path::new(former);
        if is_real_dir(raw) {
            let alt = configured_projects(raw, environment)?;
            if alt != projects
                && let Some(found) = locate_in_canonical(&alt, &canonical, parent)?
                && !parents.contains(&found)
            {
                parents.push(found);
            }
        }
    }
    Ok(parents)
}

/// Construct the native child path from registered identities, never output_file.
pub(super) fn read_child(
    cwd: &Path,
    former_paths: &[String],
    parent: &str,
    child: &str,
    environment: &latte_work_protocol::AgentEnvironment,
) -> Result<Option<ChildBytes>> {
    if child.is_empty()
        || child.len() > 128
        || !child
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Ok(None);
    }
    for parent_path in candidate_parents(cwd, former_paths, parent, environment)? {
        if let Some(bytes) = read_child_path(&parent_path, child)? {
            return Ok(Some(bytes));
        }
    }
    Ok(None)
}

fn open_child_path(parent: &Path, child: &str) -> Result<Option<std::fs::File>> {
    let session_dir = parent.with_extension("");
    let directory = session_dir.join("subagents");
    for path in [&session_dir, &directory] {
        match path.symlink_metadata() {
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
            Ok(_) => bail!("子会话目录不是普通目录"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        }
    }
    let path = directory.join(format!("agent-{child}.jsonl"));
    let expected = match path.symlink_metadata() {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => meta,
        Ok(_) => bail!("子会话记录不是普通文件"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if directory.canonicalize()? != directory || path.canonicalize()? != path {
        bail!("拒绝读取子会话目录外的记录");
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(&path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.dev() != expected.dev()
        || metadata.ino() != expected.ino()
        || metadata.uid() != nix::unistd::Uid::current().as_raw()
    {
        bail!("子会话记录身份已改变");
    }
    Ok(Some(file))
}
fn read_child_path(parent: &Path, child: &str) -> Result<Option<ChildBytes>> {
    const LIMIT: u64 = 512 * 1024;
    let Some(mut file) = open_child_path(parent, child)? else {
        return Ok(None);
    };
    let start = file.metadata()?.len().saturating_sub(LIMIT);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(LIMIT).read_to_end(&mut bytes)?;
    Ok(Some(ChildBytes {
        bytes,
        start,
        truncated: start != 0,
    }))
}

pub(super) struct ChildPageBytes {
    pub bytes: Vec<u8>,
    pub cursor: super::ChildHistoryCursor,
    pub has_more: bool,
}
/// Read whole records in bounded forward pages. A partial last line is retried
/// after the producer appends its newline, never skipped or treated as complete.
pub(super) fn read_child_page(
    cwd: &Path,
    former_paths: &[String],
    parent: &str,
    child: &str,
    environment: &latte_work_protocol::AgentEnvironment,
    cursor: super::ChildHistoryCursor,
) -> Result<Option<ChildPageBytes>> {
    if child.is_empty()
        || child.len() > 128
        || !child
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Ok(None);
    }
    for parent_path in candidate_parents(cwd, former_paths, parent, environment)? {
        if let Some(page) = read_child_page_path(&parent_path, child, cursor.clone())? {
            return Ok(Some(page));
        }
    }
    Ok(None)
}
fn read_child_page_path(
    parent: &Path,
    child: &str,
    mut cursor: super::ChildHistoryCursor,
) -> Result<Option<ChildPageBytes>> {
    let Some(mut file) = open_child_path(parent, child)? else {
        return Ok(None);
    };
    let metadata = file.metadata()?;
    let identity = format!("{}:{}", metadata.dev(), metadata.ino());
    if !cursor.identity.is_empty() && cursor.identity != identity {
        bail!("子会话原始文件已替换，请核对记录");
    }
    if cursor.offset > metadata.len() {
        bail!("子会话原始记录缩短，请核对记录");
    }
    cursor.identity = identity;
    file.seek(SeekFrom::Start(cursor.offset))?;
    let mut reader = BufReader::new(file.take(metadata.len() - cursor.offset));
    let mut bytes = Vec::new();
    let mut partial_tail = false;
    while bytes.len() < 512 * 1024 {
        let mut line = Vec::new();
        // Each native record is independently bounded, with an explicit error
        // instead of silently clipping its text or skipping its remaining bytes.
        (&mut reader)
            .take((latte_work_protocol::MAX_FRAME - 4096 + 1) as u64)
            .read_until(b'\n', &mut line)?;
        if line.is_empty() {
            break;
        }
        if line.strip_suffix(b"\n").unwrap_or(&line).len() > latte_work_protocol::MAX_FRAME - 4096 {
            bail!("子会话单条原始记录超出安全读取范围，内容未截断");
        }
        if !line.ends_with(b"\n") {
            partial_tail = true;
            break;
        }
        bytes.extend(line);
    }
    cursor.pending_tail = partial_tail;
    let has_more = !partial_tail && cursor.offset + (bytes.len() as u64) < metadata.len();
    Ok(Some(ChildPageBytes {
        bytes,
        cursor,
        has_more,
    }))
}
pub fn rename(
    cwd: &Path,
    former_paths: &[String],
    id: &str,
    title: &str,
    environment: &latte_work_protocol::AgentEnvironment,
) -> Result<String> {
    let path =
        locate_any(cwd, former_paths, id, environment)?.context("未找到原生会话，标题未修改")?;
    append(&path, id, title)?;
    let actual = read_tail(&path)?.context("原生标题写入后未能确认")?;
    if !actual.custom || actual.text != title.trim() {
        bail!("原生标题写入后发生变化，请核对后重试");
    }
    Ok(actual.text)
}
fn append(path: &Path, id: &str, title: &str) -> Result<()> {
    if !valid_title(title) {
        bail!("原生会话标题无效");
    }
    let expected = path.symlink_metadata()?;
    if path.canonicalize()? != path || !expected.is_file() {
        bail!("原生会话路径已改变，标题未修改");
    }
    let mut file = OpenOptions::new()
        .append(true)
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file()
        || meta.len() == 0
        || meta.dev() != expected.dev()
        || meta.ino() != expected.ino()
        || path.canonicalize()? != path
    {
        bail!("原生会话文件不可用，标题未修改");
    }
    file.seek(SeekFrom::End(-1))?;
    let mut last = [0];
    file.read_exact(&mut last)?;
    if last != *b"\n" {
        bail!("原生会话记录尚未写入完整，标题未修改");
    }
    // Same append-only mutation as SDK rename_session; never create a missing session.
    let mut record = serde_json::to_vec(
        &json!({"type":"custom-title","customTitle":title.trim(),"sessionId":id}),
    )?;
    record.push(b'\n');
    if file.write(&record)? != record.len() {
        bail!("原生标题写入未完成，请核对会话");
    }
    file.sync_data()?;
    Ok(())
}
#[cfg(test)]
mod tests {
    #[test]
    fn configured_child_reads_keep_scope_and_symlink_guards() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().canonicalize().unwrap();
        let parent = "11111111-1111-4111-8111-111111111111";
        let project: String = cwd
            .to_string_lossy()
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
            .collect();
        let mut environments = Vec::new();
        for scope in ["host", "session"] {
            let config = cwd.join(scope);
            let path = config
                .join("projects")
                .join(&project)
                .join(format!("{parent}.jsonl"));
            let children = path.with_extension("").join("subagents");
            std::fs::create_dir_all(&children).unwrap();
            std::fs::write(&path, "").unwrap();
            std::fs::write(children.join("agent-child.jsonl"), format!("{scope}\n")).unwrap();
            environments.push(latte_work_protocol::AgentEnvironment(
                std::collections::BTreeMap::from([(
                    "CLAUDE_CONFIG_DIR".into(),
                    config.to_string_lossy().into(),
                )]),
            ));
        }
        for (environment, expected) in environments
            .iter()
            .zip([b"host\n".as_slice(), b"session\n"])
        {
            assert_eq!(
                super::read_child(&cwd, &[], parent, "child", environment)
                    .unwrap()
                    .unwrap()
                    .bytes,
                expected
            );
            assert_eq!(
                super::read_child_page(&cwd, &[], parent, "child", environment, Default::default())
                    .unwrap()
                    .unwrap()
                    .bytes,
                expected
            );
            assert!(
                super::read_child_page(
                    &cwd,
                    &[],
                    parent,
                    "../child",
                    environment,
                    Default::default()
                )
                .unwrap()
                .is_none()
            );
        }
        let relative = latte_work_protocol::AgentEnvironment(std::collections::BTreeMap::from([(
            "CLAUDE_CONFIG_DIR".into(),
            "session".into(),
        )]));
        assert_eq!(
            super::read_child(&cwd, &[], parent, "child", &relative)
                .unwrap()
                .unwrap()
                .bytes,
            b"session\n"
        );
        let child = cwd
            .join("session/projects")
            .join(&project)
            .join(parent)
            .join("subagents/agent-child.jsonl");
        std::fs::remove_file(&child).unwrap();
        std::os::unix::fs::symlink(
            cwd.join("host/projects")
                .join(project)
                .join(parent)
                .join("subagents/agent-child.jsonl"),
            &child,
        )
        .unwrap();
        assert!(super::read_child(&cwd, &[], parent, "child", &environments[1]).is_err());
        assert!(
            super::read_child_page(
                &cwd,
                &[],
                parent,
                "child",
                &environments[1],
                Default::default()
            )
            .is_err()
        );
    }
    #[test]
    fn child_record_reads_are_bounded_and_reject_symlink_files_and_directories() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let parent = root.join("11111111-1111-4111-8111-111111111111.jsonl");
        let child_dir = parent.with_extension("").join("subagents");
        std::fs::create_dir_all(&child_dir).unwrap();
        let file = child_dir.join("agent-a123.jsonl");
        std::fs::write(&file, vec![b'x'; 600 * 1024]).unwrap();
        let bytes = super::read_child_path(&parent, "a123").unwrap().unwrap();
        assert_eq!(bytes.bytes.len(), 512 * 1024);
        assert!(bytes.truncated && bytes.start > 0);
        std::fs::remove_file(&file).unwrap();
        let secret = root.join("secret.jsonl");
        std::fs::write(&secret, "private").unwrap();
        std::os::unix::fs::symlink(&secret, &file).unwrap();
        assert!(super::read_child_path(&parent, "a123").is_err());
        std::fs::remove_file(&file).unwrap();
        std::fs::remove_dir(&child_dir).unwrap();
        std::os::unix::fs::symlink(&root, &child_dir).unwrap();
        assert!(super::read_child_path(&parent, "a123").is_err());
        assert!(
            super::read_child(&root, &[], "parent", "../../secret", &Default::default())
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn child_pages_cover_entire_file_and_retry_partial_tail_without_skipping() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().canonicalize().unwrap().join("parent.jsonl");
        std::fs::write(&parent, "").unwrap();
        let children = parent.with_extension("").join("subagents");
        std::fs::create_dir_all(&children).unwrap();
        let path = children.join("agent-a123.jsonl");
        let records = (0..700)
            .map(|i| format!("{{\"n\":{i},\"text\":\"{}\"}}\n", "x".repeat(1024)))
            .collect::<String>();
        std::fs::write(&path, format!("{records}{{\"partial\":true}}")).unwrap();
        let mut cursor = super::super::ChildHistoryCursor::default();
        let mut found = Vec::new();
        loop {
            let page = super::read_child_page_path(&parent, "a123", cursor)
                .unwrap()
                .unwrap();
            cursor = page.cursor;
            cursor.offset += page.bytes.len() as u64;
            found.extend(page.bytes);
            if !page.has_more {
                break;
            }
        }
        assert_eq!(found, records.as_bytes());
        assert_eq!(cursor.offset, records.len() as u64);
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"\n")
            .unwrap();
        let page = super::read_child_page_path(&parent, "a123", cursor)
            .unwrap()
            .unwrap();
        assert_eq!(page.bytes, b"{\"partial\":true}\n");
        let mut invalid = page.cursor;
        invalid.identity = "replaced".into();
        assert!(super::read_child_page_path(&parent, "a123", invalid).is_err());
    }
    #[test]
    fn child_record_limit_excludes_newline_and_retries_an_exact_boundary_tail() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().canonicalize().unwrap().join("parent.jsonl");
        std::fs::write(&parent, "").unwrap();
        let children = parent.with_extension("").join("subagents");
        std::fs::create_dir_all(&children).unwrap();
        let path = children.join("agent-a123.jsonl");
        let limit = latte_work_protocol::MAX_FRAME - 4096;
        let record = format!("{{\"text\":\"{}\"}}", "x".repeat(limit - 11));
        assert_eq!(record.len(), limit);
        std::fs::write(&path, &record).unwrap();
        let cursor = super::super::ChildHistoryCursor::default();
        let partial = super::read_child_page_path(&parent, "a123", Default::default())
            .unwrap()
            .unwrap();
        assert!(partial.bytes.is_empty() && partial.cursor.pending_tail);
        std::fs::write(&path, format!("{record}\n")).unwrap();
        let page = super::read_child_page_path(&parent, "a123", partial.cursor)
            .unwrap()
            .unwrap();
        assert_eq!(page.bytes, format!("{record}\n").as_bytes());
        std::fs::write(&path, format!("{record} \n")).unwrap();
        assert!(super::read_child_page_path(&parent, "a123", cursor).is_err());
    }
    use super::*;
    #[test]
    fn native_titles_follow_sdk_priority_and_rename_preserves_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap().join("session.jsonl");
        let original = "{\"type\":\"user\",\"message\":{\"content\":\"prompt\"}}\n{\"type\":\"ai-title\",\"aiTitle\":\"Generated title\"}\n";
        std::fs::write(&path, original).unwrap();
        assert_eq!(read_path(&path).unwrap().unwrap().text, "Generated title");
        append(
            &path,
            "11111111-1111-4111-8111-111111111111",
            "Manual title",
        )
        .unwrap();
        let title = read_path(&path).unwrap().unwrap();
        assert!(title.custom);
        assert_eq!(title.text, "Manual title");
        assert!(
            std::fs::read_to_string(&path)
                .unwrap()
                .starts_with(original)
        );
        append(&path, "id", "Second title").unwrap();
        assert_eq!(read_path(&path).unwrap().unwrap().text, "Second title");
        assert!(append(&dir.path().join("missing.jsonl"), "id", "No fake session").is_err());
    }
    #[test]
    fn titles_in_the_middle_survive_transcript_growth_and_ignore_payload_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap().join("session.jsonl");
        let padding = format!(
            "{{\"type\":\"assistant\",\"text\":\"{}\"}}\n",
            "x".repeat(2048)
        )
        .repeat(40);
        std::fs::write(
            &path,
            format!("{padding}{{\"type\":\"ai-title\",\"aiTitle\":\"AI name\"}}\n{padding}"),
        )
        .unwrap();
        assert_eq!(read_path(&path).unwrap().unwrap().text, "AI name");
        append(&path, "id", "Native name").unwrap();
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(padding.as_bytes()).unwrap();
        writeln!(
            file,
            "{{\"type\":\"user\",\"customTitle\":\"Not metadata\"}}"
        )
        .unwrap();
        writeln!(
            file,
            "{{\"type\":\"ai-title\",\"aiTitle\":\"Later AI name\"}}"
        )
        .unwrap();
        let title = read_path(&path).unwrap().unwrap();
        assert_eq!(title.text, "Native name");
        assert!(title.custom);
    }
    #[test]
    fn large_title_scans_resume_without_exposing_stale_names_and_retry_partial_records() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap().join("session.jsonl");
        let mut file = OpenOptions::new()
            .append(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        writeln!(
            file,
            "{{\"type\":\"custom-title\",\"customTitle\":\"Old name\"}}"
        )
        .unwrap();
        // An oversized transcript record crosses the scan boundary and must not
        // consume unbounded memory or prevent subsequent metadata from being read.
        file.write_all(&vec![b'x'; SCAN_BUDGET as usize]).unwrap();
        writeln!(
            file,
            "\n{{\"type\":\"custom-title\",\"customTitle\":\"Latest name\"}}"
        )
        .unwrap();
        assert!(read_path(&path).unwrap().is_none());
        // Offline verification must also work before the index catches up.
        append(&path, "id", "Offline latest").unwrap();
        assert_eq!(read_tail(&path).unwrap().unwrap().text, "Offline latest");
        assert_eq!(read_path(&path).unwrap().unwrap().text, "Offline latest");
        file.write_all(b"{\"type\":\"custom-title\",\"customTitle\":\"Partial")
            .unwrap();
        assert!(read_path(&path).unwrap().is_none());
        assert!(append(&path, "id", "Rejected").is_err());
        file.write_all(b" name\"}\n").unwrap();
        assert_eq!(read_path(&path).unwrap().unwrap().text, "Partial name");
        std::fs::write(&path, "{\"type\":\"ai-title\",\"aiTitle\":\"Replaced\"}\n").unwrap();
        let title = read_path(&path).unwrap().unwrap();
        assert_eq!(title.text, "Replaced");
        assert!(!title.custom);
        let replacement = path.with_extension("new");
        std::fs::write(
            &replacement,
            "{\"type\":\"custom-title\",\"customTitle\":\"New inode\"}\n",
        )
        .unwrap();
        std::fs::rename(replacement, &path).unwrap();
        assert_eq!(read_path(&path).unwrap().unwrap().text, "New inode");
    }
    #[test]
    fn session_paths_reject_invalid_ids_symlinks_and_keep_reads_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("project");
        std::fs::create_dir(&cwd).unwrap();
        let projects = dir.path().join("projects");
        std::fs::create_dir(&projects).unwrap();
        assert!(locate_in(&projects, &cwd, "../escape").is_err());
        let name: String = cwd
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        let folder = projects.join(name);
        std::fs::create_dir(&folder).unwrap();
        let id = "11111111-1111-4111-8111-111111111111";
        let external = dir.path().join("private.jsonl");
        std::fs::write(&external, "private").unwrap();
        std::os::unix::fs::symlink(&external, folder.join(format!("{id}.jsonl"))).unwrap();
        assert!(locate_in(&projects, &cwd, id).is_err());
        assert!(read_path(&folder.join(format!("{id}.jsonl"))).is_err());
        let large = dir.path().join("large.jsonl");
        let mut data = vec![b'x'; (WINDOW * 3) as usize];
        data.extend(b"\n{\"type\":\"ai-title\",\"aiTitle\":\"Tail title\"}\n");
        std::fs::write(&large, data).unwrap();
        assert_eq!(read_path(&large).unwrap().unwrap().text, "Tail title");
    }
    #[test]
    fn former_project_paths_preserve_titles_children_and_migrate_transcript_after_disk_move() {
        let root = tempfile::tempdir().unwrap();
        let config_dir = root.path().join("claude-config");
        let old_dir = root.path().join("old-project");
        let new_dir = root.path().join("new-project");
        std::fs::create_dir_all(&old_dir).unwrap();
        let old_canonical = old_dir.canonicalize().unwrap();
        let old_bucket = sanitize_project_path(&old_canonical);
        let id = "11111111-1111-4111-8111-111111111111";
        let old_transcript = config_dir
            .join("projects")
            .join(&old_bucket)
            .join(format!("{id}.jsonl"));
        let old_children = old_transcript.with_extension("").join("subagents");
        std::fs::create_dir_all(&old_children).unwrap();
        std::fs::write(
            &old_transcript,
            "{\"type\":\"ai-title\",\"aiTitle\":\"Old bucket title\"}\n",
        )
        .unwrap();
        std::fs::write(
            old_children.join("agent-child1.jsonl"),
            "{\"n\":1}\n{\"n\":2}",
        )
        .unwrap();
        let env = latte_work_protocol::AgentEnvironment(std::collections::BTreeMap::from([(
            "CLAUDE_CONFIG_DIR".into(),
            config_dir.to_string_lossy().into(),
        )]));
        let first_page =
            read_child_page(&old_canonical, &[], id, "child1", &env, Default::default())
                .unwrap()
                .unwrap();
        assert_eq!(first_page.bytes, b"{\"n\":1}\n");
        assert!(first_page.cursor.pending_tail);

        // Simulate `mv old-project new-project && ln -s new-project old-project`
        // so compatibility symlinks at the former path do not hide the old bucket.
        std::fs::rename(&old_dir, &new_dir).unwrap();
        let new_canonical = new_dir.canonicalize().unwrap();
        std::os::unix::fs::symlink(&new_canonical, &old_canonical).unwrap();
        let former = vec![old_canonical.to_string_lossy().into_owned()];

        assert_eq!(
            read(&new_canonical, &former, id, &env)
                .unwrap()
                .unwrap()
                .text,
            "Old bucket title"
        );
        assert_eq!(
            rename(&new_canonical, &former, id, "Renamed after move", &env).unwrap(),
            "Renamed after move"
        );

        ensure_resumable_in_cwd(&new_canonical, &former, id, &env).unwrap();
        let new_bucket = sanitize_project_path(&new_canonical);
        let migrated = config_dir
            .join("projects")
            .join(&new_bucket)
            .join(format!("{id}.jsonl"));
        assert!(migrated.is_file());
        assert_eq!(
            read(&new_canonical, &[], id, &env).unwrap().unwrap().text,
            "Renamed after move"
        );

        // Replacing the former path with a symlink to an unrelated foreign directory
        // must never expose transcripts from that foreign project's bucket.
        let foreign_dir = root.path().join("foreign-project");
        std::fs::create_dir_all(&foreign_dir).unwrap();
        let foreign_canonical = foreign_dir.canonicalize().unwrap();
        let foreign_id = "22222222-2222-4222-8222-222222222222";
        let foreign_bucket = sanitize_project_path(&foreign_canonical);
        let foreign_transcript = config_dir
            .join("projects")
            .join(&foreign_bucket)
            .join(format!("{foreign_id}.jsonl"));
        std::fs::create_dir_all(foreign_transcript.parent().unwrap()).unwrap();
        std::fs::write(
            &foreign_transcript,
            "{\"type\":\"ai-title\",\"aiTitle\":\"Foreign secret\"}\n",
        )
        .unwrap();
        std::fs::remove_file(&old_canonical).unwrap();
        std::os::unix::fs::symlink(&foreign_canonical, &old_canonical).unwrap();
        assert!(
            read(&new_canonical, &former, foreign_id, &env)
                .unwrap()
                .is_none()
        );

        // Subagent transcripts created under the old bucket keep their original inode & cursor.
        std::fs::OpenOptions::new()
            .append(true)
            .open(old_children.join("agent-child1.jsonl"))
            .unwrap()
            .write_all(b"\n")
            .unwrap();
        let mut cursor = first_page.cursor;
        cursor.offset += first_page.bytes.len() as u64;
        let resumed_page = read_child_page(&new_canonical, &former, id, "child1", &env, cursor)
            .unwrap()
            .unwrap();
        assert_eq!(resumed_page.bytes, b"{\"n\":2}\n");
    }
}
