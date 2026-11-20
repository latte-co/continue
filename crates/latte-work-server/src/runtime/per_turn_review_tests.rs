use super::*;

fn cursor_context() -> (tempfile::TempDir, Database, Session, LaunchConfig) {
    let (dir, database, _, _) = context();
    let session = db(&database, |s| {
        let project = s.add_project(dir.path())?;
        s.create_session(project.id, "cursor".into())
    })
    .unwrap();
    let config = crate::providers::ProviderStore::open(dir.path())
        .unwrap()
        .turn_config("cursor", None, None)
        .unwrap();
    (dir, database, session, config)
}
fn cursor_turn(request_id: &str, text: String, config: &LaunchConfig) -> SendTurn {
    SendTurn {
        request_id: request_id.into(),
        text,
        model: None,
        fingerprint: None,
        config: config.clone(),
    }
}
#[tokio::test]
async fn cursor_invalid_prompt_is_rejected_before_direct_or_queue_admission() {
    for text in [
        "x".repeat(128 * 1024),
        "界".repeat(43_691),
        "hello\0world".into(),
    ] {
        for busy in [false, true] {
            let (dir, database, session, config) = cursor_context();
            let mut process = Some(prepared(
                &dir,
                &database,
                &session,
                config.clone(),
                "exit 0",
            ));
            if busy {
                db(&database, |s| s.state(&session.id, Status::Running, None)).unwrap();
            }
            let result = receive_turn(
                &mut process,
                &database,
                "/must-not-spawn",
                &session,
                dir.path().to_str().unwrap(),
                cursor_turn("invalid", text.clone(), &config),
                &Arc::new(AtomicBool::new(false)),
                busy,
                false,
                &mut HashMap::new(),
                &Guard::reserve(&database, "invalid").unwrap(),
                || panic!("invalid prompt must not be admitted"),
            )
            .await;
            assert!(
                result.is_err(),
                "invalid Cursor argv was admitted (busy={busy})"
            );
            assert!(!db(&database, |s| s.has_admitted_request(&session.id)).unwrap());
            assert!(db(&database, |s| s.queued(&session.id)).unwrap().is_empty());
            assert!(process.as_ref().unwrap().transport.is_none());
        }
    }
}
#[tokio::test]
async fn cursor_real_enoent_allows_independent_retry_after_store_restart_and_deduplicates() {
    let (dir, database, session, config) = cursor_context();
    let missing = dir.path().join("missing-cursor-agent");
    let mut process = None;
    assert!(
        accept_turn(
            &mut process,
            &database,
            missing.to_str().unwrap(),
            &session,
            dir.path().to_str().unwrap(),
            cursor_turn("first", "hello".into(), &config),
            &Arc::new(AtomicBool::new(false)),
            None,
            || {},
        )
        .await
        .unwrap()
    );
    assert!(process.is_none());
    assert_eq!(
        db(&database, |s| s.session(&session.id)).unwrap().status,
        Status::Failed
    );
    drop(database);
    let database = Arc::new(Mutex::new(
        Store::open(&dir.path().join("state.sqlite")).unwrap(),
    ));
    let session = db(&database, |s| s.session(&session.id)).unwrap();
    process = Some(prepared(
        &dir,
        &database,
        &session,
        config.clone(),
        "printf 'init\nresult\n'",
    ));
    assert!(
        !accept_turn(
            &mut process,
            &database,
            missing.to_str().unwrap(),
            &session,
            dir.path().to_str().unwrap(),
            cursor_turn("first", "hello".into(), &config),
            &Arc::new(AtomicBool::new(false)),
            None,
            || panic!("old ID must not replay"),
        )
        .await
        .unwrap()
    );
    assert!(
        accept_turn(
            &mut process,
            &database,
            missing.to_str().unwrap(),
            &session,
            dir.path().to_str().unwrap(),
            cursor_turn("retry", "short retry".into(), &config),
            &Arc::new(AtomicBool::new(false)),
            None,
            || {},
        )
        .await
        .expect("precise spawn ENOENT must permit a new request after restart")
    );
    let p = process.as_mut().unwrap();
    read_apply(p, &database, &session).await;
    read_apply(p, &database, &session).await;
    assert!(p.next_message().await.unwrap().is_none());
    p.finish_per_turn(&database, &session.id).await.unwrap();
    assert_eq!(
        db(&database, |s| s.session(&session.id)).unwrap().status,
        Status::Completed
    );
    assert_eq!(
        db(&database, |s| s.events(&session.id, 0.0))
            .unwrap()
            .0
            .iter()
            .filter(|e| matches!(e.event, EventKind::User { .. }))
            .count(),
        2
    );
}
#[tokio::test]
async fn per_turn_missing_result_keeps_exit_and_redacted_stderr_diagnostic() {
    let (dir, database, session, mut config) = context();
    config.environment.0.insert(
        "CURSOR_FIXTURE_SECRET".into(),
        "synthetic-stderr-secret".into(),
    );
    let mut p = prepared(
        &dir,
        &database,
        &session,
        config,
        "printf 'init\n'; printf 'native failure %s' \"$CURSOR_FIXTURE_SECRET\" >&2; exit 7",
    );
    start(&mut p, &database, &session).await;
    read_apply(&mut p, &database, &session).await;
    assert!(p.next_message().await.unwrap().is_none());
    let error = p
        .finish_per_turn(&database, &session.id)
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("result"), "{error}");
    assert!(error.contains("7"), "{error}");
    assert!(error.contains("native failure [redacted]"), "{error}");
    assert!(!error.contains("synthetic-stderr-secret"), "{error}");
    assert_ne!(
        db(&database, |s| s.session(&session.id)).unwrap().status,
        Status::Completed
    );
    p.close_confirmed(&database, &session.id).await.unwrap();
}
#[tokio::test]
async fn cursor_legacy_boundary_prompt_reconciles_admitted_and_queued_ids_before_validation() {
    for queued in [false, true] {
        let (dir, database, session, config) = cursor_context();
        let turn = cursor_turn("legacy-boundary", "x".repeat(128 * 1024), &config);
        db(&database, |s| {
            if queued {
                s.enqueue(&session.id, &turn)?;
            } else {
                s.begin(
                    &session.id,
                    &turn.request_id,
                    &turn.text,
                    None,
                    None,
                    None,
                    None,
                )?;
                s.state(&session.id, Status::Failed, None)?;
            }
            Ok(())
        })
        .unwrap();
        let mut process = None;
        let response = receive_turn(
            &mut process,
            &database,
            "/must-not-spawn",
            &session,
            dir.path().to_str().unwrap(),
            turn,
            &Arc::new(AtomicBool::new(false)),
            queued,
            false,
            &mut HashMap::new(),
            &Guard::reserve(&database, "legacy-boundary").unwrap(),
            || panic!("legacy request cannot replay"),
        )
        .await
        .unwrap();
        assert!(matches!(
            response,
            Response::Accepted { duplicate: true } | Response::MessageQueued { duplicate: true }
        ));
        assert!(process.is_none());
    }
}
#[tokio::test]
async fn cursor_send_queued_retries_only_fresh_request_and_preserves_paused_backlog() {
    let (dir, database, session, config) = cursor_context();
    let missing = dir.path().join("missing-cursor-agent");
    let mut process = None;
    let mut configs = HashMap::new();
    let response = receive_turn(
        &mut process,
        &database,
        missing.to_str().unwrap(),
        &session,
        dir.path().to_str().unwrap(),
        cursor_turn("failed-spawn", "hello".into(), &config),
        &Arc::new(AtomicBool::new(false)),
        true,
        false,
        &mut configs,
        &Guard::reserve(&database, "failed-spawn").unwrap(),
        || {},
    )
    .await
    .unwrap();
    assert!(matches!(response, Response::Accepted { duplicate: false }));
    assert_eq!(
        db(&database, |s| s.session(&session.id)).unwrap().status,
        Status::Failed
    );
    db(&database, |s| {
        s.pause_queue(&session.id, Some("failed turn"))
    })
    .unwrap();
    process = Some(prepared(
        &dir,
        &database,
        &session,
        config.clone(),
        "printf 'init\nresult\n'",
    ));
    let response = receive_turn(
        &mut process,
        &database,
        missing.to_str().unwrap(),
        &session,
        dir.path().to_str().unwrap(),
        cursor_turn("fresh", "retry".into(), &config),
        &Arc::new(AtomicBool::new(false)),
        true,
        false,
        &mut configs,
        &Guard::reserve(&database, "fresh").unwrap(),
        || {},
    )
    .await
    .unwrap();
    assert!(matches!(response, Response::Accepted { duplicate: false }));
    let p = process.as_mut().unwrap();
    read_apply(p, &database, &session).await;
    read_apply(p, &database, &session).await;
    assert!(p.next_message().await.unwrap().is_none());
    p.finish_per_turn(&database, &session.id).await.unwrap();
    db(&database, |s| {
        s.enqueue(&session.id, &cursor_turn("backlog", "held".into(), &config))?;
        s.pause_queue(&session.id, Some("explicitly paused"))
    })
    .unwrap();
    let response = receive_turn(
        &mut process,
        &database,
        missing.to_str().unwrap(),
        &session,
        dir.path().to_str().unwrap(),
        cursor_turn("later", "new message".into(), &config),
        &Arc::new(AtomicBool::new(false)),
        true,
        false,
        &mut configs,
        &Guard::reserve(&database, "later").unwrap(),
        || panic!("paused backlog must not execute"),
    )
    .await
    .unwrap();
    assert!(matches!(
        response,
        Response::MessageQueued { duplicate: false }
    ));
    assert!(db(&database, |s| s.queue_state(&session.id)).unwrap().0);
    assert_eq!(db(&database, |s| s.queued(&session.id)).unwrap().len(), 2);
    assert!(process.as_ref().unwrap().transport.is_none());
}
#[tokio::test]
async fn cursor_spawn_evidence_failure_keeps_new_requests_fenced() {
    let (dir, database, session, config) = cursor_context();
    db(&database, |s| {
        s.db.execute_batch("CREATE TRIGGER reject_spawn_evidence BEFORE UPDATE OF confirmed_not_started ON requests
            BEGIN SELECT RAISE(ABORT,'synthetic evidence write failure'); END;")?;
        Ok(())
    }).unwrap();
    let missing = dir.path().join("missing-cursor-agent");
    let mut process = None;
    assert!(
        accept_turn(
            &mut process,
            &database,
            missing.to_str().unwrap(),
            &session,
            dir.path().to_str().unwrap(),
            cursor_turn("first", "hello".into(), &config),
            &Arc::new(AtomicBool::new(false)),
            None,
            || {},
        )
        .await
        .unwrap()
    );
    assert!(db(&database, |s| s.has_possibly_started_request(&session.id)).unwrap());
    let error = accept_turn(
        &mut process,
        &database,
        missing.to_str().unwrap(),
        &session,
        dir.path().to_str().unwrap(),
        cursor_turn("retry", "hello".into(), &config),
        &Arc::new(AtomicBool::new(false)),
        None,
        || panic!("missing evidence must fail closed"),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("continuation"));
}
#[tokio::test]
async fn cursor_spawn_evidence_is_bound_to_active_request_not_latest_ledger_row() {
    let (dir, database, session, config) = cursor_context();
    let missing = dir.path().join("missing-cursor-agent");
    let mut process = None;
    assert!(accept_turn(
        &mut process, &database, missing.to_str().unwrap(), &session,
        dir.path().to_str().unwrap(), cursor_turn("active", "hello".into(), &config),
        &Arc::new(AtomicBool::new(false)), None, || {
            db(&database, |s| {
                s.db.execute("INSERT INTO requests(id,session_id,text) VALUES ('newer-row',?1,'unrelated')", [&session.id])?;
                Ok(())
            }).unwrap();
        },
    ).await.unwrap());
    db(&database, |s| {
        let evidence: Option<String> = s.db.query_row(
            "SELECT confirmed_not_started FROM requests WHERE id='active'",
            [],
            |r| r.get(0),
        )?;
        let unrelated: Option<String> = s.db.query_row(
            "SELECT confirmed_not_started FROM requests WHERE id='newer-row'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(evidence.as_deref(), Some("enoent"));
        assert!(unrelated.is_none());
        assert!(s.has_possibly_started_request(&session.id)?);
        Ok(())
    })
    .unwrap();
}
#[tokio::test]
async fn cursor_admitted_spawn_failure_and_not_admitted_are_distinct_durable_facts() {
    let (dir, database, session, config) = cursor_context();
    let missing = dir.path().join("missing-cursor-agent");
    let admission = Guard::reserve(&database, "spawn-failed").unwrap();
    let mut process = None;
    let mut admitted = false;
    let result = accept_turn(
        &mut process,
        &database,
        missing.to_str().unwrap(),
        &session,
        dir.path().to_str().unwrap(),
        cursor_turn("spawn-failed", "hello".into(), &config),
        &Arc::new(AtomicBool::new(false)),
        Some(&admission),
        || admitted = true,
    )
    .await;
    assert!(matches!(result, Ok(true)) && admitted);
    assert!(
        !reject_send(&admission, "spawn-failed", "spawn failed".into()).is::<SendNotAdmitted>()
    );
    let events = db(&database, |store| store.events(&session.id, 0.0))
        .unwrap()
        .0;
    let user = events.iter().find(|event| matches!(&event.event, EventKind::User { request_id, .. } if request_id == "spawn-failed")).unwrap();
    assert!(user.seq > 0.0);
    db(&database, |store| {
        let evidence: Option<String> = store.db.query_row(
            "SELECT confirmed_not_started FROM requests WHERE id='spawn-failed'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(evidence.as_deref(), Some("enoent"));
        assert!(!store.request_identity_absent("spawn-failed")?);
        assert!(!store.has_possibly_started_request(&session.id)?);
        Ok(())
    })
    .unwrap();
    assert!(
        db(&database, |store| store.begin_with_source(
            &session.id,
            "spawn-failed",
            "hello",
            None,
            None,
            None,
            None
        ))
        .unwrap()
        .is_none()
    );
    assert_eq!(
        db(&database, |store| store.events(&session.id, 0.0))
            .unwrap()
            .0
            .len(),
        events.len()
    );
    let rejected = Guard::reserve(&database, "invalid-fresh").unwrap();
    let error = accept_turn(
        &mut process,
        &database,
        missing.to_str().unwrap(),
        &session,
        dir.path().to_str().unwrap(),
        cursor_turn("invalid-fresh", "hello\0world".into(), &config),
        &Arc::new(AtomicBool::new(false)),
        Some(&rejected),
        || panic!("invalid fresh input must not reach begin_with_source"),
    )
    .await
    .unwrap_err();
    assert!(error.is::<SendNotAdmitted>());
    assert!(
        db(&database, |store| store
            .request_identity_absent("invalid-fresh"))
        .unwrap()
    );
    assert_eq!(
        db(&database, |store| store.events(&session.id, 0.0))
            .unwrap()
            .0
            .len(),
        events.len()
    );
}

#[test]
fn cursor_prompt_argument_bound_reserves_nul_and_counts_utf8_bytes() {
    assert!(agents::cursor::validate_prompt(&"x".repeat(128 * 1024 - 1)).is_ok());
    assert!(agents::cursor::validate_prompt(&"界".repeat(43_690)).is_ok());
    assert!(agents::cursor::validate_prompt(&"x".repeat(128 * 1024)).is_err());
    assert!(agents::cursor::validate_prompt("embedded\0nul").is_err());
}
