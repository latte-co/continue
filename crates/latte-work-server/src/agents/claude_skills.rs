//! Current installed-file metadata only, never an execution/availability decision.
//! Skill locations: <https://code.claude.com/docs/en/skills#choose-where-skills-load>
use anyhow::{Context, Result, bail};
use latte_work_protocol::SkillInfo;
use std::{
    io::Read,
    path::{Path, PathBuf},
};
const FILE_LIMIT: u64 = 64 * 1024;

pub(crate) fn read(path: &Path, limit: u64) -> Result<String> {
    let file = latte_work_platform::fs::open_regular_file(path)?;
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

pub fn find(project: &Path, name: &str) -> Result<Option<SkillInfo>> {
    find_with_home(project, name, crate::agent_environment::home_dir())
}
pub(in crate::agents) fn find_with_home(
    project: &Path,
    name: &str,
    home: Option<PathBuf>,
) -> Result<Option<SkillInfo>> {
    let config = crate::agent_environment::variable("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| home.map(|home| home.join(".claude")))
        .context("无法确定 Agent 配置目录")?;
    find_in(project, &config, name)
}
fn find_in(project: &Path, config: &Path, name: &str) -> Result<Option<SkillInfo>> {
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
        let mut matches = Vec::new();
        if let Some(plugins) = index.get("plugins").and_then(|p| p.as_object()) {
            for (key, installs) in plugins.iter().take(256) {
                if key.split('@').next() != Some(parts[0]) {
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
                        let info = inspect(&root.join("skills").join(parts[1]), name)?;
                        let info = if info.is_some() {
                            info
                        } else {
                            inspect(root, name)?
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
        return Ok(matches.pop());
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
    #[cfg(windows)]
    #[tokio::test]
    async fn windows_home_absent_skill_metadata_keeps_project_and_user_lookups_and_overrides() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        std::fs::create_dir_all(project.join(".git")).unwrap();
        for (relative, name) in [
            ("project/.claude/skills/claude-project", "Claude project"),
            (
                "project/.opencode/skills/opencode-project",
                "OpenCode project",
            ),
            ("profile/.claude/skills/claude-user", "Claude user"),
            (
                "profile/.config/opencode/skills/opencode-user",
                "OpenCode user",
            ),
            ("profile/.claude/skills/home-choice", "Wrong profile"),
            ("profile/.agents/skills/agent-home-choice", "Wrong profile"),
            ("explicit-home/.claude/skills/home-choice", "Explicit HOME"),
            (
                "explicit-home/.agents/skills/agent-home-choice",
                "Explicit HOME",
            ),
            (
                "claude-config/skills/config-choice",
                "Explicit Claude config",
            ),
            (
                "opencode-config/skills/config-choice",
                "Explicit OpenCode config",
            ),
        ] {
            skill(
                &root.path().join(relative),
                &format!("---\nname: {name}\n---\nBody"),
            );
        }
        for mode in ["native", "home", "config"] {
            let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "agents::claude_skills::tests::windows_skill_metadata_fixture",
                    "--ignored",
                ])
                .env_remove("HOME")
                .env_remove("CLAUDE_CONFIG_DIR")
                .env_remove("OPENCODE_CONFIG_DIR")
                .env_remove("XDG_CONFIG_HOME")
                .env("LATTE_TEST_SKILL_ROOT", root.path())
                .env("LATTE_TEST_SKILL_MODE", mode);
            if mode != "native" {
                command.env("HOME", root.path().join("explicit-home"));
            }
            if mode == "config" {
                command
                    .env("CLAUDE_CONFIG_DIR", root.path().join("claude-config"))
                    .env("OPENCODE_CONFIG_DIR", root.path().join("opencode-config"));
            }
            let (status, output) = latte_work_platform::process::output(
                &mut command,
                std::time::Duration::from_secs(15),
                16 * 1024,
            )
            .await
            .unwrap();
            assert!(status.success(), "{}", String::from_utf8_lossy(&output));
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "isolated HOME/profile fixture launched by native skill regression"]
    async fn windows_skill_metadata_fixture() {
        let root = PathBuf::from(std::env::var_os("LATTE_TEST_SKILL_ROOT").unwrap());
        let project = root.join("project");
        let mode = std::env::var("LATTE_TEST_SKILL_MODE").unwrap();
        if mode == "native" {
            assert!(std::env::var_os("HOME").is_none());
            assert_eq!(
                crate::agent_environment::home_dir().unwrap(),
                latte_work_platform::dirs::home_dir().unwrap()
            );
        } else {
            assert_eq!(
                crate::agent_environment::home_dir().unwrap(),
                root.join("explicit-home")
            );
        }
        let expected = if mode == "config" {
            vec![
                ("claude", "config-choice", "Explicit Claude config"),
                ("opencode", "config-choice", "Explicit OpenCode config"),
                ("opencode", "agent-home-choice", "Explicit HOME"),
            ]
        } else if mode == "home" {
            vec![
                ("claude", "home-choice", "Explicit HOME"),
                ("opencode", "agent-home-choice", "Explicit HOME"),
            ]
        } else {
            assert!(std::env::var_os("HOME").is_none());
            vec![
                ("claude", "claude-project", "Claude project"),
                ("opencode", "opencode-project", "OpenCode project"),
                ("claude", "claude-user", "Claude user"),
                ("opencode", "opencode-user", "OpenCode user"),
            ]
        };
        for (agent, name, title) in expected {
            let found = if mode == "native" && name.ends_with("-user") {
                // The real Windows known-folder profile must not be rewritten by
                // this test. Exercise the same lookup with a disposable profile.
                if agent == "claude" {
                    find_with_home(&project, name, Some(root.join("profile")))
                } else {
                    crate::agents::opencode::skill_info_with_home(
                        &project,
                        name,
                        Some(root.join("profile")),
                    )
                }
                .unwrap()
                .unwrap()
            } else {
                crate::agents::skill_info(agent, project.clone(), name.into())
                    .await
                    .unwrap()
                    .unwrap()
            };
            assert_eq!(found.name, title);
        }
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
    #[cfg(unix)]
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
}
