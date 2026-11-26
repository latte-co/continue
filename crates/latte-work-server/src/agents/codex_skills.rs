//! Read-only Codex skill lookup matching Codex CLI's scope ordering and `[[skills.config]]` rules.
use anyhow::{Result, bail};
use latte_work_protocol::{AgentEnvironment, SkillInfo};
use std::{
    collections::{HashSet, VecDeque},
    io::Read,
    path::{Path, PathBuf},
};

const CONFIG_FILE_LIMIT: u64 = 256 * 1024;
const DIR_ENTRY_LIMIT: usize = 256;
const WALK_DIR_LIMIT: usize = 64;
const WALK_DEPTH_LIMIT: usize = 3;

#[derive(Debug, Clone)]
pub(super) struct SkillConfigRule {
    path: Option<PathBuf>,
    name: Option<String>,
    enabled: bool,
}

impl SkillConfigRule {
    fn matches(&self, skill_md: &Path, info_name: &str, folder_slug: &str) -> bool {
        match (&self.path, &self.name) {
            (Some(rule_path), Some(rule_name)) => {
                rule_path == skill_md && (rule_name == info_name || rule_name == folder_slug)
            }
            (Some(rule_path), None) => rule_path == skill_md,
            (None, Some(rule_name)) => rule_name == info_name || rule_name == folder_slug,
            (None, None) => false,
        }
    }
}

pub(super) fn is_skill_enabled(
    rules: &[SkillConfigRule],
    skill_md: &Path,
    info_name: &str,
    folder_slug: &str,
) -> bool {
    let mut enabled = true;
    for rule in rules {
        if rule.matches(skill_md, info_name, folder_slug) {
            enabled = rule.enabled;
        }
    }
    enabled
}

#[derive(Debug)]
struct Candidate {
    skill_md: PathBuf,
    folder_slug: String,
    info: SkillInfo,
}

pub(crate) fn find(
    project: &Path,
    name: &str,
    environment: &AgentEnvironment,
) -> Result<Option<SkillInfo>> {
    if !crate::skills::component(name) {
        bail!("Skill 名称无效");
    }
    let home = crate::agent_environment::configured_variable("HOME", environment)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    let codex_home = crate::agent_environment::configured_variable("CODEX_HOME", environment)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|h| h.join(".codex")));

    let mut config_files = vec![PathBuf::from("/etc/codex/config.toml")];
    if let Some(codex_home) = &codex_home {
        config_files.push(codex_home.join("config.toml"));
    }
    let rules = load_config_rules(&config_files, home.as_deref());

    let mut repo_roots = Vec::new();
    for parent in project.ancestors().take(32) {
        repo_roots.push((parent.join(".agents/skills"), false));
        repo_roots.push((parent.join(".codex/skills"), false));
        if parent.join(".git").exists() {
            break;
        }
    }

    let mut user_roots = Vec::new();
    if let Some(codex_home) = &codex_home {
        user_roots.push((codex_home.join("skills"), true));
    }
    if let Some(home) = &home {
        user_roots.push((home.join(".agents/skills"), false));
    }

    let mut system_roots = Vec::new();
    if let Some(codex_home) = &codex_home {
        system_roots.push((codex_home.join("skills/.system"), false));
    }

    for scope_roots in [&repo_roots, &user_roots, &system_roots] {
        let mut candidates = collect_scope_candidates(scope_roots, name)?;
        candidates.sort_by(|a, b| a.skill_md.cmp(&b.skill_md));
        for candidate in candidates {
            if is_skill_enabled(
                &rules,
                &candidate.skill_md,
                &candidate.info.name,
                &candidate.folder_slug,
            ) {
                return Ok(Some(candidate.info));
            }
        }
    }
    Ok(None)
}

pub(super) fn load_config_rules(
    config_files: &[PathBuf],
    home: Option<&Path>,
) -> Vec<SkillConfigRule> {
    let mut rules = Vec::new();
    for path in config_files {
        let Ok(canonical) = path.canonicalize() else {
            continue;
        };
        let Ok(file) = std::fs::File::open(&canonical) else {
            continue;
        };
        let Ok(meta) = file.metadata() else {
            continue;
        };
        if !meta.is_file() || meta.len() > CONFIG_FILE_LIMIT {
            continue;
        }
        let mut bytes = Vec::new();
        if file
            .take(CONFIG_FILE_LIMIT + 1)
            .read_to_end(&mut bytes)
            .is_err()
            || bytes.len() as u64 > CONFIG_FILE_LIMIT
        {
            continue;
        }
        let Ok(text) = String::from_utf8(bytes) else {
            continue;
        };
        rules.extend(parse_skills_config_toml(&text, home));
    }
    rules
}

fn collect_scope_candidates(roots: &[(PathBuf, bool)], requested: &str) -> Result<Vec<Candidate>> {
    let mut seen_skill_md = HashSet::new();
    let mut out = Vec::new();

    for (root, skip_system) in roots {
        if !(*skip_system && requested == ".system")
            && let Some(info) = super::claude_skills::inspect(&root.join(requested), requested)?
            && let Ok(skill_md) = Path::new(&info.directory).join("SKILL.md").canonicalize()
            && seen_skill_md.insert(skill_md.clone())
        {
            out.push(Candidate {
                skill_md,
                folder_slug: requested.to_owned(),
                info,
            });
        }

        let mut queue = VecDeque::from([(root.clone(), 0_usize)]);
        let mut walked = 0_usize;
        while let Some((dir, depth)) = queue.pop_front() {
            if walked >= WALK_DIR_LIMIT {
                break;
            }
            walked += 1;
            let Ok(listing) = std::fs::read_dir(&dir) else {
                continue;
            };
            let mut entries: Vec<_> = listing
                .take(DIR_ENTRY_LIMIT)
                .filter_map(Result::ok)
                .collect();
            entries.sort_by_key(std::fs::DirEntry::file_name);
            for entry in entries {
                let Some(entry_name) = entry.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                if entry_name.starts_with('.')
                    || matches!(entry_name.as_str(), "node_modules" | "target")
                {
                    continue;
                }
                let entry_path = entry.path();
                if let Ok(Some(info)) = super::claude_skills::inspect(&entry_path, &entry_name) {
                    if (info.name == requested || entry_name == requested)
                        && let Ok(skill_md) =
                            Path::new(&info.directory).join("SKILL.md").canonicalize()
                        && seen_skill_md.insert(skill_md.clone())
                    {
                        out.push(Candidate {
                            skill_md,
                            folder_slug: entry_name,
                            info,
                        });
                    }
                    continue;
                }
                if depth + 1 < WALK_DEPTH_LIMIT && entry.file_type().is_ok_and(|ft| ft.is_dir()) {
                    queue.push_back((entry_path, depth + 1));
                }
            }
        }
    }
    Ok(out)
}

fn normalize_rule_path(raw: &str, home: Option<&Path>) -> Option<PathBuf> {
    if raw.is_empty() {
        return None;
    }
    let expanded = if raw == "~" {
        home.map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(raw))
    } else if let Some(rest) = raw.strip_prefix("~/") {
        home.map(|h| h.join(rest))
            .unwrap_or_else(|| PathBuf::from(raw))
    } else {
        PathBuf::from(raw)
    };
    Some(std::fs::canonicalize(&expanded).unwrap_or(expanded))
}

#[derive(Default)]
struct RawRule {
    path: Option<String>,
    name: Option<String>,
    enabled: Option<bool>,
}

impl RawRule {
    fn finish(self, home: Option<&Path>) -> Option<SkillConfigRule> {
        let enabled = self.enabled?;
        let path = self
            .path
            .as_deref()
            .and_then(|p| normalize_rule_path(p, home));
        let name = self.name.filter(|n| !n.is_empty());
        if path.is_none() && name.is_none() {
            return None;
        }
        Some(SkillConfigRule {
            path,
            name,
            enabled,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    LBracket,
    RBracket,
    LBrace,
    RBrace,
    Equals,
    Comma,
    Dot,
    Newline,
    Str(String),
    Bare(String),
}

enum TomlVal {
    Str(String),
    Bool(bool),
    Array(Vec<TomlVal>),
    Table(Vec<(Vec<String>, TomlVal)>),
    Other,
}

fn tokenize_toml(input: &str) -> Vec<Token> {
    let chars: Vec<char> = input.trim_start_matches('\u{feff}').chars().collect();
    let mut i = 0;
    let mut tokens = Vec::new();
    while i < chars.len() {
        match chars[i] {
            ' ' | '\t' | '\r' => i += 1,
            '\n' => {
                tokens.push(Token::Newline);
                i += 1;
            }
            '#' => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '[' => {
                tokens.push(Token::LBracket);
                i += 1;
            }
            ']' => {
                tokens.push(Token::RBracket);
                i += 1;
            }
            '{' => {
                tokens.push(Token::LBrace);
                i += 1;
            }
            '}' => {
                tokens.push(Token::RBrace);
                i += 1;
            }
            '=' => {
                tokens.push(Token::Equals);
                i += 1;
            }
            ',' => {
                tokens.push(Token::Comma);
                i += 1;
            }
            '.' => {
                tokens.push(Token::Dot);
                i += 1;
            }
            '"' => {
                if i + 2 < chars.len() && chars[i + 1] == '"' && chars[i + 2] == '"' {
                    i += 3;
                    if i < chars.len() && chars[i] == '\r' {
                        i += 1;
                    }
                    if i < chars.len() && chars[i] == '\n' {
                        i += 1;
                    }
                    let mut s = String::new();
                    while i < chars.len() {
                        if i + 2 < chars.len()
                            && chars[i] == '"'
                            && chars[i + 1] == '"'
                            && chars[i + 2] == '"'
                        {
                            i += 3;
                            break;
                        }
                        if chars[i] == '\\' {
                            i += 1;
                            if let Some(ch) = consume_basic_escape(&chars, &mut i, true) {
                                s.push(ch);
                            }
                        } else {
                            s.push(chars[i]);
                            i += 1;
                        }
                    }
                    tokens.push(Token::Str(s));
                } else {
                    i += 1;
                    let mut s = String::new();
                    while i < chars.len() && chars[i] != '"' && chars[i] != '\n' {
                        if chars[i] == '\\' {
                            i += 1;
                            if let Some(ch) = consume_basic_escape(&chars, &mut i, false) {
                                s.push(ch);
                            }
                        } else {
                            s.push(chars[i]);
                            i += 1;
                        }
                    }
                    if i < chars.len() && chars[i] == '"' {
                        i += 1;
                    }
                    tokens.push(Token::Str(s));
                }
            }
            '\'' => {
                if i + 2 < chars.len() && chars[i + 1] == '\'' && chars[i + 2] == '\'' {
                    i += 3;
                    if i < chars.len() && chars[i] == '\r' {
                        i += 1;
                    }
                    if i < chars.len() && chars[i] == '\n' {
                        i += 1;
                    }
                    let mut s = String::new();
                    while i < chars.len() {
                        if i + 2 < chars.len()
                            && chars[i] == '\''
                            && chars[i + 1] == '\''
                            && chars[i + 2] == '\''
                        {
                            i += 3;
                            break;
                        }
                        s.push(chars[i]);
                        i += 1;
                    }
                    tokens.push(Token::Str(s));
                } else {
                    i += 1;
                    let mut s = String::new();
                    while i < chars.len() && chars[i] != '\'' && chars[i] != '\n' {
                        s.push(chars[i]);
                        i += 1;
                    }
                    if i < chars.len() && chars[i] == '\'' {
                        i += 1;
                    }
                    tokens.push(Token::Str(s));
                }
            }
            _ => {
                let start = i;
                while i < chars.len()
                    && !matches!(
                        chars[i],
                        ' ' | '\t'
                            | '\r'
                            | '\n'
                            | '#'
                            | '['
                            | ']'
                            | '{'
                            | '}'
                            | '='
                            | ','
                            | '.'
                            | '"'
                            | '\''
                    )
                {
                    i += 1;
                }
                let bare: String = chars[start..i].iter().collect();
                tokens.push(Token::Bare(bare));
            }
        }
    }
    tokens
}

fn consume_basic_escape(chars: &[char], i: &mut usize, multiline: bool) -> Option<char> {
    if *i >= chars.len() {
        return None;
    }
    let ch = chars[*i];
    *i += 1;
    match ch {
        '"' => Some('"'),
        '\\' => Some('\\'),
        'b' => Some('\u{0008}'),
        'f' => Some('\u{000C}'),
        'n' => Some('\n'),
        'r' => Some('\r'),
        't' => Some('\t'),
        'u' => consume_hex_unicode(chars, i, 4),
        'U' => consume_hex_unicode(chars, i, 8),
        ' ' | '\t' | '\r' | '\n' if multiline => {
            while *i < chars.len() && matches!(chars[*i], ' ' | '\t' | '\r' | '\n') {
                *i += 1;
            }
            None
        }
        other => Some(other),
    }
}

fn consume_hex_unicode(chars: &[char], i: &mut usize, digits: usize) -> Option<char> {
    if *i + digits > chars.len() {
        return None;
    }
    let hex: String = chars[*i..*i + digits].iter().collect();
    *i += digits;
    u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32)
}

fn parse_key_segments(tokens: &[Token], pos: &mut usize) -> Option<Vec<String>> {
    let mut segs = Vec::new();
    loop {
        match tokens.get(*pos) {
            Some(Token::Bare(s) | Token::Str(s)) => {
                segs.push(s.clone());
                *pos += 1;
            }
            _ => return None,
        }
        if tokens.get(*pos) == Some(&Token::Dot) {
            *pos += 1;
        } else {
            break;
        }
    }
    Some(segs)
}

fn skip_newlines(tokens: &[Token], pos: &mut usize) {
    while tokens.get(*pos) == Some(&Token::Newline) {
        *pos += 1;
    }
}

fn parse_value(tokens: &[Token], pos: &mut usize, depth: usize) -> TomlVal {
    if depth > 16 {
        return TomlVal::Other;
    }
    match tokens.get(*pos) {
        Some(Token::Str(s)) => {
            let v = s.clone();
            *pos += 1;
            TomlVal::Str(v)
        }
        Some(Token::Bare(b)) if b == "true" || b == "false" => {
            let v = b == "true";
            *pos += 1;
            TomlVal::Bool(v)
        }
        Some(Token::LBracket) => {
            *pos += 1;
            let mut items = Vec::new();
            loop {
                skip_newlines(tokens, pos);
                if *pos >= tokens.len() || tokens[*pos] == Token::RBracket {
                    if tokens.get(*pos) == Some(&Token::RBracket) {
                        *pos += 1;
                    }
                    break;
                }
                items.push(parse_value(tokens, pos, depth + 1));
                skip_newlines(tokens, pos);
                if tokens.get(*pos) == Some(&Token::Comma) {
                    *pos += 1;
                } else {
                    skip_newlines(tokens, pos);
                    if tokens.get(*pos) == Some(&Token::RBracket) {
                        *pos += 1;
                    }
                    break;
                }
            }
            TomlVal::Array(items)
        }
        Some(Token::LBrace) => {
            *pos += 1;
            let mut entries = Vec::new();
            loop {
                skip_newlines(tokens, pos);
                if *pos >= tokens.len() || tokens[*pos] == Token::RBrace {
                    if tokens.get(*pos) == Some(&Token::RBrace) {
                        *pos += 1;
                    }
                    break;
                }
                let Some(key) = parse_key_segments(tokens, pos) else {
                    while *pos < tokens.len() && tokens[*pos] != Token::RBrace {
                        *pos += 1;
                    }
                    if tokens.get(*pos) == Some(&Token::RBrace) {
                        *pos += 1;
                    }
                    break;
                };
                if tokens.get(*pos) == Some(&Token::Equals) {
                    *pos += 1;
                    let val = parse_value(tokens, pos, depth + 1);
                    entries.push((key, val));
                }
                skip_newlines(tokens, pos);
                if tokens.get(*pos) == Some(&Token::Comma) {
                    *pos += 1;
                } else {
                    skip_newlines(tokens, pos);
                    if tokens.get(*pos) == Some(&Token::RBrace) {
                        *pos += 1;
                    }
                    break;
                }
            }
            TomlVal::Table(entries)
        }
        Some(_) => {
            while *pos < tokens.len()
                && !matches!(
                    tokens[*pos],
                    Token::Newline | Token::Comma | Token::RBracket | Token::RBrace
                )
            {
                *pos += 1;
            }
            TomlVal::Other
        }
        None => TomlVal::Other,
    }
}

fn extract_inline_rules(val: TomlVal, home: Option<&Path>, rules: &mut Vec<SkillConfigRule>) {
    let TomlVal::Array(items) = val else {
        return;
    };
    for item in items {
        let TomlVal::Table(entries) = item else {
            continue;
        };
        let mut raw = RawRule::default();
        for (key, v) in entries {
            match (key.as_slice(), v) {
                ([k], TomlVal::Str(s)) if k == "path" => raw.path = Some(s),
                ([k], TomlVal::Str(s)) if k == "name" => raw.name = Some(s),
                ([k], TomlVal::Bool(b)) if k == "enabled" => raw.enabled = Some(b),
                _ => {}
            }
        }
        if let Some(rule) = raw.finish(home) {
            rules.push(rule);
        }
    }
}

pub(super) fn parse_skills_config_toml(input: &str, home: Option<&Path>) -> Vec<SkillConfigRule> {
    let tokens = tokenize_toml(input);
    let mut pos = 0;
    let mut current_table: Vec<String> = Vec::new();
    let mut active_rule: Option<RawRule> = None;
    let mut rules = Vec::new();

    while pos < tokens.len() {
        skip_newlines(&tokens, &mut pos);
        if pos >= tokens.len() {
            break;
        }
        if tokens[pos] == Token::LBracket {
            let is_array = tokens.get(pos + 1) == Some(&Token::LBracket);
            pos += if is_array { 2 } else { 1 };
            let header = parse_key_segments(&tokens, &mut pos);
            if is_array {
                if tokens.get(pos) == Some(&Token::RBracket) {
                    pos += 1;
                }
                if tokens.get(pos) == Some(&Token::RBracket) {
                    pos += 1;
                }
            } else if tokens.get(pos) == Some(&Token::RBracket) {
                pos += 1;
            }
            if let Some(segs) = header {
                let is_subtable_of_active = active_rule.is_some()
                    && segs.len() > 2
                    && segs[0] == "skills"
                    && segs[1] == "config";
                if !is_subtable_of_active
                    && let Some(prev) = active_rule.take()
                    && let Some(rule) = prev.finish(home)
                {
                    rules.push(rule);
                }
                if is_array && segs.as_slice() == ["skills", "config"] {
                    active_rule = Some(RawRule::default());
                }
                current_table = segs;
            }
            while pos < tokens.len() && tokens[pos] != Token::Newline {
                pos += 1;
            }
            continue;
        }

        let Some(key) = parse_key_segments(&tokens, &mut pos) else {
            while pos < tokens.len() && tokens[pos] != Token::Newline {
                pos += 1;
            }
            continue;
        };
        if tokens.get(pos) != Some(&Token::Equals) {
            while pos < tokens.len() && tokens[pos] != Token::Newline {
                pos += 1;
            }
            continue;
        }
        pos += 1;
        let val = parse_value(&tokens, &mut pos, 0);

        if current_table.as_slice() == ["skills", "config"] {
            if let Some(rule) = active_rule.as_mut() {
                match (key.as_slice(), val) {
                    ([k], TomlVal::Str(s)) if k == "path" => rule.path = Some(s),
                    ([k], TomlVal::Str(s)) if k == "name" => rule.name = Some(s),
                    ([k], TomlVal::Bool(b)) if k == "enabled" => rule.enabled = Some(b),
                    _ => {}
                }
            }
        } else if current_table.is_empty() {
            match (key.as_slice(), val) {
                ([a, b], array_val) if a == "skills" && b == "config" => {
                    extract_inline_rules(array_val, home, &mut rules);
                }
                ([a], TomlVal::Table(entries)) if a == "skills" => {
                    for (sub_k, sub_v) in entries {
                        if sub_k.as_slice() == ["config"] {
                            extract_inline_rules(sub_v, home, &mut rules);
                        }
                    }
                }
                _ => {}
            }
        } else if current_table.as_slice() == ["skills"] && key.as_slice() == ["config"] {
            extract_inline_rules(val, home, &mut rules);
        }

        while pos < tokens.len() && tokens[pos] != Token::Newline {
            pos += 1;
        }
    }

    if let Some(prev) = active_rule.take()
        && let Some(rule) = prev.finish(home)
    {
        rules.push(rule);
    }
    rules
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn write_skill(dir: &Path, name: &str, desc: &str) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let skill_md = dir.join("SKILL.md");
        std::fs::write(
            &skill_md,
            format!("---\nname: {name}\ndescription: {desc}\n---\nbody\n"),
        )
        .unwrap();
        skill_md
    }

    #[test]
    fn skips_disabled_project_copy_and_returns_enabled_user_copy_matching_codex_precedence() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let codex_home = home.join(".codex");
        let repo = temp.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();

        let proj_codex_md = write_skill(
            &repo.join(".codex/skills/dup-skill"),
            "dup-skill",
            "project codex copy",
        );
        write_skill(
            &codex_home.join("skills/dup-skill"),
            "dup-skill",
            "user codex copy",
        );

        let env = AgentEnvironment(BTreeMap::from([
            ("HOME".into(), home.to_string_lossy().into_owned()),
            (
                "CODEX_HOME".into(),
                codex_home.to_string_lossy().into_owned(),
            ),
        ]));

        // Before disabling, project copy takes precedence over user copy.
        let before = find(&repo, "dup-skill", &env).unwrap().unwrap();
        assert_eq!(before.description, "project codex copy");

        // Disabling the project copy via non-canonical or canonical path selects the user copy.
        std::fs::write(
            codex_home.join("config.toml"),
            format!(
                "# Disabled by Codex CLI\n[[skills.config]]\npath = \"{}\"\nenabled = false\n",
                proj_codex_md.display()
            ),
        )
        .unwrap();
        let after = find(&repo, "dup-skill", &env).unwrap().unwrap();
        assert_eq!(after.description, "user codex copy");
        assert_eq!(
            Path::new(&after.directory),
            codex_home.join("skills/dup-skill").canonicalize().unwrap()
        );

        // Project-local `.codex/config.toml` cannot disable user skills, matching Codex CLI.
        std::fs::write(
            repo.join(".codex/config.toml"),
            "[[skills.config]]\nname = \"dup-skill\"\nenabled = false\n",
        )
        .unwrap();
        let still_user = find(&repo, "dup-skill", &env).unwrap().unwrap();
        assert_eq!(still_user.description, "user codex copy");

        // Disabling all copies by name returns None; re-enabling user copy by path restores it.
        std::fs::write(
            codex_home.join("config.toml"),
            "[[skills.config]]\nname = \"dup-skill\"\nenabled = false\n",
        )
        .unwrap();
        assert!(find(&repo, "dup-skill", &env).unwrap().is_none());

        let user_md = codex_home
            .join("skills/dup-skill/SKILL.md")
            .canonicalize()
            .unwrap();
        std::fs::write(
            codex_home.join("config.toml"),
            format!(
                "[skills]\nconfig = [\n  {{ name = 'dup-skill', enabled = false }},\n  {{ path = '{}', enabled = true }},\n]\n",
                user_md.display()
            ),
        )
        .unwrap();
        let reenabled = find(&repo, "dup-skill", &env).unwrap().unwrap();
        assert_eq!(reenabled.description, "user codex copy");
    }

    #[test]
    fn sorts_same_scope_roots_by_canonical_path_like_codex_skills_list() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let repo = temp.path().join("repo");
        let sub = repo.join("packages/sub");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(&sub).unwrap();

        write_skill(
            &sub.join(".codex/skills/order-skill"),
            "order-skill",
            "sub .codex",
        );
        write_skill(
            &repo.join(".codex/skills/order-skill"),
            "order-skill",
            "repo .codex",
        );
        let proj_agents_md = write_skill(
            &repo.join(".agents/skills/order-skill"),
            "order-skill",
            "repo .agents",
        );
        write_skill(
            &home.join(".codex/skills/order-skill"),
            "order-skill",
            "home .codex",
        );
        write_skill(
            &home.join(".agents/skills/order-skill"),
            "order-skill",
            "home .agents",
        );

        let env = AgentEnvironment(BTreeMap::from([(
            "HOME".into(),
            home.to_string_lossy().into_owned(),
        )]));

        // `repo/.agents` < `repo/.codex` < `repo/packages/sub/.codex`
        assert_eq!(
            find(&sub, "order-skill", &env)
                .unwrap()
                .unwrap()
                .description,
            "repo .agents"
        );

        // Disable `repo/.agents` -> `repo/.codex` wins over `sub/.codex`.
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::write(
            home.join(".codex/config.toml"),
            format!(
                "[[skills.config]]\npath = \"{}\"\nenabled = false\n",
                proj_agents_md.display()
            ),
        )
        .unwrap();
        assert_eq!(
            find(&sub, "order-skill", &env)
                .unwrap()
                .unwrap()
                .description,
            "repo .codex"
        );
    }
}
