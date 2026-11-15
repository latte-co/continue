#!/usr/bin/env python3
"""Deterministic ACP and native OpenCode peer."""
import json
import os
from pathlib import Path
import socket
import sys
import threading
import time
import uuid

if sys.argv[1:] == ["--version"]:
    print(f"opencode v{os.environ.get('LATTE_TEST_OPENCODE_VERSION', '2.3.0')}")
    sys.exit(0)
if sys.argv[1:4] == ["session", "export", "--standalone"]:
    print(Path(sys.argv[4] + ".json").read_text())
    sys.exit(0)
assert sys.argv[1:] == ["acp"], sys.argv

session = None
model = "test/default"
effort = "default"
titles = {}
sideband_wire = None
sideband_lock = threading.Lock()
parent_finished = threading.Event()


def native_event(kind, **data):
    with sideband_lock:
        sideband_wire.write(json.dumps({"type": kind, "data": data}) + "\n")
        sideband_wire.flush()


def await_test_signal(name):
    deadline = time.monotonic() + 8
    while not Path(name).is_file():
        assert time.monotonic() < deadline, name
        time.sleep(0.01)


def sideband():
    global sideband_wire
    config = json.loads(os.environ.get("OPENCODE_CONFIG_CONTENT", "{}"))
    entry = next((p for p in config.get("plugins", []) if isinstance(p, dict) and "socket" in p.get("options", {})), None)
    if not entry:
        return
    with socket.socket(socket.AF_UNIX) as conn:
        conn.connect(entry["options"]["socket"])
        with conn.makefile("rw") as wire:
            sideband_wire = wire
            pending_permission = None
            wire.write('{"type":"ready"}\n')
            wire.flush()
            for line in wire:
                request = json.loads(line)
                native = request["sessionID"]
                action = request["action"]
                reply = {"type": "reply", "id": request["id"]}
                if action == "rename":
                    titles[native] = request["title"]
                elif action == "get":
                    reply["title"] = titles.get(native)
                elif action == "prompt":
                    text = request["text"]
                    inbox = request["messageID"]
                    assert inbox == request["id"] and inbox.startswith("msg_")
                    log_prompt(native, text)
                    if text == "before-delivery":
                        native_event("session.inbox.enqueued", sessionID=native, inboxID="msg_plugin", itemType="user")
                        native_event("session.execution.started", sessionID=native)
                        native_event("session.inbox.delivered", sessionID=native, inboxID="msg_plugin")
                        native_done(native, "plugin finished first")
                        await_test_signal("release-prompt")
                    native_event("session.inbox.enqueued", sessionID=native, inboxID=inbox, itemType="user")
                    native_event("session.execution.started", sessionID=native)
                    native_event("session.inbox.delivered", sessionID=native, inboxID=inbox)
                    if text.startswith("permission"):
                        pending_permission = inbox
                        native_event("session.tool.input.started", sessionID=native, id=inbox, name="shell")
                        native_event("session.tool.called", sessionID=native, id=inbox, input={"command": "printf fixture"})
                        native_event("permission.asked", sessionID=native, id=inbox, action="shell",
                                     source={"id": inbox}, resources=["printf fixture"])
                    elif text == "unexpected-eof":
                        os._exit(0)
                    elif text in ("background", "background-question", "nested"):
                        child_prompts(native, text)
                    else:
                        native_done(native, "fixture |reply")
                elif action == "command":
                    assert request["name"] == "project:check"
                    Path(native).write_text("prompted")
                    if request["text"] == "child permission":
                        command_id = request["id"]
                        root = native
                        rejected = False
                        native_event("session.created", sessionID=root + "_child", parentID=root)
                        native_event("permission.asked", sessionID=root + "_child", id="native-ask",
                                     action="shell", source={"id": "shell-call"}, resources=["printf fixture"])
                        continue
                    event = {"type": "session.text.delta", "data": {"sessionID": native, "delta": "command reply"}}
                    wire.write(json.dumps(event) + "\n")
                elif action == "permission":
                    if request["requestID"] == pending_permission:
                        decision = "once" if request["allow"] else "reject"
                        native_event("permission.replied", sessionID=native, requestID=pending_permission, reply=decision)
                        outcome = "success" if request["allow"] else "failed"
                        native_event("session.tool." + outcome, sessionID=native, id=pending_permission,
                                     content=[{"type": "text", "text": "fixture output"}])
                        pending_permission = None
                        native_done(native, "decision:" + ("once" if request["allow"] else "no"))
                        continue
                    assert native == root + "_child" and request["requestID"] == "native-ask"
                    assert request["allow"]
                    if not rejected:
                        rejected = True
                        wire.write(json.dumps({**reply, "error": True}) + "\n")
                        wire.flush()
                        continue
                    native_event("permission.replied", sessionID=native, requestID="native-ask", reply="once")
                    native_event("session.tool.input.started", sessionID=native, id="skill-call", name="skill")
                    native_event("session.tool.called", sessionID=native, id="skill-call", input={"id": "fixture-skill"})
                    native_event("session.tool.success", sessionID=native, id="skill-call", content=[])
                    native_event("session.execution.succeeded", sessionID=native)
                    reply["id"] = command_id
                elif action == "answer":
                    assert request["questionID"] == "child-question"
                    assert request["answers"] == [["One"]]
                    assert parent_finished.is_set()
                    native_event("session.text.delta", sessionID=native + "_child", delta="child answered")
                    native_event("session.execution.succeeded", sessionID=native + "_child")
                    native_event("session.inbox.enqueued", sessionID=native, inboxID="msg_answered", itemType="synthetic")
                    native_event("session.execution.started", sessionID=native)
                    native_event("session.inbox.delivered", sessionID=native, inboxID="msg_answered")
                    native_event("session.execution.succeeded", sessionID=native)
                    continue
                elif action == "interrupt":
                    pending_permission = None
                    native_event("session.execution.interrupted", sessionID=native)
                    reply["interrupted"] = True
                else:
                    raise AssertionError(request)
                wire.write(json.dumps(reply) + "\n")
                wire.flush()


def send(**message):
    print(json.dumps({"jsonrpc": "2.0", **message}), flush=True)


def reply(id, **result):
    send(id=id, result=result)


def update(update_type, session_id=None, **content):
    send(method="session/update", params={
        "sessionId": session if session_id is None else session_id,
        "update": {"sessionUpdate": update_type, **content},
    })


def commands():
    update("available_commands_update", availableCommands=[
        {"name": "project:check", "description": "Run project checks"},
        {"name": "compact", "description": "Compact the session"},
    ])


def options():
    levels = ["default", "low"] if model == "test/default" else ["default", "medium", "max", "native-extra"]
    return [
        {"id": "model", "type": "select", "currentValue": model,
         "options": [{"value": "test/default", "name": "Fixture default"},
                     {"value": "test/other", "name": os.environ.get("OPENCODE_FIXTURE_LABEL", "Other")}]},
        {"id": "effort", "type": "select", "currentValue": effort,
         "options": [{"value": value, "name": value} for value in levels]},
    ]


def complete(id, text):
    update("agent_thought_chunk", content={"type": "text", "text": "private reasoning"})
    update("agent_message_chunk", content={"type": "text", "text": "wrong session"}, session_id="other")
    for fragment in text.split("|"):
        update("agent_message_chunk", content={"type": "text", "text": fragment})
    update("usage_update", used=28, size=10000)
    reply(id, stopReason="end_turn", usage={"inputTokens": 25, "outputTokens": 3})


def log_prompt(native, text):
    Path(native).write_text("prompted")
    with Path("prompts").open("a") as log:
        log.write(f"{native}:{model}:{effort}:{text}\n")


def native_done(native, text):
    native_event("session.reasoning.delta", sessionID=native, delta="private reasoning")
    native_event("session.text.delta", sessionID="other", delta="wrong session")
    for fragment in text.split("|"):
        native_event("session.text.delta", sessionID=native, delta=fragment)
    native_event("session.step.ended", sessionID=native, tokens={"input": 25, "output": 3})
    native_event("session.execution.succeeded", sessionID=native)


def child_prompts(native, text):
    if text == "background":
        native_event("session.created", sessionID="ses_child", parentID=native)
        native_event("session.text.delta", sessionID="ses_child", delta="child only")
    elif text == "background-question":
        native_event("session.created", sessionID=native + "_child", parentID=native)
        native_event("question", sessionID=native + "_child", id="child-question",
                     prompts=[{"header": "Child", "question": "Which mode?",
                               "options": [{"label": "One"}, {"label": "Two"}]}])
        await_test_signal("release-parent")
        parent_finished.set()
        native_done(native, "parent finished")
        return
    else:
        for child, parent in [
            ("ses_child", native), ("ses_nested", "ses_child"),
            ("ses_unowned", "ses_child"), ("ses_other_project", native),
        ]:
            native_event("session.created", sessionID=child, parentID=parent)
            native_event("session.text.delta", sessionID=child, delta="stream " + child)
            native_event("session.execution.succeeded", sessionID=child)
            Path(child + ".json").write_text(json.dumps({
                "info": {"id": child, "parentID": "ses_foreign" if child == "ses_unowned" else parent,
                         "location": {"directory": str(Path.cwd().parent if child == "ses_other_project" else Path.cwd())}},
                "messages": [{"type": "user", "id": "msg_child", "text": "native child instruction"},
                             {"type": "assistant", "content": [
                                 {"type": "text", "text": "native " + child},
                                 {"type": "tool", "id": "tool_error", "name": "shell",
                                  "state": {"status": "error", "error": {"message": "native shell failure"}}},
                                 {"type": "tool", "id": "tool_unfinished", "name": "read",
                                  "state": {"status": "running", "input": {"path": "file.txt"}}},
                             ]}],
            }))
    native_done(native, "main only")


threading.Thread(target=sideband, daemon=True).start()


for line in sys.stdin:
    message = json.loads(line)
    assert message["jsonrpc"] == "2.0"
    method = message.get("method")
    id = message.get("id")
    params = message.get("params", {})
    if method == "initialize":
        assert params["protocolVersion"] == 1
        assert "fs" not in params["clientCapabilities"]
        assert params["clientCapabilities"]["_meta"]["opencode/child-session-updates"] is True
        reply(id, protocolVersion=1, agentInfo={"name": "OpenCode", "version": "2.3.0"},
              agentCapabilities={"sessionCapabilities": {"resume": {}, "close": {}, "delete": {}}})
    elif method in ("session/new", "session/resume"):
        assert Path(params["cwd"]) == Path.cwd()
        assert params["mcpServers"] == []
        if method == "session/new":
            session = "ses_" + uuid.uuid4().hex
            Path(session).write_text("unprompted")
            commands()
            reply(id, sessionId=session, configOptions=options())
        else:
            session = params["sessionId"]
            if not Path(session).exists():
                send(id=id, error={"code": -32602, "message": "Session not found"})
                continue
            assert Path(session).read_text() == "prompted"
            reply(id, configOptions=options())
            commands()
    elif method == "session/set_config_option":
        assert params["sessionId"] == session
        key, value = params["configId"], params["value"]
        assert value in [row["value"] for opt in options() if opt["id"] == key for row in opt["options"]]
        if key == "model":
            model = value
            effort = "default"
        else:
            assert key == "effort"
            effort = value
        reply(id, configOptions=options())
    elif method == "session/delete":
        assert params["sessionId"] == session
        assert Path(session).read_text() == "unprompted"
        Path(session).unlink()
        reply(id)
    elif method == "session/close":
        assert params["sessionId"] == session
        if Path(session).read_text() == "unprompted":
            Path(session).unlink()
        reply(id)
    elif method == "session/prompt":
        assert params["sessionId"] == session
        assert len(params["prompt"]) == 1
        text = params["prompt"][0]["text"]
        assert text.startswith("/compact"), text
        log_prompt(session, text)
        if text == "/compact late-native":
            complete(id, "ACP reply")
            await_test_signal("release-native")
            native_event("session.inbox.enqueued", sessionID=session, inboxID="msg_acp", itemType="compaction")
            native_event("session.execution.started", sessionID=session)
            native_event("session.inbox.delivered", sessionID=session, inboxID="msg_acp")
            native_event("session.text.delta", sessionID=session, delta="duplicate native reply")
            native_event("session.execution.succeeded", sessionID=session)
            native_event("session.inbox.enqueued", sessionID=session, inboxID="msg_bg", itemType="user")
            native_event("session.execution.started", sessionID=session)
            native_event("session.inbox.delivered", sessionID=session, inboxID="msg_bg")
            native_done(session, "real follow-up")
        else:
            complete(id, "fixture |reply")
    else:
        raise AssertionError(message)
