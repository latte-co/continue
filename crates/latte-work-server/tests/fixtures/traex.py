#!/usr/bin/env python3
"""Deterministic Traex app-server v2 fixture; no model, login or shared daemon."""
import json
import os
import pathlib
import sys
import threading
import time

if '--version' in sys.argv:
    print('fixture-traex 0.210.1')
    sys.exit(0)
if '--help' in sys.argv:
    print('--permission-mode <MODE>\n          - default: workspace access\n          - bypass_permissions: full access\n          - auto: auto reviewer\n\n  -h, --help')
    sys.exit(0)
assert sys.argv[1:3] == ['app-server', '--stdio'], sys.argv
launch = {}
for index, arg in enumerate(sys.argv[3:]):
    if arg == '-c':
        key, value = sys.argv[index + 4].split('=', 1)
        launch[key] = value
thread = 'traex-native-thread'
turn = None
count = 0
waiting = None
title_prompt = None
output_lock = threading.Lock()

def emit(value):
    with output_lock:
        print(json.dumps(value), flush=True)

def reply(value, result):
    emit({'id': value['id'], 'result': result})

def notify(method, params):
    emit({'method': method, 'params': {'threadId': thread, 'turnId': turn, **params}})

def complete(status='completed'):
    notify('turn/completed', {'turn': {'id': turn, 'status': status, 'error': {'message': 'native failure'} if status == 'failed' else None}})

def text(content):
    notify('item/agentMessage/delta', {'itemId': 'msg-' + turn, 'delta': content})
    notify('item/completed', {'item': {'id': 'msg-' + turn, 'type': 'agentMessage', 'text': content}})

for line in sys.stdin:
    value = json.loads(line)
    method = value.get('method')
    params = value.get('params', {})
    if method == 'initialize':
        reply(value, {'userAgent': 'fixture-traex'})
    elif method == 'initialized':
        pass
    elif method == 'config/read':
        reply(value, {'config': {'model_provider': 'fixture-native', 'model': 'seed-test', 'developer_instructions': 'FIXTURE_NATIVE_DEVELOPER_INSTRUCTIONS'}})
    elif method == 'skills/list':
        cwds = params.get('cwds') or [os.getcwd()]
        cwd_path = pathlib.Path(cwds[0])
        skills = [
            {
                'name': 'fixture-traex-skill',
                'description': 'Full Traex skill body description',
                'shortDescription': 'Traex 技能说明',
                'interface': {'displayName': 'Traex 技能'},
                'path': str((cwd_path / '.agents/skills/fixture-traex-skill/SKILL.md').resolve()),
                'scope': 'repo',
                'enabled': True,
            },
            {
                'name': 'disabled-traex-skill',
                'description': 'Disabled skill',
                'path': str((cwd_path / '.agents/skills/disabled/SKILL.md').resolve()),
                'scope': 'repo',
                'enabled': False,
            },
        ]
        skill_roots = [cwd_path / '.traex/skills', cwd_path / '.trae/skills', cwd_path / '.agents/skills', cwd_path / '.codex/skills']
        traex_home = os.environ.get('TRAEX_HOME')
        codex_home = os.environ.get('CODEX_HOME')
        home_dir = os.environ.get('HOME')
        if traex_home:
            skill_roots.append(pathlib.Path(traex_home) / 'skills')
        elif home_dir:
            for rel in ('.trae/skills', '.traex/skills'):
                skill_roots.append(pathlib.Path(home_dir) / rel)
        effective_codex_home = pathlib.Path(codex_home) if codex_home else (pathlib.Path(home_dir) / '.codex' if home_dir else None)
        if effective_codex_home:
            skill_roots.append(effective_codex_home / 'skills')
        if home_dir:
            skill_roots.append(pathlib.Path(home_dir) / '.agents/skills')
        disabled_paths = set()
        if effective_codex_home and (effective_codex_home / 'config.toml').is_file():
            cur_path, cur_enabled = None, None
            for raw_line in (effective_codex_home / 'config.toml').read_text().splitlines():
                stripped = raw_line.split('#', 1)[0].strip()
                if stripped.startswith('['):
                    if cur_path is not None and cur_enabled is not None:
                        if not cur_enabled:
                            disabled_paths.add(cur_path)
                        else:
                            disabled_paths.discard(cur_path)
                    cur_path, cur_enabled = None, None
                elif stripped.startswith('path') and '=' in stripped:
                    val = stripped.split('=', 1)[1].strip().strip('"').strip("'")
                    cur_path = str(pathlib.Path(val).resolve())
                elif stripped.startswith('enabled') and '=' in stripped:
                    val = stripped.split('=', 1)[1].strip()
                    cur_enabled = (val == 'true')
            if cur_path is not None and cur_enabled is not None:
                if not cur_enabled:
                    disabled_paths.add(cur_path)
                else:
                    disabled_paths.discard(cur_path)
        for skills_root in skill_roots:
            if skills_root.is_dir():
                for child in sorted(skills_root.iterdir()):
                    skill_md = child / 'SKILL.md'
                    if skill_md.is_file():
                        resolved_md = str(skill_md.resolve())
                        is_enabled = resolved_md not in disabled_paths
                        if any(s['name'] == child.name and s['enabled'] for s in skills):
                            continue
                        skills.append({
                            'name': child.name,
                            'description': f'Discovered skill {child.name}',
                            'path': resolved_md,
                            'scope': 'user' if skills_root.parent != cwd_path else 'repo',
                            'enabled': is_enabled,
                        })
        reply(value, {'data': [{'cwd': str(cwd_path), 'skills': skills, 'errors': []}]})
    elif method == 'model/list':
        reply(value, {'data': [{'id': 'seed-test', 'displayName': 'Seed Test', 'isDefault': True, 'supportedReasoningEfforts': [{'reasoningEffort': 'high'}]},
            {'id': 'gpt-test', 'displayName': 'GPT Test', 'supportedReasoningEfforts': [{'reasoningEffort': 'high'}],
             'businessMetadata': {'variants': {'standard_key': 'backend-small', 'max_key': 'backend-large',
                'standard_context_window': 475000, 'max_context_window': 800000,
                'standard_supported_reasoning_levels': [{'effort': 'high'}],
                'max_supported_reasoning_levels': [{'effort': 'low'}]}}}], 'nextCursor': None})
    elif method == 'thread/fork' or (method == 'thread/resume' and params['threadId'].startswith('side-thread-')):
        if 'sandbox' in params:
            sandbox, approval = {
                'read-only': ('readOnly', 'never'),
                'workspace-write': ('workspaceWrite', 'on-request'),
                'danger-full-access': ('dangerFullAccess', 'never'),
            }[params['sandbox']]
            assert params['approvalPolicy'] == approval
        else:
            assert 'approvalPolicy' not in params
            sandbox, approval = ('workspaceWrite', 'on-request')
        assert 'inherited messages' in params['developerInstructions']
        if method == 'thread/fork':
            assert params['threadId'] == thread and params['excludeTurns']
        parent_thread = thread
        thread = f'side-thread-{os.getpid()}' if method == 'thread/fork' else params['threadId']
        reply(value, {'thread': {'id': thread, 'forkedFromId': parent_thread},
                      'sandbox': {'type': sandbox}, 'approvalPolicy': approval})
    elif method in ('thread/start', 'thread/resume'):
        if 'developerInstructions' in params:
            assert params['developerInstructions'].startswith('FIXTURE_NATIVE_DEVELOPER_INSTRUCTIONS\n\nContinue'), params['developerInstructions']
        if method == 'thread/resume':
            assert params['threadId'] == thread
            if not pathlib.Path('traex-inputs').exists():
                emit({'id': value['id'], 'error': {'code': -32602, 'message': 'no rollout found for empty thread'}})
                continue
        with pathlib.Path('traex-opens').open('a') as record:
            record.write(json.dumps({'pid': os.getpid(), 'method': method, 'params': params, 'provider_config': launch}) + '\n')
        saved = {'id': thread}
        history_size = pathlib.Path('traex-resume-bytes')
        if method == 'thread/resume' and history_size.exists():
            size = int(history_size.read_text())
            saved['turns'] = [{'id': 'past-turn', 'items': [{'type': 'agentMessage', 'text': 'HISTORY_ONLY_MARKER' + 'h' * size}]}]
        reply(value, {'thread': saved})
    elif method == 'thread/name/generate':
        assert params == {'threadId': thread, 'requestId': 'latte-generate-title'}
        with pathlib.Path('traex-title-inputs').open('a') as f:
            f.write(json.dumps({'prompt': title_prompt}) + '\n')
        if title_prompt == 'native-auto-title-failed':
            emit({'id': value['id'], 'error': {'code': -32601, 'message': 'unsupported'}})
            continue
        reply(value, {})
        def finish_title(prompt=title_prompt):
            if prompt == 'native-auto-title-held':
                deadline = time.monotonic() + 10
                while not pathlib.Path('title-release').exists() and time.monotonic() < deadline:
                    time.sleep(.02)
            notify('thread/name/generated', {'turnId': 'unrelated-request', 'name': 'wrong'})
            notify('thread/name/generated', {'turnId': 'latte-generate-title', 'name': '' if prompt == 'native-auto-title-empty' else '修复附件拖入失败'})
            pathlib.Path('title-response').write_text('sent')
        threading.Thread(target=finish_title, daemon=True).start()
    elif method == 'thread/name/set':
        notify('thread/name/updated', {'threadName': params['name']})
        reply(value, {})
    elif method == 'thread/compact/start':
        assert params['threadId'] == thread
        count += 1
        turn = 'turn-' + str(count)
        with pathlib.Path('traex-inputs').open('a') as record:
            record.write(json.dumps({'prompt': '/compact', 'params': params, 'pid': os.getpid()}) + '\n')
        notify('turn/started', {'turn': {'id': turn, 'status': 'inProgress'}})
        reply(value, {})
        notify('item/completed', {'item': {'id': 'compact-' + turn, 'type': 'contextCompaction'}})
        notify('thread/compacted', {})
        complete()
    elif method == 'review/start':
        assert params['threadId'] == thread and params.get('delivery') == 'inline'
        count += 1
        turn = 'turn-' + str(count)
        with pathlib.Path('traex-inputs').open('a') as record:
            record.write(json.dumps({'prompt': '/review', 'params': params, 'pid': os.getpid()}) + '\n')
        notify('turn/started', {'turn': {'id': turn, 'status': 'inProgress'}})
        reply(value, {'turn': {'id': turn, 'status': 'inProgress'}, 'reviewThreadId': thread})
        notify('item/started', {'item': {'id': 'review-' + turn, 'type': 'enteredReviewMode', 'review': 'current changes'}})
        notify('item/completed', {'item': {'id': 'review-' + turn, 'type': 'exitedReviewMode',
                                          'review': 'TRAE_REVIEW:' + json.dumps(params['target'], sort_keys=True, ensure_ascii=False)}})
        complete()
    elif method == 'turn/start':
        count += 1
        turn = 'turn-' + str(count)
        skill_item = params['input'][0] if params['input'][0]['type'] == 'skill' else None
        prompt = params['input'][1]['text'] if skill_item else params['input'][0]['text']
        title_prompt = prompt
        assert params['threadId'] == thread
        with pathlib.Path('traex-inputs').open('a') as record:
            record.write(json.dumps({'prompt': prompt, 'params': params, 'pid': os.getpid()}) + '\n')
        if prompt == 'early-complete':
            complete()
            reply(value, {'turn': {'id': turn, 'status': 'completed'}})
            notify('turn/started', {'turn': {'id': turn, 'status': 'inProgress'}})
            continue
        notify('turn/started', {'turn': {'id': turn, 'status': 'inProgress'}})
        reply(value, {'turn': {'id': turn, 'status': 'inProgress'}})
        if skill_item is not None:
            notify('item/completed', {'item': {'id': 'user-' + turn, 'type': 'userMessage', 'content': params['input']}})
            text(f"TRAE:SKILL:{skill_item['name']}:{prompt}")
            complete()
            continue
        if prompt == 'eof':
            sys.exit(0)
        if prompt in ('approval', 'question'):
            waiting = prompt
            if prompt == 'approval':
                emit({'id': 73, 'method': 'item/commandExecution/requestApproval', 'params': {'threadId': thread, 'turnId': turn, 'itemId': 'bash', 'command': 'echo approved', 'cwd': os.getcwd()}})
            else:
                emit({'id': 'ask', 'method': 'item/tool/requestUserInput', 'params': {'threadId': thread, 'turnId': turn, 'itemId': 'ask-tool', 'questions': [{'id': 'q', 'header': 'Pick', 'question': 'Choose one', 'options': [{'label': 'A', 'description': 'first'}, {'label': 'B', 'description': 'second'}]}]}})
        elif prompt in ('wait', 'wait-interrupt-race', 'wait-think', 'wait-reply'):
            text('WAITING')
            if prompt == 'wait-think': notify('item/reasoning/textDelta', {'itemId':'think','delta':'private reasoning'})
        elif prompt == 'complete-only':
            for _ in range(2):
                notify('item/completed', {'item': {'id': 'msg-' + turn, 'type': 'agentMessage', 'text': 'ONCE'}})
            complete()
        elif prompt == 'custom-environment':
            text(json.dumps({'pid':os.getpid(), **{name:os.environ.get(name) for name in ['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','LATTE_TEST_LITERAL','LATTE_TEST_EMPTY','LATTE_TEST_SECRET']}}))
            complete()
        elif prompt == 'credential':
            text(os.environ['LATTE_WORK_TRAEX_PROVIDER_TOKEN'])
            complete()
        elif prompt == 'failed':
            complete('failed')
        elif prompt in ('background', 'background-wait'):
            item = {'id': 'background-start', 'type': 'commandExecution', 'command': 'python -m unittest discover',
                    'cwd': os.getcwd(), 'status': 'inProgress'}
            notify('item/started', {'item': item})
            notify('item/completed', {'item': {**item, 'status': 'backgrounded', 'processId': '47462',
                    'exitCode': None, 'aggregatedOutput': 'partial regression output',
                    'rawOutput': {'process_id': 47462}}})
            text('BACKGROUND_WAITING')
            if prompt == 'background':
                complete()
        elif prompt in ('background-write-hold', 'background-write-eof'):
            pathlib.Path('background-late.txt').write_text('written by background command\n')
            notify('item/completed', {'item': {'id': 'background-poll', 'type': 'commandExecution',
                    'command': '', 'cwd': os.getcwd(), 'source': 'unifiedExecInteraction', 'status': 'completed',
                    'processId': '47462', 'exitCode': 0, 'aggregatedOutput': 'final regression output'}})
            text('BACKGROUND_LATE')
            if prompt == 'background-write-eof':
                sys.exit(0)
        elif prompt == 'background-write':
            pathlib.Path('background-late.txt').write_text('written by background command\n')
            notify('item/completed', {'item': {'id': 'background-poll', 'type': 'commandExecution',
                    'command': '', 'cwd': os.getcwd(), 'source': 'unifiedExecInteraction', 'status': 'completed',
                    'processId': '47462', 'exitCode': 0, 'aggregatedOutput': 'final regression output'}})
            text('BACKGROUND_WROTE')
            complete()
        elif prompt in ('background-poll-success', 'background-poll-failure'):
            code = 0 if prompt.endswith('success') else 1
            notify('item/completed', {'item': {'id': 'background-poll', 'type': 'commandExecution',
                    'command': '', 'cwd': os.getcwd(), 'source': 'unifiedExecInteraction', 'status': 'completed',
                    'processId': '47462', 'exitCode': code, 'aggregatedOutput': 'final regression output'}})
            text('BACKGROUND_FINISHED')
            complete()
        else:
            notify('item/started', {'item': {'id': 'bash', 'type': 'commandExecution', 'command': 'echo fixture', 'cwd': os.getcwd(), 'status': 'inProgress'}})
            notify('item/completed', {'item': {'id': 'bash', 'type': 'commandExecution', 'command': 'echo fixture', 'cwd': os.getcwd(), 'status': 'completed', 'exitCode': 0, 'aggregatedOutput': 'fixture'}})
            text('TRAE:' + prompt)
            complete()
    elif method == 'turn/steer':
        assert params['threadId'] == thread and params['expectedTurnId'] == turn
        skill_item = params['input'][0] if params['input'][0]['type'] == 'skill' else None
        extra = params['input'][1]['text'] if skill_item else params['input'][0]['text']
        with pathlib.Path('traex-steers').open('a') as record:
            record.write(json.dumps({'prompt':extra,'params':params,'pid':os.getpid()})+'\n')
        if extra == 'reject-steer':
            emit({'id':value['id'],'error':{'code':-32602,'message':'current turn cannot accept steering'}})
        else:
            reply(value,{'turnId':turn})
            if skill_item is not None:
                notify('item/completed', {'item': {'id': 'user-steer-' + turn, 'type': 'userMessage', 'content': params['input']}})
                text(f"STEER:SKILL:{skill_item['name']}:{extra}")
                complete()
            elif extra != 'hold-steer':
                text('STEER:'+extra)
                complete()
    elif method == 'turn/interrupt':
        pathlib.Path('traex-interrupted').write_text('interrupt')
        assert params['turnId'] == turn
        if prompt == 'wait-interrupt-race':
            complete()
            emit({'id': value['id'], 'error': {'code': -32602, 'message': 'turn not found'}})
        else:
            complete('interrupted')
            reply(value, {})
    elif method is None and waiting:
        if waiting == 'approval':
            assert value['id'] == 73
            text('APPROVED' if value['result']['decision'] == 'accept' else 'DENIED')
        else:
            assert value['id'] == 'ask'
            text('ANSWER:' + json.dumps(value['result']['answers']))
        waiting = None
        complete()
    else:
        raise AssertionError(value)
