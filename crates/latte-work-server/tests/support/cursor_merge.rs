//! Cursor and composer-prediction contracts after merging PR #33.
use super::*;
use latte_work_protocol::ComposerPredictionStatus;

async fn unsupported(client: &mut Client, id: &str) {
    assert!(matches!(
        ask(
            client,
            Request::ComposerPrediction {
                session_id: id.into()
            }
        )
        .await,
        Response::ComposerPrediction {
            status: ComposerPredictionStatus::Unsupported,
            source_request_id: None,
            generation_id: None,
            suggestion: None,
            ..
        }
    ));
}

#[tokio::test]
async fn cursor_merge_preparation_and_per_turn_completion_do_not_generate_predictions() {
    let host = Host::start().await;
    let root = tempfile::tempdir().unwrap();
    let mut client = host.client().await;
    let id = session(&mut client, root.path()).await;
    open(&mut client, &id).await;
    unsupported(&mut client, &id).await;
    assert!(!root.path().join("cursor-inputs").exists());

    for request in ["cursor-source-one", "cursor-source-two"] {
        assert!(matches!(
            send(&mut client, &id, request, "hello").await,
            Response::Accepted { duplicate: false }
        ));
        wait(&mut client, &id, Status::Completed).await;
        unsupported(&mut client, &id).await;
        assert_eq!(
            current(&mut client, &id).await.agent_session_open,
            Some(false)
        );
    }
    assert_eq!(inputs(root.path()).len(), 2);
    let Response::Events {
        events,
        composer_prediction,
        ..
    } = ask(
        &mut client,
        Request::Poll {
            session_id: id.clone(),
            after: 0.0,
        },
    )
    .await
    else {
        panic!("Cursor poll");
    };
    if let Some(prediction) = composer_prediction {
        assert_eq!(prediction.status, ComposerPredictionStatus::Unsupported);
        assert!(prediction.suggestion.is_none());
    }
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event.event, EventKind::User { .. }))
            .count(),
        2
    );
    assert!(matches!(
        send(&mut client, &id, "cursor-source-one", "hello").await,
        Response::Accepted { duplicate: true }
    ));
    assert_eq!(
        inputs(root.path()).len(),
        2,
        "prediction reads and reconciliation must not replay Cursor input"
    );
}
