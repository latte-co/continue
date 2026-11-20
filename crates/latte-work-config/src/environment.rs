//! Validation shared by App persistence and the execution host.
use anyhow::{Result, bail};
use latte_work_protocol::{AgentEnvironment, PathSyntax};

/// Persistence is portable: the selected execution host applies its native policy.
pub fn validate_agent_environment(environment: &AgentEnvironment) -> Result<()> {
    validate_agent_environment_for(environment, PathSyntax::Posix)
}
pub fn validate_agent_environment_for(
    environment: &AgentEnvironment,
    syntax: PathSyntax,
) -> Result<()> {
    if environment.0.len() > 64 {
        bail!("环境变量最多 64 项");
    }
    let mut bytes = 0;
    let mut names = std::collections::BTreeSet::new();
    for (name, value) in &environment.0 {
        let mut chars = name.bytes();
        if name.len() > 255
            || !chars
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
            || !chars.all(|c| c.is_ascii_alphanumeric() || c == b'_')
        {
            bail!("环境变量名称必须以字母或下划线开头，且只能包含字母、数字和下划线");
        }
        let key = if syntax == PathSyntax::Windows {
            name.to_ascii_uppercase()
        } else {
            name.clone()
        };
        if !names.insert(key.clone()) {
            bail!("同一主机不能重复配置大小写相同的环境变量名称");
        }
        if matches!(
            key.as_str(),
            "HOME" | "USER" | "LOGNAME" | "SHELL" | "PWD" | "OLDPWD" | "SHLVL" | "_"
        ) || key.starts_with("LATTE_WORK_")
            || (syntax == PathSyntax::Windows
                && matches!(
                    key.as_str(),
                    "USERPROFILE" | "HOMEDRIVE" | "HOMEPATH" | "USERNAME"
                ))
        {
            bail!("不能覆盖主机身份、工作目录或 LATTE_WORK_ 环境变量");
        }
        if value.contains('\0') || value.len() > 8192 {
            bail!("环境变量值不能包含 NUL，且每项最多 8 KiB");
        }
        bytes += name.len() + value.len() + 2;
    }
    if bytes > 32 * 1024 {
        bail!("环境变量总大小最多 32 KiB");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    #[test]
    fn native_windows_keys_reject_reserved_and_case_duplicate_aliases() {
        for name in [
            "home",
            "Home",
            "latte_work_server",
            "Latte_Work_Codex",
            "UserProfile",
            "homedrive",
            "HomePath",
            "UserName",
        ] {
            let environment =
                AgentEnvironment(BTreeMap::from([(name.into(), "private-value".into())]));
            assert!(
                validate_agent_environment_for(&environment, PathSyntax::Windows).is_err(),
                "{name}"
            );
            assert!(
                validate_agent_environment(&environment).is_ok(),
                "Unix names remain case-sensitive: {name}"
            );
        }
        let aliases = AgentEnvironment(BTreeMap::from([
            ("PATH".into(), "one".into()),
            ("Path".into(), "two".into()),
        ]));
        assert!(validate_agent_environment_for(&aliases, PathSyntax::Windows).is_err());
        assert!(validate_agent_environment(&aliases).is_ok());
    }
}
