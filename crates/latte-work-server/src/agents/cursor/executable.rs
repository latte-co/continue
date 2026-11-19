//! Enumerate absolute CLI candidates; spawn, not mode bits, decides permission.
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

pub(super) fn resolve(candidate: &OsStr, path: Option<&OsStr>, cwd: &Path) -> Vec<PathBuf> {
    resolve_with(candidate, path, cwd, |bound| {
        std::fs::metadata(bound).is_ok_and(|metadata| metadata.is_file())
    })
}

fn resolve_with(
    candidate: &OsStr,
    path: Option<&OsStr>,
    cwd: &Path,
    is_file: impl Fn(&Path) -> bool,
) -> Vec<PathBuf> {
    if candidate.is_empty() || !cwd.is_absolute() {
        return Vec::new();
    }
    let candidate = Path::new(candidate);
    if candidate.is_absolute()
        || candidate
            .parent()
            .is_some_and(|parent| !parent.as_os_str().is_empty())
    {
        let bound = cwd.join(candidate);
        return if is_file(&bound) {
            vec![bound]
        } else {
            Vec::new()
        };
    }
    path.map(|path| {
        std::env::split_paths(path)
            // Empty and relative PATH entries have the same meaning as at spawn.
            .map(|directory| cwd.join(directory).join(candidate))
            .filter(|bound| is_file(bound))
            .collect()
    })
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        ffi::OsString,
        os::unix::{ffi::OsStringExt, fs::PermissionsExt},
    };

    fn install(path: &Path, mode: u32) {
        std::fs::write(path, "fixture").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[test]
    fn cursor_executable_enumerates_path_in_priority_order_without_mode_authorization() {
        let cwd = tempfile::tempdir().unwrap();
        let first = cwd.path().join("first");
        let second = cwd.path().join("second");
        std::fs::create_dir(&first).unwrap();
        std::fs::create_dir(&second).unwrap();
        install(&first.join("cursor-agent"), 0o600);
        install(&second.join("cursor-agent"), 0o700);
        let path = std::env::join_paths([&first, &second]).unwrap();
        let expected = vec![first.join("cursor-agent"), second.join("cursor-agent")];
        assert_eq!(
            resolve(OsStr::new("cursor-agent"), Some(&path), cwd.path()),
            expected
        );
        install(&first.join("cursor-agent"), 0o010);
        assert_eq!(
            resolve(OsStr::new("cursor-agent"), Some(&path), cwd.path()),
            expected
        );
    }

    #[test]
    fn cursor_executable_binds_relative_and_empty_path_to_discovery_cwd() {
        let cwd = tempfile::tempdir().unwrap();
        std::fs::create_dir(cwd.path().join("bin")).unwrap();
        install(&cwd.path().join("bin/agent"), 0o700);
        install(&cwd.path().join("agent"), 0o700);
        assert_eq!(
            resolve(OsStr::new("agent"), Some(OsStr::new("bin")), cwd.path()),
            vec![cwd.path().join("bin/agent")]
        );
        assert_eq!(
            resolve(OsStr::new("agent"), Some(OsStr::new("")), cwd.path()),
            vec![cwd.path().join("agent")]
        );
        assert!(resolve(OsStr::new("agent"), None, cwd.path()).is_empty());
    }

    #[test]
    fn cursor_executable_explicit_paths_ignore_path_and_allow_normal_symlinks() {
        let cwd = tempfile::tempdir().unwrap();
        install(&cwd.path().join("cli"), 0o700);
        std::os::unix::fs::symlink("cli", cwd.path().join("linked")).unwrap();
        for candidate in ["./cli", "./linked"] {
            assert_eq!(
                resolve(OsStr::new(candidate), None, cwd.path()),
                vec![cwd.path().join(candidate)]
            );
        }
        let absolute = cwd.path().join("cli");
        assert_eq!(
            resolve(absolute.as_os_str(), None, cwd.path()),
            vec![absolute]
        );
        assert!(resolve(OsStr::new("./missing"), Some(OsStr::new("")), cwd.path()).is_empty());
        assert!(resolve(OsStr::new("."), None, cwd.path()).is_empty());
        assert!(resolve(OsStr::new(""), None, cwd.path()).is_empty());
        assert!(
            resolve(
                OsStr::new("cli"),
                Some(OsStr::new("")),
                Path::new("relative")
            )
            .is_empty()
        );
    }

    #[test]
    fn cursor_executable_preserves_unrepresentable_first_path_for_fail_closed_probe() {
        // macOS rejects invalid UTF-8 names. Model file existence without I/O;
        // discovery must see the unrepresentable first candidate, not skip it.
        let cwd = Path::new("/discovery");
        let invalid = cwd.join(OsString::from_vec(b"bin-\xff".to_vec()));
        let selected = invalid.join("agent");
        let path = std::env::join_paths([invalid.as_path(), cwd]).unwrap();
        let candidates = resolve_with(OsStr::new("agent"), Some(&path), cwd, |_| true);
        assert_eq!(candidates, vec![selected.clone(), cwd.join("agent")]);
        assert!(candidates[0].to_str().is_none());
        assert_eq!(
            resolve_with(selected.as_os_str(), None, cwd, |_| true),
            vec![selected]
        );
    }
}
