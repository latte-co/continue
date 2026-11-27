//! Current installed-file metadata only, never an execution/availability decision.
//! Skill locations: <https://code.claude.com/docs/en/skills#choose-where-skills-load>
use anyhow::{Context, Result, bail};
use latte_work_protocol::SkillInfo;
use std::os::unix::fs::OpenOptionsExt;
use std::{
    io::Read,
    path::{Path, PathBuf},
};
const FILE_LIMIT: u64 = 64 * 1024;

pub(crate) fn read(path: &Path, limit: u64) -> Result<String> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NONBLOCK | nix::libc::O_NOFOLLOW)
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() > limit {
        bail!("Skill 元数据超出读取范围");
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        bail!("Skill 元数据超出读取范围");
    }
    String::from_utf8(bytes).context("Skill 文件不是 UTF-8")
}
// Only display scalar frontmatter fields. Never evaluate templates, YAML tags or body commands.
pub(crate) fn field(document: &str, key: &str) -> String {
    let mut lines = document.trim_start_matches('\u{feff}').lines();
    if lines.next().map(str::trim) != Some("---") {
        return String::new();
    }
    let mut found = false;
    let mut value = String::new();
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        if found {
            if line.starts_with([' ', '\t']) || line.trim().is_empty() {
                if !value.is_empty() {
                    value.push(' ');
                }
                value.push_str(line.trim());
                continue;
            }
            break;
        }
        if let Some(raw) = line.strip_prefix(&format!("{key}:")) {
            let raw = raw.trim();
            if [">", ">-", ">+", "|", "|-", "|+", ""].contains(&raw) {
                found = true;
                continue;
            }
            value = if raw.starts_with('"') {
                serde_json::from_str::<String>(raw).unwrap_or_default()
            } else if raw.starts_with('\'') && raw.ends_with('\'') && raw.len() >= 2 {
                raw[1..raw.len() - 1].replace("''", "'")
            } else if raw.starts_with(['[', '{', '!', '&', '*']) {
                String::new()
            } else {
                raw.into()
            };
            break;
        }
    }
    value
        .chars()
        .take(4096)
        .collect::<String>()
        .trim()
        .to_owned()
}
pub(super) fn inspect(directory: &Path, requested: &str) -> Result<Option<SkillInfo>> {
    let directory = match directory.canonicalize() {
        Ok(path) => path,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let entry = directory.join("SKILL.md");
    let target = match entry.canonicalize() {
        Ok(path) => path,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if !target.starts_with(&directory) {
        bail!("Skill 说明文件超出目录范围");
    }
    let document = read(&target, FILE_LIMIT)?;
    let name = field(&document, "name");
    Ok(Some(SkillInfo {
        name: if name.is_empty() {
            requested.into()
        } else {
            name
        },
        description: field(&document, "description"),
        directory: directory.to_str().context("Skill 路径不是 UTF-8")?.into(),
    }))
}

pub(crate) fn find_with_env(
    project: &Path,
    name: &str,
    environment: &latte_work_protocol::AgentEnvironment,
) -> Result<Option<SkillInfo>> {
    let config = crate::agent_environment::configured_variable("CLAUDE_CONFIG_DIR", environment)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            crate::agent_environment::configured_variable("HOME", environment)
                .filter(|v| !v.is_empty())
                .map(|home| PathBuf::from(home).join(".claude"))
        })
        .context("无法确定 Agent 配置目录")?;
    find_in(project, &config, name)
}

pub(crate) fn find_in_roots(roots: &[PathBuf], name: &str) -> Result<Option<SkillInfo>> {
    if !crate::skills::component(name) {
        bail!("Skill 名称无效");
    }
    for root in roots {
        if let Some(found) = inspect(&root.join(name), name)? {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

pub(crate) fn scan_roots(roots: &[PathBuf]) -> Vec<(String, SkillInfo)> {
    const LIMIT: usize = 512;
    let mut seen_slugs = std::collections::HashSet::new();
    let mut seen_dirs = std::collections::HashSet::new();
    let mut found = Vec::new();
    for root in roots {
        let Ok(listing) = std::fs::read_dir(root) else {
            continue;
        };
        let mut entries: Vec<_> = listing.take(8192).filter_map(Result::ok).collect();
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries {
            if found.len() >= LIMIT {
                return found;
            }
            let Some(slug) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !crate::skills::component(&slug) || seen_slugs.contains(&slug) {
                continue;
            }
            if let Ok(Some(info)) = inspect(&entry.path(), &slug)
                && seen_dirs.insert(info.directory.clone())
            {
                seen_slugs.insert(slug.clone());
                found.push((slug, info));
            }
        }
    }
    found
}

pub(crate) struct SkillClassifier {
    project: PathBuf,
    roots: Vec<PathBuf>,
    plugin_index_path: Option<PathBuf>,
    plugin_index: Option<Option<serde_json::Value>>,
    checked: usize,
}

impl SkillClassifier {
    const CLASSIFY_LIMIT: usize = 512;

    pub(crate) fn new(project: &Path, environment: &latte_work_protocol::AgentEnvironment) -> Self {
        let config =
            crate::agent_environment::configured_variable("CLAUDE_CONFIG_DIR", environment)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
                .or_else(|| {
                    crate::agent_environment::configured_variable("HOME", environment)
                        .filter(|v| !v.is_empty())
                        .map(|home| PathBuf::from(home).join(".claude"))
                });
        let mut roots = Vec::new();
        let plugin_index_path = config.as_ref().map(|cfg| {
            roots.push(cfg.join("skills"));
            cfg.join("plugins/installed_plugins.json")
        });
        for parent in project.ancestors().take(32) {
            roots.push(parent.join(".claude/skills"));
            if parent.join(".git").exists() {
                break;
            }
        }
        Self {
            project: project.to_path_buf(),
            roots,
            plugin_index_path,
            plugin_index: None,
            checked: 0,
        }
    }

    pub(crate) fn is_skill(&mut self, name: &str) -> bool {
        if self.plugin_index_path.is_none() || self.checked >= Self::CLASSIFY_LIMIT {
            return false;
        }
        let parts: Vec<_> = name.split(':').collect();
        if parts.len() > 2 || !parts.iter().all(|part| crate::skills::component(part)) {
            return false;
        }
        self.checked += 1;
        if parts.len() == 2 {
            let index = self.plugin_index.get_or_insert_with(|| {
                let path = self.plugin_index_path.as_ref()?;
                if !path.exists() {
                    return None;
                }
                let raw = read(path, 256 * 1024).ok()?;
                serde_json::from_str(&raw).ok()
            });
            let Some(index) = index.as_ref() else {
                return false;
            };
            return find_plugin_in_index(&self.project, index, parts[0], parts[1], name)
                .ok()
                .flatten()
                .is_some();
        }
        for root in &self.roots {
            if let Ok(Some(_)) = inspect(&root.join(name), name) {
                return true;
            }
        }
        false
    }
}

fn find_plugin_in_index(
    project: &Path,
    index: &serde_json::Value,
    plugin: &str,
    skill: &str,
    full_name: &str,
) -> Result<Option<SkillInfo>> {
    let mut matches = Vec::new();
    if let Some(plugins) = index.get("plugins").and_then(|p| p.as_object()) {
        for (key, installs) in plugins.iter().take(256) {
            if key.split('@').next() != Some(plugin) {
                continue;
            }
            for install in installs.as_array().into_iter().flatten().take(16) {
                if let Some(scope) = install.get("projectPath").and_then(|p| p.as_str())
                    && !project.starts_with(scope)
                {
                    continue;
                }
                if let Some(path) = install.get("installPath").and_then(|p| p.as_str()) {
                    let root = Path::new(path);
                    if !root.is_absolute() {
                        continue;
                    }
                    let info = inspect(&root.join("skills").join(skill), full_name)?;
                    let info = if info.is_some() {
                        info
                    } else {
                        inspect(root, full_name)?
                    };
                    if let Some(info) = info
                        && !matches
                            .iter()
                            .any(|existing: &SkillInfo| existing.directory == info.directory)
                    {
                        matches.push(info);
                    }
                }
            }
        }
    }
    if matches.len() > 1 {
        bail!("此 Skill 有多个安装位置，无法确认当前目录");
    }
    Ok(matches.pop())
}

pub(crate) fn find_in(project: &Path, config: &Path, name: &str) -> Result<Option<SkillInfo>> {
    let parts: Vec<_> = name.split(':').collect();
    if parts.len() > 2 || !parts.iter().all(|part| crate::skills::component(part)) {
        bail!("Skill 名称无效");
    }
    if parts.len() == 2 {
        // Resolve exact installed plugin identity, never scan arbitrary cached versions.
        let index = config.join("plugins/installed_plugins.json");
        if !index.exists() {
            return Ok(None);
        }
        let index: serde_json::Value = serde_json::from_str(&read(&index, 256 * 1024)?)?;
        return find_plugin_in_index(project, &index, parts[0], parts[1], name);
    }
    // Personal precedes project. Symlinked skill folders are supported by canonicalizing them.
    if let Some(info) = inspect(&config.join("skills").join(name), name)? {
        return Ok(Some(info));
    }
    for parent in project.ancestors().take(32) {
        if let Some(info) = inspect(&parent.join(".claude/skills").join(name), name)? {
            return Ok(Some(info));
        }
        if parent.join(".git").exists() {
            break;
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn skill(directory: &Path, contents: &str) {
        std::fs::create_dir_all(directory).unwrap();
        std::fs::write(directory.join("SKILL.md"), contents).unwrap();
    }
    #[test]
    fn dotted_names_match_the_manager_without_loosening_path_boundaries() {
        let directory = tempfile::tempdir().unwrap();
        let config = directory.path().join("config");
        let project = directory.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        skill(
            &config.join("skills/a.b"),
            "---\nname: Dot skill\n---\nBody",
        );
        assert_eq!(
            find_in(&project, &config, "a.b").unwrap().unwrap().name,
            "Dot skill"
        );
        for invalid in [
            ".hidden",
            "..",
            "../a.b",
            "a.b/../other",
            "a.b\\other",
            "plugin:.hidden",
        ] {
            assert!(find_in(&project, &config, invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn reads_real_frontmatter_and_personal_precedence_without_running_body() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("config");
        let project = temp.path().join("project");
        skill(
            &project.join(".claude/skills/review"),
            "---\nname: project\n---\n",
        );
        skill(
            &config.join("skills/review"),
            "---\nname: Review\ndescription: >-\n  Inspect changes\n  with evidence.\n---\n!`touch MUST_NOT_EXIST`\n",
        );
        let info = find_in(&project, &config, "review").unwrap().unwrap();
        assert_eq!(info.name, "Review");
        assert_eq!(info.description, "Inspect changes with evidence.");
        assert!(!temp.path().join("MUST_NOT_EXIST").exists());
        assert_eq!(
            field("---\ndescription: 'It''s read-only'\n---", "description"),
            "It's read-only"
        );
        assert_eq!(
            field("---\ndescription: \"Line\\nTwo\"\n---", "description"),
            "Line\nTwo"
        );
    }
    #[test]
    fn rejects_traversal_oversize_and_symlinked_entry_escape_but_accepts_skill_folder_links() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for name in ["../secret", "/tmp", "a:b:c", "a/skill", "."] {
            assert!(find_in(root, root, name).is_err());
        }
        skill(&root.join("actual"), "---\ndescription: linked\n---");
        std::fs::create_dir_all(root.join("skills")).unwrap();
        std::os::unix::fs::symlink(root.join("actual"), root.join("skills/linked")).unwrap();
        assert_eq!(
            find_in(root, root, "linked").unwrap().unwrap().description,
            "linked"
        );
        skill(
            &root.join("skills/large"),
            &"a".repeat(FILE_LIMIT as usize + 1),
        );
        assert!(find_in(root, root, "large").is_err());
        std::fs::create_dir_all(root.join("skills/escape")).unwrap();
        std::os::unix::fs::symlink(
            root.join("actual/SKILL.md"),
            root.join("skills/escape/SKILL.md"),
        )
        .unwrap();
        assert!(find_in(root, root, "escape").is_err());
        assert!(find_in(root, root, "missing").unwrap().is_none());
    }
    #[test]
    fn resolves_only_the_requested_installed_plugin() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let install = root.join("installed");
        skill(
            &install.join("skills/review"),
            "---\nname: Review\ndescription: Plugin review\n---",
        );
        std::fs::create_dir_all(root.join("plugins")).unwrap();
        std::fs::write(
            root.join("plugins/installed_plugins.json"),
            serde_json::json!({"plugins":{"example@market":[{"installPath":install}]}}).to_string(),
        )
        .unwrap();
        assert_eq!(
            find_in(root, root, "example:review")
                .unwrap()
                .unwrap()
                .description,
            "Plugin review"
        );
        assert!(find_in(root, root, "other:review").unwrap().is_none());
    }

    #[test]
    fn sorts_before_truncating_large_roots_and_caches_plugin_index_once() {
        let temp = tempfile::tempdir().unwrap();
        let skills_root = temp.path().join("skills");
        for idx in 0..540 {
            skill(
                &skills_root.join(format!("zzz-skill-{idx:03}")),
                "---\nname: Late\n---",
            );
        }
        skill(&skills_root.join("aaa-first"), "---\nname: First\n---");
        let scanned = scan_roots(&[skills_root]);
        assert_eq!(scanned.len(), 512);
        assert_eq!(scanned[0].0, "aaa-first");

        let install = temp.path().join("installed");
        skill(&install.join("skills/review"), "---\nname: Review\n---");
        std::fs::create_dir_all(temp.path().join("plugins")).unwrap();
        let index_path = temp.path().join("plugins/installed_plugins.json");
        std::fs::write(
            &index_path,
            serde_json::json!({"plugins":{"example@market":[{"installPath":install}]}}).to_string(),
        )
        .unwrap();
        let env = latte_work_protocol::AgentEnvironment(std::collections::BTreeMap::from([(
            "CLAUDE_CONFIG_DIR".into(),
            temp.path().to_string_lossy().into_owned(),
        )]));
        let mut classifier = SkillClassifier::new(temp.path(), &env);
        assert!(classifier.is_skill("example:review"));
        // Removing the file after the first lookup proves the parsed index is cached in memory.
        std::fs::remove_file(&index_path).unwrap();
        assert!(classifier.is_skill("example:review"));
        assert!(!classifier.is_skill("other:review"));
    }
}
