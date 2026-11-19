import importlib.util
import json
from pathlib import Path
from types import ModuleType, SimpleNamespace
import sys
import unittest
from unittest.mock import patch
from uuid import uuid4

spec = importlib.util.spec_from_file_location('kakao_cleanup', Path(__file__).with_name('__init__.py'))
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)


class TurnCleanup(unittest.TestCase):
    def test_only_the_ending_turns_verified_handle_is_closed(self):
        calls = []
        module = ModuleType('tools.registry')
        def dispatch(tool, args):
            calls.append((tool, args))
            return json.dumps({'result': json.dumps({'closed': True})})
        module.registry = SimpleNamespace(dispatch=dispatch)
        first, second, already_closed = (str(uuid4()) for _ in range(3))
        def record(handle, turn, action='kakao_open_room'):
            cleanup.after_tool(tool_name=cleanup.TOOL, args={'action': action},
                result=json.dumps({'result': json.dumps({'handle': handle,
                    'url': 'https://business.kakao.com/fixture', 'closed': action == 'close'})}),
                session_id='session', turn_id=turn)
        record(first, 'first')
        record(second, 'second')
        record(already_closed, 'first')
        record(already_closed, 'first', 'close')
        with patch.dict(sys.modules, {'tools.registry': module}):
            cleanup.finish_turn(session_id='unrelated', turn_id='first')
            cleanup.finish_turn(session_id='session', turn_id='first')
            cleanup.finish_turn(session_id='session', turn_id='first')
            self.assertEqual(calls, [(cleanup.TOOL, {'action': 'close', 'handle': first, 'kakao_only': True})])
            cleanup.finish_turn(session_id='session', turn_id='second')
        self.assertEqual([args['handle'] for _, args in calls], [first, second])
        self.assertEqual(cleanup.owners, {})

    def test_unrelated_or_invalid_tool_output_cannot_register_cleanup(self):
        cleanup.after_tool(tool_name='other', args={'action':'open'}, result={'handle':str(uuid4())}, session_id='s',turn_id='t')
        cleanup.after_tool(tool_name=cleanup.TOOL, args={'action':'open'}, result={'handle':'not-owned'}, session_id='s',turn_id='t')
        self.assertEqual(cleanup.owners, {})

if __name__ == '__main__':
    unittest.main()
