//! Read-only Codex skill lookup matching Codex CLI's scope ordering and `[[skills.config]]` rules.
use anyhow::{Result, bail};
use latte_work_protocol::{AgentEnvironment, SkillInfo};
use std::{
    collections::{HashSet, VecDeque},
    io::Read,
    path::{Path, PathBuf},
};

const CONFIG_FILE_LIMIT: u64 = 256 * 1024;
const DIR_SCAN_CEILING: usize = 4096;
const DIR_ENTRY_LIMIT: usize = 512;
const WALK_DIR_LIMIT: usize = 2048;
const WALK_DEPTH_LIMIT: usize = 6;

#[derive(Debug, Clone)]
pub(super) struct SkillConfigRule {
    path: Option<PathBuf>,
    name: Option<String>,
    enabled: bool,
}

impl SkillConfigRule {
    fn matches(&self, skill_md: &Path, info_name: &str) -> bool {
        match (&self.path, &self.name) {
            (Some(rule_path), Some(rule_name)) => rule_path == skill_md && rule_name == info_name,
            (Some(rule_path), None) => rule_path == skill_md,
            (None, Some(rule_name)) => rule_name == info_name,
            (None, None) => false,
        }
    }
}

fn is_skill_enabled(rules: &[SkillConfigRule], skill_md: &Path, info_name: &str) -> bool {
    let mut enabled = true;
    for rule in rules {
        if rule.matches(skill_md, info_name) {
            enabled = rule.enabled;
        }
    }
    enabled
}

fn effective_command_name<'a>(info_name: &'a str, canonical_slug: &'a str) -> &'a str {
    if !info_name.is_empty()
        && info_name.len() <= 256
        && !info_name
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == '/')
    {
        info_name
    } else {
        canonical_slug
    }
}

fn inspect_candidate(
    dir_path: &Path,
    requested: &str,
    seen_skill_md: &mut HashSet<PathBuf>,
) -> Result<Option<Candidate>> {
    let canon_dir = match dir_path.canonicalize() {
        Ok(path) => path,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let Some(canon_slug) = canon_dir.file_name().and_then(|s| s.to_str()) else {
        return Ok(None);
    };
    let Some(info) = super::claude_skills::inspect(&canon_dir, canon_slug)? else {
        return Ok(None);
    };
    let command_name = effective_command_name(&info.name, canon_slug);
    if command_name != requested {
        return Ok(None);
    }
    let Ok(skill_md) = canon_dir.join("SKILL.md").canonicalize() else {
        return Ok(None);
    };
    if !seen_skill_md.insert(skill_md.clone()) {
        return Ok(None);
    }
    Ok(Some(Candidate {
        skill_md,
        command_name: command_name.to_owned(),
        info,
    }))
}

#[derive(Debug)]
struct Candidate {
    skill_md: PathBuf,
    command_name: String,
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
        if let Some(info) = find_enabled_in_roots(scope_roots, name, &rules)? {
            return Ok(Some(info));
        }
    }
    Ok(None)
}

pub(super) fn find_enabled_in_roots(
    scope_roots: &[(PathBuf, bool)],
    name: &str,
    rules: &[SkillConfigRule],
) -> Result<Option<SkillInfo>> {
    let mut candidates = collect_scope_candidates(scope_roots, name)?;
    candidates.sort_by(|a, b| a.skill_md.cmp(&b.skill_md));
    for candidate in candidates {
        if is_skill_enabled(rules, &candidate.skill_md, &candidate.command_name) {
            return Ok(Some(candidate.info));
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
            && let Some(candidate) =
                inspect_candidate(&root.join(requested), requested, &mut seen_skill_md)?
        {
            out.push(candidate);
        }

        let mut visited_dirs = HashSet::new();
        if let Ok(canon_root) = root.canonicalize() {
            visited_dirs.insert(canon_root);
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
                .take(DIR_SCAN_CEILING)
                .filter_map(Result::ok)
                .collect();
            entries.sort_by_key(std::fs::DirEntry::file_name);
            entries.truncate(DIR_ENTRY_LIMIT);
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
                if let Ok(Some(candidate)) =
                    inspect_candidate(&entry_path, requested, &mut seen_skill_md)
                {
                    out.push(candidate);
                }
                if depth + 1 < WALK_DEPTH_LIMIT
                    && std::fs::metadata(&entry_path).is_ok_and(|meta| meta.is_dir())
                    && let Ok(canon_dir) = entry_path.canonicalize()
                    && visited_dirs.insert(canon_dir)
                {
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

    #[test]
    fn discovers_multi_level_symlinked_and_nested_codex_skills_before_user_fallback() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let codex_home = home.join(".codex");
        let repo = temp.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();

        // Depth 4, 5, and 6 (up to Codex CLI's `MAX_SCAN_DEPTH = 6`) in project `.codex/skills`
        // must beat top-level user copies in `$CODEX_HOME/skills`.
        for (rel, name, desc) in [
            ("a/b/c/deep3", "deep3", "repo-depth3"),
            ("a/b/c/d/deep4", "deep4", "repo-depth4"),
            ("a/b/c/d/e/deep5", "deep5", "repo-depth5"),
            ("a/b/c/d/e/f/deep6", "deep6", "repo-depth6"),
        ] {
            write_skill(&repo.join(".codex/skills").join(rel), name, desc);
            write_skill(
                &codex_home.join("skills").join(name),
                name,
                &format!("user-{name}"),
            );
        }

        // Symlinked category directory + self-cycle protection inside `.codex/skills`.
        let shared_skill = repo.join("shared-catalog/cat/sym-skill");
        write_skill(&shared_skill, "sym-skill", "repo-sym");
        write_skill(
            &codex_home.join("skills/sym-skill"),
            "sym-skill",
            "user-sym",
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                repo.join("shared-catalog/cat"),
                repo.join(".codex/skills/linked-cat"),
            )
            .unwrap();
            std::os::unix::fs::symlink(
                repo.join(".codex/skills"),
                repo.join("shared-catalog/cat/loop-back"),
            )
            .unwrap();
        }

        // Child skill nested beneath a directory that already has its own `SKILL.md`.
        write_skill(
            &repo.join(".codex/skills/parent-skill"),
            "parent-skill",
            "repo-parent",
        );
        write_skill(
            &repo.join(".codex/skills/parent-skill/sub/nested-child"),
            "nested-child",
            "repo-nested-child",
        );
        write_skill(
            &codex_home.join("skills/nested-child"),
            "nested-child",
            "user-nested-child",
        );

        let env = AgentEnvironment(BTreeMap::from([
            ("HOME".into(), home.to_string_lossy().into_owned()),
            (
                "CODEX_HOME".into(),
                codex_home.to_string_lossy().into_owned(),
            ),
        ]));

        assert_eq!(
            find(&repo, "deep3", &env).unwrap().unwrap().description,
            "repo-depth3"
        );
        assert_eq!(
            find(&repo, "deep4", &env).unwrap().unwrap().description,
            "repo-depth4"
        );
        assert_eq!(
            find(&repo, "deep5", &env).unwrap().unwrap().description,
            "repo-depth5"
        );
        // Beyond depth 6 (7 components), Codex CLI skips the repo entry and falls back to user.
        assert_eq!(
            find(&repo, "deep6", &env).unwrap().unwrap().description,
            "user-deep6"
        );
        #[cfg(unix)]
        assert_eq!(
            find(&repo, "sym-skill", &env).unwrap().unwrap().description,
            "repo-sym"
        );
        assert_eq!(
            find(&repo, "nested-child", &env)
                .unwrap()
                .unwrap()
                .description,
            "repo-nested-child"
        );
    }

    #[test]
    fn does_not_treat_directory_alias_as_command_name_when_frontmatter_differs() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let codex_home = home.join(".codex");
        let repo = temp.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();

        write_skill(
            &repo.join(".codex/skills/cat/target-skill"),
            "different-skill",
            "repo-different-skill",
        );
        write_skill(
            &repo.join(".codex/skills/top-alias"),
            "another-skill",
            "repo-another-skill",
        );
        let nameless_dir = repo.join(".codex/skills/cat/no-frontmatter-name");
        std::fs::create_dir_all(&nameless_dir).unwrap();
        std::fs::write(
            nameless_dir.join("SKILL.md"),
            "---\ndescription: repo-folder-fallback\n---\nbody\n",
        )
        .unwrap();

        write_skill(
            &codex_home.join("skills/target-skill"),
            "target-skill",
            "user-actual-target",
        );
        write_skill(
            &codex_home.join("skills/top-alias"),
            "top-alias",
            "user-actual-top",
        );

        #[cfg(unix)]
        {
            let ext_named = repo.join("external-skills/real-named");
            write_skill(&ext_named, "real-named", "repo-real-named");
            std::os::unix::fs::symlink(&ext_named, repo.join(".codex/skills/symlink-alias-named"))
                .unwrap();
            write_skill(
                &codex_home.join("skills/symlink-alias-named"),
                "symlink-alias-named",
                "user-symlink-alias-named",
            );

            let ext_nameless = repo.join("external-skills/real-nameless");
            std::fs::create_dir_all(&ext_nameless).unwrap();
            std::fs::write(
                ext_nameless.join("SKILL.md"),
                "---\ndescription: repo-real-nameless\n---\nbody\n",
            )
            .unwrap();
            std::os::unix::fs::symlink(
                &ext_nameless,
                repo.join(".codex/skills/symlink-alias-nameless"),
            )
            .unwrap();
            write_skill(
                &codex_home.join("skills/symlink-alias-nameless"),
                "symlink-alias-nameless",
                "user-symlink-alias-nameless",
            );
        }

        let env = AgentEnvironment(BTreeMap::from([
            ("HOME".into(), home.to_string_lossy().into_owned()),
            (
                "CODEX_HOME".into(),
                codex_home.to_string_lossy().into_owned(),
            ),
        ]));

        // Requesting `target-skill` or `top-alias` must NOT open the unrelated repo skills
        // whose directories happen to share those names.
        assert_eq!(
            find(&repo, "target-skill", &env)
                .unwrap()
                .unwrap()
                .description,
            "user-actual-target"
        );
        assert_eq!(
            find(&repo, "top-alias", &env).unwrap().unwrap().description,
            "user-actual-top"
        );
        // Requesting the actual frontmatter `name` resolves the repo skill, and skills
        // without frontmatter `name:` still fall back to their directory name.
        assert_eq!(
            find(&repo, "different-skill", &env)
                .unwrap()
                .unwrap()
                .description,
            "repo-different-skill"
        );
        assert_eq!(
            find(&repo, "no-frontmatter-name", &env)
                .unwrap()
                .unwrap()
                .description,
            "repo-folder-fallback"
        );
        #[cfg(unix)]
        {
            assert_eq!(
                find(&repo, "symlink-alias-named", &env)
                    .unwrap()
                    .unwrap()
                    .description,
                "user-symlink-alias-named"
            );
            assert_eq!(
                find(&repo, "symlink-alias-nameless", &env)
                    .unwrap()
                    .unwrap()
                    .description,
                "user-symlink-alias-nameless"
            );
            assert_eq!(
                find(&repo, "real-named", &env)
                    .unwrap()
                    .unwrap()
                    .description,
                "repo-real-named"
            );
            assert_eq!(
                find(&repo, "real-nameless", &env)
                    .unwrap()
                    .unwrap()
                    .description,
                "repo-real-nameless"
            );
        }

        // `[[skills.config]] name = "target-skill"` disables `target-skill`, not `different-skill`.
        std::fs::write(
            codex_home.join("config.toml"),
            "[[skills.config]]\nname = \"target-skill\"\nenabled = false\n",
        )
        .unwrap();
        assert!(find(&repo, "target-skill", &env).unwrap().is_none());
        assert_eq!(
            find(&repo, "different-skill", &env)
                .unwrap()
                .unwrap()
                .description,
            "repo-different-skill"
        );
    }
}
