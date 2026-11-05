"""Hermetic lifecycle tests for the exact native-adapter patch; never run a gateway."""
import ast
import os
import asyncio
from collections import deque
from dataclasses import dataclass
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import types
import unittest

HERE = Path(__file__).resolve().parent
BASELINE = Path(os.environ['VILLAGE_RUNTIME_ROOT']) / 'hermes-root/profiles/kakaoworker/plugins/kakao_village/adapter.py'
RELATIVE = Path('hermes-root/profiles/kakaoworker/plugins/kakao_village/adapter.py')


def patched_source():
    source = BASELINE.read_bytes()
    if b'def _claim_capacity_available' in source:
        return source.decode()
    with tempfile.TemporaryDirectory() as temporary:
        target = Path(temporary) / RELATIVE
        target.parent.mkdir(parents=True)
        target.write_bytes(source)
        result = subprocess.run(['/usr/bin/patch', '-p1', '--batch'], cwd=temporary,
                                input=(HERE / 'native-adapter-concurrency.patch').read_bytes(), capture_output=True)
        if result.returncode:
            raise AssertionError(result.stdout.decode() + result.stderr.decode())
        return target.read_text()


class BridgeClientError(Exception):
    pass


@dataclass
class Event:
    job_id: str
    room_key: str
    room_revision: int = 1
    lease_id: str = 'lease-1'
    prompt: str = 'synthetic prompt'
    detected_at: str = '2026-11-05T01:00:00Z'

    @property
    def raw(self):
        return {'job_id': self.job_id, 'room_key': self.room_key, 'room_revision': self.room_revision}


class FakeBridge:
    def __init__(self, events=()):
        self.events = deque(events)
        self.claims = 0
        self.block = None

    def claim(self, *_):
        self.claims += 1
        if self.block is not None:
            self.block.wait(2)
        value = self.events.popleft() if self.events else None
        if isinstance(value, Exception):
            raise value
        return value

    def renew(self, *_):
        return None


class Owner:
    def __init__(self, limit):
        self.config = {'max_concurrent_sessions': limit}
        self.running = 0

    async def handler(self, _):
        pass

    def _running_agent_count(self):
        return self.running


class FakeBase:
    def __init__(self, config, platform):
        self.config = config
        self._active_sessions = {}
        self._session_tasks = {}
        self.finish = {}
        self.cleanup = {}
        self.fail_dispatch = False
        self._message_handler = Owner(2).handler

    def build_source(self, **kwargs):
        return types.SimpleNamespace(**kwargs)

    async def handle_message(self, event):
        if self.fail_dispatch:
            raise RuntimeError('synthetic dispatch failure')
        key = event.source.chat_id
        gate = self.finish.setdefault(event.message_id, asyncio.Event())
        cleanup = self.cleanup.setdefault(event.message_id, asyncio.Event())
        guard = asyncio.Event()
        self._active_sessions[key] = guard

        async def turn():
            try:
                await gate.wait()
            finally:
                await cleanup.wait()
                if self._session_tasks.get(key) is asyncio.current_task():
                    self._session_tasks.pop(key, None)
                if self._active_sessions.get(key) is guard:
                    self._active_sessions.pop(key, None)

        self._session_tasks[key] = asyncio.create_task(turn())

    async def cancel_session_processing(self, key, release_guard=False):
        self._session_tasks[key].cancel()
        await asyncio.sleep(0)

    def _release_session_guard(self, key, guard=None):
        if self._active_sessions.get(key) is guard:
            self._active_sessions.pop(key, None)


def load_adapter():
    module = types.ModuleType('_village_staged_adapter_test')
    sys.modules[module.__name__] = module
    module.__dict__.update(BasePlatformAdapter=FakeBase, Platform=lambda name: name,
                           MessageEvent=lambda **kw: types.SimpleNamespace(**kw),
                           MessageType=types.SimpleNamespace(TEXT='text'),
                           GatewayEvent=Event, BridgeClientError=BridgeClientError,
                           build_session_key=lambda source, **_: source.chat_id,
                           ACTIVE_TURN_FENCE=types.SimpleNamespace(set=lambda _: None))
    tree = ast.parse(patched_source())
    tree.body = [node for node in tree.body if not (isinstance(node, ast.ImportFrom)
                  and (node.level or (node.module or '').startswith('gateway')))]
    exec(compile(tree, 'staged-native-adapter.py', 'exec'), module.__dict__)
    return module.KakaoVillageAdapter


def resolve_limit(config):
    if not config:
        return None
    value = config.get('max_concurrent_sessions', config.get('gateway', {}).get('max_concurrent_sessions'))
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


ACTIVE_SESSIONS = types.ModuleType('hermes_cli.active_sessions')
ACTIVE_SESSIONS.resolve_max_concurrent_sessions = resolve_limit
sys.modules['hermes_cli.active_sessions'] = ACTIVE_SESSIONS
ADAPTER = load_adapter()


class NativeClaimCapacity(unittest.IsolatedAsyncioTestCase):
    def make(self, events, cap=2):
        bridge = FakeBridge(events)
        adapter = ADAPTER(types.SimpleNamespace(extra={}), bridge_client=bridge)
        owner = Owner(cap)
        adapter._message_handler = owner.handler
        return adapter, bridge, owner

    async def tick(self):
        for _ in range(6):
            await asyncio.sleep(0)

    async def finish_all(self, adapter):
        for gate in [*adapter.finish.values(), *adapter.cleanup.values()]:
            gate.set()
        await self.tick()
        pending = [task for _, task in adapter._pending_claim_handoffs.values()]
        native = list(adapter._session_tasks.values())
        if pending or native:
            await asyncio.gather(*pending, *native, return_exceptions=True)
        await self.tick()

    async def test_saturation_does_not_claim_or_consume_retry_attempts(self):
        adapter, bridge, _ = self.make([Event('one', 'one'), Event('two', 'two'), Event('three', 'three')])
        try:
            self.assertTrue(await adapter._poll_once())
            self.assertTrue(await adapter._poll_once())
            for _ in range(20):
                self.assertFalse(await adapter._poll_once())
            self.assertEqual(bridge.claims, 2)
            self.assertEqual(len(bridge.events), 1)
            adapter.finish['one'].set(); adapter.cleanup['one'].set()
            await self.tick()
            self.assertTrue(await adapter._poll_once())
            self.assertEqual(bridge.claims, 3)
        finally:
            await self.finish_all(adapter)

    async def test_reservation_is_taken_before_awaiting_bridge_claim(self):
        adapter, bridge, _ = self.make([Event('one', 'one')], cap=1)
        bridge.block = threading.Event()
        first = asyncio.create_task(adapter._poll_once())
        try:
            await self.tick()
            self.assertFalse(await adapter._poll_once())
            self.assertEqual(bridge.claims, 1)
            bridge.block.set()
            self.assertTrue(await first)
        finally:
            bridge.block.set()
            await self.finish_all(adapter)

    async def test_empty_claim_and_transport_error_release_reserved_capacity(self):
        for value in [None, BridgeClientError('offline'), object()]:
            adapter, bridge, _ = self.make([value, Event('next', 'next')], cap=1)
            try:
                if value is None:
                    self.assertFalse(await adapter._poll_once())
                else:
                    with self.assertRaises(BridgeClientError):
                        await adapter._poll_once()
                self.assertEqual(adapter._claim_reservations, 0)
                self.assertTrue(await adapter._poll_once())
            finally:
                await self.finish_all(adapter)

    async def test_dispatch_exception_releases_slot_without_marking_work_complete(self):
        adapter, bridge, _ = self.make([Event('bad', 'bad'), Event('next', 'next')], cap=1)
        adapter.fail_dispatch = True
        try:
            with self.assertRaisesRegex(RuntimeError, 'dispatch failure'):
                await adapter._poll_once()
            self.assertEqual(len(adapter._leased_claims), 0)
            adapter.fail_dispatch = False
            self.assertTrue(await adapter._poll_once())
        finally:
            await self.finish_all(adapter)

    async def test_slot_is_retained_through_native_cleanup(self):
        adapter, bridge, _ = self.make([Event('one', 'one'), Event('two', 'two')], cap=1)
        try:
            await adapter._poll_once()
            adapter.finish['one'].set()
            await self.tick()
            self.assertFalse(await adapter._poll_once())
            self.assertEqual(bridge.claims, 1)
            adapter.cleanup['one'].set()
            await self.tick()
            self.assertTrue(await adapter._poll_once())
        finally:
            await self.finish_all(adapter)

    async def test_pending_handoff_retains_slot_until_its_subsequent_native_turn_finishes(self):
        adapter, bridge, _ = self.make([Event('old', 'same'), Event('new', 'same', 2, 'lease-2'), Event('other', 'other')], cap=2)
        try:
            await adapter._poll_once()
            await self.tick()  # start the first task so its cancellation executes cleanup
            await adapter._poll_once()
            self.assertEqual(len(adapter._leased_claims), 2)
            self.assertIn('same', adapter._pending_claim_handoffs)
            self.assertFalse(await adapter._poll_once())
            adapter.cleanup['old'].set()
            for _ in range(100):
                await asyncio.sleep(.001)
                if 'new' in adapter.finish:
                    break
            self.assertIn('new', adapter.finish)
            self.assertEqual(len(adapter._leased_claims), 1)
            self.assertTrue(await adapter._poll_once())
            self.assertFalse(await adapter._poll_once())
            adapter.finish['new'].set(); adapter.cleanup['new'].set()
            await self.tick()
            self.assertEqual(len(adapter._leased_claims), 1)
        finally:
            await self.finish_all(adapter)

    async def test_cancelled_pending_handoff_releases_its_capacity(self):
        adapter, bridge, _ = self.make([Event('old', 'same'), Event('new', 'same', 2, 'lease-2')], cap=2)
        try:
            await adapter._poll_once(); await self.tick()
            await adapter._poll_once()
            await adapter._stop_pending_claim_handoffs()
            await self.tick()
            self.assertEqual(len(adapter._leased_claims), 1)
        finally:
            await self.finish_all(adapter)

    async def test_existing_gateway_cap_includes_other_native_running_sessions(self):
        adapter, bridge, owner = self.make([Event('one', 'one')], cap=2)
        owner.running = 2
        self.assertFalse(await adapter._poll_once())
        self.assertEqual(bridge.claims, 0)
        owner.running = 1
        try:
            self.assertTrue(await adapter._poll_once())
        finally:
            await self.finish_all(adapter)

    async def test_disabled_cap_preserves_existing_unlimited_behavior_and_stop_never_claims(self):
        adapter, bridge, _ = self.make([Event(str(i), str(i)) for i in range(3)], cap=None)
        try:
            for _ in range(3):
                self.assertTrue(await adapter._poll_once())
            adapter._stop_requested.set()
            self.assertFalse(await adapter._poll_once())
            self.assertEqual(bridge.claims, 3)
        finally:
            await self.finish_all(adapter)


if __name__ == '__main__':
    unittest.main()
