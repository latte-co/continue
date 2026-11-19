use super::*;
use latte_work_protocol::ComposerPredictionStatus;

#[tokio::test]
async fn composer_prediction_reads_carry_source_when_history_window_has_no_user() {
    let host = Host::start().await;
    let mut client = host.client().await;
    let root = tempfile::tempdir().unwrap();
    let Response::Project { project } = ask(
        &mut client,
        Request::AddProject {
            path: root.path().to_string_lossy().into_owned(),
            name: None,
        },
    )
    .await
    else {
        panic!("project")
    };
    let Response::Session { session } = ask(
        &mut client,
        Request::CreateSession {
            project_id: project.id,
            agent: "codex".into(),
        },
    )
    .await
    else {
        panic!("session")
    };
    assert!(matches!(
        ask(
            &mut client,
            Request::Send {
                session_id: session.id.clone(),
                request_id: "source-window".into(),
                text: "Implement the cache and summarize the result".into(),
                model: None,
                effort: None,
                provider: None,
                permission_mode: None,
            }
        )
        .await,
        Response::Accepted { duplicate: false }
    ));
    let events = wait(&mut client, &session.id, Status::Completed).await;
    let source_seq = events
        .iter()
        .find_map(|event| match &event.event {
            EventKind::User { request_id, .. } if request_id == "source-window" => Some(event.seq),
            _ => None,
        })
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    let generation = loop {
        let response = ask(
            &mut client,
            Request::ComposerPrediction {
                session_id: session.id.clone(),
            },
        )
        .await;
        if let Response::ComposerPrediction {
            status: ComposerPredictionStatus::Ready,
            generation_id: Some(generation),
            ..
        } = response
        {
            break generation;
        }
        assert!(
            Instant::now() < deadline,
            "prediction not ready: {response:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    // Append ordinary durable events in this disposable host, beyond the compacted window.
    let connection =
        rusqlite::Connection::open(host.directory.path().join("state.sqlite")).unwrap();
    for n in 0..300 {
        connection
            .execute(
                "INSERT INTO events(session_id,at,data) VALUES (?1,1,?2)",
                rusqlite::params![
                    session.id,
                    serde_json::to_string(&EventKind::Notice {
                        text: format!("padding {n}")
                    })
                    .unwrap()
                ],
            )
            .unwrap();
    }
    let Response::History {
        events,
        has_more,
        composer_prediction,
        ..
    } = ask(
        &mut client,
        Request::History {
            session_id: session.id.clone(),
            before: None,
        },
    )
    .await
    else {
        panic!("history")
    };
    assert!(has_more);
    assert!(
        !events
            .iter()
            .any(|event| matches!(event.event, EventKind::User { .. }))
    );
    let snapshot = composer_prediction.expect("main history carries cached prediction");
    assert_eq!(snapshot.status, ComposerPredictionStatus::Ready);
    assert_eq!(snapshot.source_request_id.as_deref(), Some("source-window"));
    assert_eq!(snapshot.source_user_seq, Some(source_seq));
    assert_eq!(snapshot.generation_id.as_deref(), Some(generation.as_str()));
    let after = events.last().unwrap().seq;
    for _ in 0..3 {
        let Response::Events {
            events,
            composer_prediction,
            ..
        } = ask(
            &mut client,
            Request::Poll {
                session_id: session.id.clone(),
                after,
            },
        )
        .await
        else {
            panic!("events")
        };
        assert!(events.is_empty());
        assert_eq!(
            composer_prediction.unwrap().generation_id.as_deref(),
            Some(generation.as_str())
        );
    }
}
