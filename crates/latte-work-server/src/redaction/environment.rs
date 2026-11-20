//! Effective child environment, with OS strings preserved until diagnostic decoding.
use super::Redactor;
use std::{collections::BTreeMap, ffi::OsString};

pub(crate) fn for_command(
    command: &tokio::process::Command,
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    additional: impl IntoIterator<Item = String>,
) -> Redactor {
    let mut values: BTreeMap<_, _> = inherited.into_iter().collect();
    for (name, value) in command.as_std().get_envs() {
        if let Some(value) = value {
            values.insert(name.to_owned(), value.to_owned());
        } else {
            values.remove(name);
        }
    }
    let secrets = values.into_iter().filter_map(|(name, value)| {
        let name = name.to_string_lossy().to_ascii_uppercase();
        let value = value.to_string_lossy();
        let sensitive = ["TOKEN", "KEY", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH"]
            .iter()
            .any(|part| name.contains(part))
            || (value.contains("://") && value.contains('@'));
        sensitive.then(|| value.into_owned())
    });
    Redactor::new(secrets.chain(additional))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::ffi::OsStringExt;

    #[test]
    fn effective_environment_applies_override_remove_and_private_credentials() {
        let inherited = [
            ("API_TOKEN".into(), "fixture-old-credential".into()),
            ("REMOVED_SECRET".into(), "fixture-removed-credential".into()),
            ("PUBLIC_LABEL".into(), "visible".into()),
            (
                "HTTPS_PROXY".into(),
                "https://user:password@proxy.test".into(),
            ),
        ];
        let mut command = tokio::process::Command::new("unused");
        command
            .env("API_TOKEN", "fixture-new-credential")
            .env_remove("REMOVED_SECRET");
        let redactor = for_command(&command, inherited, ["fixture-settings-credential".into()]);
        assert_eq!(redactor.text("fixture-new-credential https://user:password@proxy.test fixture-settings-credential"), "[redacted] [redacted] [redacted]");
        assert_eq!(
            redactor.text("fixture-old-credential fixture-removed-credential visible"),
            "fixture-old-credential fixture-removed-credential visible"
        );
    }

    #[test]
    fn non_unicode_environment_keys_and_values_are_lossily_redacted_without_panic() {
        let key = OsString::from_vec(b"AUTH_\xff_KEY".to_vec());
        let secret = OsString::from_vec(b"fixture-\xff-secret".to_vec());
        let command = tokio::process::Command::new("unused");
        let redactor = for_command(&command, [(key, secret.clone())], []);
        assert_eq!(
            redactor.text(&format!("before {} after", secret.to_string_lossy())),
            "before [redacted] after"
        );
    }

    #[test]
    fn non_unicode_keys_are_removed_before_lossy_conversion() {
        let key = OsString::from_vec(b"SECRET_\xff".to_vec());
        let value = OsString::from_vec(b"fixture-\xff-secret".to_vec());
        let mut command = tokio::process::Command::new("unused");
        command.env_remove(&key);
        let redactor = for_command(&command, [(key, value.clone())], []);
        assert_eq!(
            redactor.text(&value.to_string_lossy()),
            value.to_string_lossy()
        );
    }
}
