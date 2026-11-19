//! Bind a CLI once against the discovery cwd and Host-effective PATH.
use std::{ffi::OsStr, os::unix::fs::PermissionsExt, path::Path};

fn executable(path: &Path) -> bool {
    std::fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

pub(super) fn resolve(candidate: &OsStr, path: Option<&OsStr>, cwd: &Path) -> Option<String> {
    resolve_with(candidate, path, cwd, executable)
}

fn resolve_with(
    candidate: &OsStr,
    path: Option<&OsStr>,
    cwd: &Path,
    is_executable: impl Fn(&Path) -> bool,
) -> Option<String> {
    if candidate.is_empty() || !cwd.is_absolute() {
        return None;
    }
    let candidate = Path::new(candidate);
    if candidate.is_absolute()
        || candidate
            .parent()
            .is_some_and(|parent| !parent.as_os_str().is_empty())
    {
        let bound = cwd.join(candidate);
        return is_executable(&bound)
            .then(|| bound.to_str().map(str::to_owned))
            .flatten();
    }
    for directory in std::env::split_paths(path?) {
        // Empty and relative PATH entries have the same meaning as at spawn.
        let bound = cwd.join(directory).join(candidate);
        if is_executable(&bound) {
            // Do not reselect a later CLI if the first executable cannot be
            // represented by the UTF-8 launch contract. Normal symlinks are OK.
            return bound.to_str().map(str::to_owned);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};

    fn install(path: &Path, mode: u32) {
        std::fs::write(path, "fixture").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[test]
    fn cursor_executable_resolves_path_once_in_priority_order() {
        let cwd = tempfile::tempdir().unwrap();
        let first = cwd.path().join("first");
        let second = cwd.path().join("second");
        std::fs::create_dir(&first).unwrap();
        std::fs::create_dir(&second).unwrap();
        install(&first.join("cursor-agent"), 0o600);
        install(&second.join("cursor-agent"), 0o700);
        let path = std::env::join_paths([&first, &second]).unwrap();
        assert_eq!(
            resolve(OsStr::new("cursor-agent"), Some(&path), cwd.path()),
            Some(second.join("cursor-agent").to_str().unwrap().into())
        );
        install(&first.join("cursor-agent"), 0o700);
        assert_eq!(
            resolve(OsStr::new("cursor-agent"), Some(&path), cwd.path()),
            Some(first.join("cursor-agent").to_str().unwrap().into())
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
            Some(cwd.path().join("bin/agent").to_str().unwrap().into())
        );
        assert_eq!(
            resolve(OsStr::new("agent"), Some(OsStr::new("")), cwd.path()),
            Some(cwd.path().join("agent").to_str().unwrap().into())
        );
        assert!(resolve(OsStr::new("agent"), None, cwd.path()).is_none());
    }

    #[test]
    fn cursor_executable_explicit_paths_ignore_path_and_allow_normal_symlinks() {
        let cwd = tempfile::tempdir().unwrap();
        install(&cwd.path().join("cli"), 0o700);
        std::os::unix::fs::symlink("cli", cwd.path().join("linked")).unwrap();
        for candidate in ["./cli", "./linked"] {
            assert_eq!(
                resolve(OsStr::new(candidate), None, cwd.path()),
                Some(cwd.path().join(candidate).to_str().unwrap().into())
            );
        }
        let absolute = cwd.path().join("cli");
        assert_eq!(
            resolve(absolute.as_os_str(), None, cwd.path()),
            Some(absolute.to_str().unwrap().into())
        );
        assert!(resolve(OsStr::new("./missing"), Some(OsStr::new("")), cwd.path()).is_none());
        assert!(resolve(OsStr::new("."), None, cwd.path()).is_none());
        assert!(resolve(OsStr::new(""), None, cwd.path()).is_none());
        assert!(
            resolve(
                OsStr::new("cli"),
                Some(OsStr::new("")),
                Path::new("relative")
            )
            .is_none()
        );
    }

    #[test]
    fn cursor_executable_fails_closed_for_unrepresentable_selected_path() {
        // macOS filesystems reject invalid UTF-8 names before resolution. Model
        // executable existence without filesystem I/O to test the launch boundary.
        let cwd = Path::new("/discovery");
        let invalid = cwd.join(OsString::from_vec(b"bin-\xff".to_vec()));
        let selected = invalid.join("agent");
        let path = std::env::join_paths([invalid.as_path(), cwd]).unwrap();
        let is_executable = |bound: &Path| {
            assert_eq!(
                bound,
                selected.as_path(),
                "must not inspect the later UTF-8 executable"
            );
            true
        };
        assert!(resolve_with(OsStr::new("agent"), Some(&path), cwd, is_executable).is_none());
        assert!(resolve_with(selected.as_os_str(), None, cwd, is_executable).is_none());
    }
}
