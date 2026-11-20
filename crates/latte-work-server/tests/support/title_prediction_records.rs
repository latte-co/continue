pub(super) fn held_prediction_pid(inputs: &str) -> anyhow::Result<Option<i32>> {
    use anyhow::Context;

    let mut held_pid = None;
    for (index, line) in inputs.lines().enumerate() {
        let input: serde_json::Value = serde_json::from_str(line)
            .with_context(|| format!("invalid prediction record on line {}", index + 1))?;
        let description = input["description"]
            .as_str()
            .context("prediction description")?;
        let prompt = description
            .strip_prefix("User message:\n")
            .and_then(|context| context.split_once("\n\nFinal assistant reply:\n"))
            .map(|(prompt, _)| prompt);
        if prompt == Some("prediction-held") {
            anyhow::ensure!(held_pid.is_none(), "duplicate held prediction record");
            let pid = input["pid"].as_i64().context("prediction pid")?;
            held_pid = Some(i32::try_from(pid)?);
        }
    }
    Ok(held_pid)
}

#[test]
fn held_prediction_pid_selects_exact_prompt_from_ndjson() {
    let inputs = [
        ("native-auto-title", "CODEX:native-auto-title", 101),
        ("prediction-held-extra", "CODEX:prediction-held-extra", 102),
        ("prediction-held", "CODEX:prediction-held", 103),
        ("other", "CODEX:prediction-held", 104),
        (
            "prefix-prediction-held",
            "CODEX:prefix-prediction-held",
            105,
        ),
    ]
    .map(|(prompt, reply, pid)| {
        serde_json::json!({
            "description": format!("User message:\n{prompt}\n\nFinal assistant reply:\n{reply}"),
            "pid": pid, "provider": "fixture", "model": "custom-codex", "effort": null
        })
        .to_string()
    })
    .join("\n");
    assert_eq!(held_prediction_pid(&inputs).unwrap(), Some(103));
}

#[test]
fn held_prediction_pid_does_not_match_similar_prompts() {
    for prompt in [
        "native-auto-title",
        "prediction-held-extra",
        "prefix-prediction-held",
    ] {
        let input = serde_json::json!({
            "description": format!("User message:\n{prompt}\n\nFinal assistant reply:\nCODEX:prediction-held"),
            "pid": 101
        });
        assert_eq!(held_prediction_pid(&input.to_string()).unwrap(), None);
    }
}

#[test]
fn held_prediction_pid_rejects_malformed_ndjson_lines() {
    let input = serde_json::json!({
        "description": "User message:\nprediction-held\n\nFinal assistant reply:\nCODEX:prediction-held",
        "pid": 103
    });
    for inputs in [
        format!("malformed\n{input}\n"),
        format!("{input}\nmalformed\n"),
    ] {
        assert!(held_prediction_pid(&inputs).is_err());
    }
}
