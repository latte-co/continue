//! Enumerate absolute CLI candidates; spawn, not mode bits, decides permission.
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};

/// Bind paths lexically. Metadata admission belongs to the async probe loop,
/// never to enumeration: even an unused later symlink can block a stat syscall.
pub(super) fn resolve<'a>(
    candidate: &'a OsStr,
    path: Option<&'a OsStr>,
    cwd: &'a Path,
) -> impl Iterator<Item = PathBuf> + 'a {
    let valid = !candidate.is_empty() && cwd.is_absolute();
    let candidate = Path::new(candidate);
    let explicit = candidate.is_absolute()
        || candidate
            .parent()
            .is_some_and(|parent| !parent.as_os_str().is_empty());
    let bound = (valid && explicit).then(|| cwd.join(candidate));
    let path = path.filter(|_| valid && !explicit);
    bound.into_iter().chain(
        path.into_iter()
            .flat_map(std::env::split_paths)
            // Empty and relative PATH entries have the same meaning as at spawn.
            .map(move |directory| cwd.join(directory).join(candidate)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        ffi::OsString,
        os::unix::{ffi::OsStringExt, fs::PermissionsExt},
    };

    fn resolve_with<'a>(
        candidate: &'a OsStr,
        path: Option<&'a OsStr>,
        cwd: &'a Path,
        is_file: impl Fn(&Path) -> bool + 'a,
    ) -> impl Iterator<Item = PathBuf> + 'a {
        super::resolve(candidate, path, cwd).filter(move |bound| is_file(bound))
    }

    // Preserve the existing filesystem-eligibility assertions while production
    // enumeration itself is now lexical and each check belongs to metadata.
    fn checked_paths(candidate: &OsStr, path: Option<&OsStr>, cwd: &Path) -> Vec<PathBuf> {
        resolve_with(candidate, path, cwd, |bound| {
            std::fs::metadata(bound).is_ok_and(|metadata| metadata.is_file())
        })
        .collect()
    }

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
            checked_paths(OsStr::new("cursor-agent"), Some(&path), cwd.path()),
            expected
        );
        install(&first.join("cursor-agent"), 0o010);
        assert_eq!(
            checked_paths(OsStr::new("cursor-agent"), Some(&path), cwd.path()),
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
            checked_paths(OsStr::new("agent"), Some(OsStr::new("bin")), cwd.path()),
            vec![cwd.path().join("bin/agent")]
        );
        assert_eq!(
            checked_paths(OsStr::new("agent"), Some(OsStr::new("")), cwd.path()),
            vec![cwd.path().join("agent")]
        );
        assert!(checked_paths(OsStr::new("agent"), None, cwd.path()).is_empty());
    }

    #[test]
    fn cursor_executable_explicit_paths_ignore_path_and_allow_normal_symlinks() {
        let cwd = tempfile::tempdir().unwrap();
        install(&cwd.path().join("cli"), 0o700);
        std::os::unix::fs::symlink("cli", cwd.path().join("linked")).unwrap();
        for candidate in ["./cli", "./linked"] {
            assert_eq!(
                checked_paths(OsStr::new(candidate), None, cwd.path()),
                vec![cwd.path().join(candidate)]
            );
        }
        let absolute = cwd.path().join("cli");
        assert_eq!(
            checked_paths(absolute.as_os_str(), None, cwd.path()),
            vec![absolute]
        );
        assert!(
            checked_paths(OsStr::new("./missing"), Some(OsStr::new("")), cwd.path()).is_empty()
        );
        assert!(checked_paths(OsStr::new("."), None, cwd.path()).is_empty());
        assert!(checked_paths(OsStr::new(""), None, cwd.path()).is_empty());
        assert!(
            checked_paths(
                OsStr::new("cli"),
                Some(OsStr::new("")),
                Path::new("relative")
            )
            .is_empty()
        );
    }

    #[test]
    fn cursor_executable_lexical_iterator_includes_missing_paths_without_file_filtering() {
        let cwd = tempfile::tempdir().unwrap();
        let path =
            std::env::join_paths([cwd.path().join("first"), cwd.path().join("second")]).unwrap();
        assert_eq!(
            super::resolve(OsStr::new("agent"), Some(&path), cwd.path()).collect::<Vec<_>>(),
            [
                cwd.path().join("first/agent"),
                cwd.path().join("second/agent")
            ]
        );
        assert_eq!(
            super::resolve(OsStr::new("./missing"), None, cwd.path()).collect::<Vec<_>>(),
            [cwd.path().join("./missing")]
        );
    }

    // Consume the production lexical iterator through an injected predicate.
    // A forbidden check panics without real I/O. Metadata's actual scheduling
    // and spawn-error classification are exercised separately through its seam.
    #[test]
    fn cursor_executable_does_not_check_later_path_before_first_candidate_is_consumed() {
        let cwd = Path::new("/discovery");
        let first = cwd.join("first/agent");
        let path = std::env::join_paths([cwd.join("first"), cwd.join("second")]).unwrap();
        let checked = std::cell::RefCell::new(Vec::new());
        let mut candidates = resolve_with(OsStr::new("agent"), Some(&path), cwd, |bound| {
            assert_eq!(
                bound, first,
                "lower-priority metadata check before first probe"
            );
            checked.borrow_mut().push(bound.to_owned());
            true
        });
        let selected = candidates.next();
        assert_eq!(selected, Some(first.clone()));
        drop(candidates);
        assert_eq!(*checked.borrow(), [first]);
    }

    #[test]
    fn cursor_executable_next_candidate_does_not_check_third_path() {
        let cwd = Path::new("/discovery");
        let first = cwd.join("first/agent");
        let second = cwd.join("second/agent");
        let third = cwd.join("third/agent");
        let path = std::env::join_paths([cwd.join("first"), cwd.join("second"), cwd.join("third")])
            .unwrap();
        let checked = std::cell::RefCell::new(Vec::new());
        let mut candidates = resolve_with(OsStr::new("agent"), Some(&path), cwd, |bound| {
            assert_ne!(
                bound, third,
                "third PATH metadata check before second probe"
            );
            checked.borrow_mut().push(bound.to_owned());
            true
        });
        assert_eq!(candidates.next(), Some(first.clone()));
        assert_eq!(checked.borrow().as_slice(), std::slice::from_ref(&first));
        // A consumer may request the next entry after an initial spawn EACCES.
        // Requesting it must not admit any subsequent filesystem check.
        assert_eq!(candidates.next(), Some(second.clone()));
        drop(candidates);
        assert_eq!(*checked.borrow(), [first, second]);
    }

    #[test]
    fn cursor_executable_unconsumed_candidates_do_not_admit_filesystem_checks() {
        let cwd = Path::new("/discovery");
        let path = std::env::join_paths([cwd.join("first"), cwd.join("second")]).unwrap();
        let candidates = resolve_with(OsStr::new("agent"), Some(&path), cwd, |_| {
            panic!("constructing an unconsumed lookup must not admit filesystem I/O")
        });
        // An expired discovery budget can stop without requesting a candidate.
        // This is a resolver contract, not a metadata deadline integration test.
        drop(candidates);
    }

    #[test]
    fn cursor_executable_preserves_unrepresentable_first_path_for_fail_closed_probe() {
        // macOS rejects invalid UTF-8 names. Model file existence without I/O;
        // discovery must see the unrepresentable first candidate, not skip it.
        let cwd = Path::new("/discovery");
        let invalid = cwd.join(OsString::from_vec(b"bin-\xff".to_vec()));
        let selected = invalid.join("agent");
        let path = std::env::join_paths([invalid.as_path(), cwd]).unwrap();
        let candidates: Vec<_> =
            resolve_with(OsStr::new("agent"), Some(&path), cwd, |_| true).collect();
        assert_eq!(candidates, vec![selected.clone(), cwd.join("agent")]);
        assert!(candidates[0].to_str().is_none());
        assert_eq!(
            resolve_with(selected.as_os_str(), None, cwd, |_| true).collect::<Vec<_>>(),
            vec![selected]
        );
    }
}
