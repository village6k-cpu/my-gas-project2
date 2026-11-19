"""Release only Kakao tabs captured from trusted browser-tool results."""
import json
import logging
import threading
from uuid import UUID

TOOL = 'mcp__village_browser__browser'
log = logging.getLogger(__name__)
lock = threading.Lock()
owners = {}


def payload(result):
    try:
        envelope = json.loads(result) if isinstance(result, str) else result
        if not isinstance(envelope, dict):
            return {}
        nested = envelope.get('result', envelope.get('error', envelope))
        output = json.loads(nested) if isinstance(nested, str) else nested
        return output if isinstance(output, dict) else {}
    except ValueError:
        return {}


def after_tool(tool_name='', args=None, result=None, session_id='', turn_id='', **_):
    if tool_name != TOOL or not session_id or not turn_id:
        return
    data = payload(result)
    handle = data.get('handle')
    try:
        if str(UUID(handle)) != handle:
            return
    except (TypeError, ValueError, AttributeError):
        return
    action = (args or {}).get('action')
    key = (session_id, turn_id)
    with lock:
        if action in ('open', 'kakao_open_room', 'navigate') and str(data.get('url', '')).startswith('https://business.kakao.com/'):
            owners.setdefault(key, set()).add(handle)
        elif action == 'close' and data.get('closed') is True:
            if key in owners:
                owners[key].discard(handle)
                if not owners[key]:
                    owners.pop(key)


def finish_turn(session_id='', turn_id='', **_):
    with lock:
        handles = owners.pop((session_id, turn_id), ())
    if not handles:
        return
    from tools.registry import registry
    for handle in handles:
        result = payload(registry.dispatch(TOOL, {'action': 'close', 'handle': handle, 'kakao_only': True}))
        if result.get('closed') is True:
            log.info('Closed one Kakao tab at turn end')
        elif result.get('reason') != 'not_kakao':
            log.info('Kakao tab was retained or already closed at turn end')


def finish_session(session_id='', **_):
    if not session_id:
        return
    with lock:
        turns = [turn for session, turn in owners if session == session_id]
    for turn in turns:
        finish_turn(session_id=session_id, turn_id=turn)


def register(ctx):
    ctx.register_hook('post_tool_call', after_tool)
    ctx.register_hook('post_llm_call', finish_turn)
    ctx.register_hook('on_session_finalize', finish_session)
