#!/usr/bin/env python3
"""Strict per-turn Cursor peer. Never contacts an account or model service."""
from __future__ import annotations

import json
import os
import pathlib
import signal
import sys
import time
from typing import Any

NATIVE_ID = "cursor-native-session"


def emit(value: dict[str, Any]) -> None:
    print(json.dumps({"session_id": NATIVE_ID, **value}), flush=True)


def text(value: str) -> None:
    emit({
        "type": "assistant",
        "message": {"role": "assistant", "content": [
            {"type": "text", "text": value}
        ]},
    })


def await_file(name: str) -> None:
    deadline = time.monotonic() + 20
    while not pathlib.Path(name).exists():
        if time.monotonic() >= deadline:
            raise TimeoutError(name)
        time.sleep(0.02)


def metadata(args: list[str]) -> bool:
    if args == ["--version"]:
        print("2026.11.13-eacade1")
    elif args == ["--help"]:
        print(
            "  --print  Print a headless response\n"
            '  --output-format <format>  Output format (choices: "text", "json", "stream-json")\n'
            "  --resume [chatId]  Resume a chat\n"
            "  --model <model>  Select a model\n"
            '  --mode <mode>  Read-only mode (choices: "plan", "ask")\n'
            "  --sandbox <mode>  enabled | disabled"
        )
    elif args in (["models"], ["--list-models"]):
        model = (
            "cursor-next - Cursor Next"
            if pathlib.Path("cursor-models-next").exists()
            else "cursor-test - Cursor Test"
        )
        print(
            f"Available models\n\n{model} (default)\n\n"
            "Tip: use --model <id> to select a model."
        )
    else:
        return False
    return True


def parse(args: list[str]) -> tuple[str, list[str], str | None]:
    assert "--" in args, args
    delimiter = args.index("--")
    assert len(args[delimiter + 1:]) == 1, args
    options = args[:delimiter]
    assert "--print" in options and "--output-format" in options, options
    assert options[options.index("--output-format") + 1] == "stream-json"
    forbidden = (
        "--force", "--yolo", "--trust", "--approve-mcps",
        "--stream-partial-output",
    )
    assert not any(flag in options for flag in forbidden), options
    allowed = frozenset({
        "--print", "--output-format", "stream-json", "--resume", NATIVE_ID,
        "--model", "cursor-test", "cursor-next", "--mode", "ask", "plan",
    })
    assert all(value in allowed for value in options), options
    resume = options[options.index("--resume") + 1] if "--resume" in options else None
    return args[delimiter + 1], options, resume


def record_input(prompt: str, options: list[str], resume: str | None) -> pathlib.Path:
    record = {
        "pid": os.getpid(), "prompt": prompt, "resume": resume,
        "options": options, "env": os.environ.get("CURSOR_FIXTURE_SECRET"),
        "binary": sys.argv[0], "path": os.environ.get("PATH"),
    }
    with pathlib.Path("cursor-inputs").open("a") as log:
        log.write(json.dumps(record) + "\n")
    active = pathlib.Path("cursor-active")
    fd = os.open(active, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(fd)
    return active


def diagnostic() -> None:
    print(
        "fixture diagnostic " + os.environ.get("CURSOR_FIXTURE_SECRET", ""),
        file=sys.stderr, flush=True,
    )


def special_output(prompt: str) -> bool:
    if prompt == "stderr-after-init":
        diagnostic()
        sys.exit(7)
    elif prompt == "stderr-exit-zero":
        diagnostic()
    elif prompt == "stderr-oversize":
        print("x" * (32 * 1024), file=sys.stderr, flush=True)
        diagnostic()
        sys.exit(7)
    elif prompt == "eof-hold":
        os.close(sys.stdout.fileno())
        await_file("cursor-release")
    elif prompt == "eof":
        text("CURSOR:unfinished")
    elif prompt == "unframed":
        sys.stdout.write("x" * (2 * 1024 * 1024))
        sys.stdout.flush()
        await_file("cursor-release")
    elif prompt == "oversize":
        text("x" * (2 * 1024 * 1024))
    elif prompt == "malformed":
        print("{invalid", flush=True)
    elif prompt == "wrong-session":
        print(json.dumps({
            "type": "assistant", "session_id": "different-session",
            "message": {"role": "assistant", "content": [
                {"type": "text", "text": "WRONG"}
            ]},
        }), flush=True)
    else:
        return False
    return True


def tool() -> None:
    emit({
        "type": "tool_call", "subtype": "started", "call_id": "read-1",
        "tool_call": {"readToolCall": {"args": {"path": "notes.txt"}}},
    })
    emit({
        "type": "tool_call", "subtype": "completed", "call_id": "read-1",
        "tool_call": {"readToolCall": {
            "args": {"path": "notes.txt"},
            "result": {"success": {"content": "fixture notes"}},
        }},
    })


def complete(prompt: str) -> None:
    content = "CURSOR:" + prompt
    if prompt != "result-only":
        text(content)
    emit({
        "type": "result", "subtype": "success", "is_error": False,
        "duration_ms": 12, "duration_api_ms": 12, "result": content,
    })
    if prompt == "delayed-exit":
        pathlib.Path("cursor-result-emitted").touch()
        await_file("cursor-release")
    if prompt == "nonzero":
        diagnostic()
        sys.exit(7)


def run_turn(prompt: str, model: str) -> None:
    assert sys.stdin.read() == "", "Per-turn stdin must be closed"
    if prompt == "stderr-no-result":
        diagnostic()
        sys.exit(7)
    if prompt == "before-init":
        await_file("cursor-release")
        return
    emit({
        "type": "system", "subtype": "init", "cwd": os.getcwd(),
        "model": model, "permissionMode": "default",
    })
    if prompt == "hold":
        await_file("cursor-release")
    if not special_output(prompt):
        tool()
        complete(prompt)


def main() -> None:
    args = sys.argv[1:]
    if metadata(args):
        return
    prompt, options, resume = parse(args)
    active = record_input(prompt, options, resume)

    def stop(_signum: int, _frame: Any) -> None:
        active.unlink(missing_ok=True)
        sys.exit(143)

    signal.signal(signal.SIGTERM, stop)
    try:
        model = options[options.index("--model") + 1] if "--model" in options else "cursor-test"
        run_turn(prompt, model)
    finally:
        active.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
