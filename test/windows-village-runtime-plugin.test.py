import importlib.util
import json
import pathlib
import unittest
from unittest import mock


PLUGIN_PATH = (
    pathlib.Path(__file__).resolve().parents[1]
    / "scripts"
    / "windows"
    / "hermes-profile-overlay"
    / "plugins"
    / "village-runtime"
    / "__init__.py"
)


def load_plugin():
    spec = importlib.util.spec_from_file_location("village_runtime_test", PLUGIN_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class VillageRuntimePluginTest(unittest.TestCase):
    def setUp(self):
        self.plugin = load_plugin()

    def test_prepare_activates_only_the_current_live_operation_session(self):
        completed = mock.Mock(returncode=0, stdout='{"ok":true,"ready":true}', stderr="")
        with mock.patch.object(self.plugin, "_run_broker", return_value=json.loads(completed.stdout)):
            result = json.loads(
                self.plugin._handle_village_operation(
                    {
                        "phase": "prepare",
                        "capability": "schedule.change_dates",
                        "parameters": {"tradeId": "260723-010"},
                        "authorization": {"ownerApproved": True},
                    },
                    session_id="session-a",
                )
            )
        self.assertTrue(result["ok"])
        self.assertIn("session-a", self.plugin._ACTIVE_LIVE_OPERATIONS)
        self.assertEqual(self.plugin._ACTIVE_LIVE_OPERATIONS["session-a"]["mode"], "execute")
        self.assertNotIn("session-b", self.plugin._ACTIVE_LIVE_OPERATIONS)

    def test_nonzero_broker_exit_preserves_structured_uncertain_write_result(self):
        completed = mock.Mock(
            returncode=2,
            stdout='{"ok":false,"status":"UNVERIFIED_WRITE","mutationMayHaveOccurred":true,"retryAllowed":false}',
            stderr="",
        )
        with (
            mock.patch.object(self.plugin, "_node_path", return_value="node.exe"),
            mock.patch.object(self.plugin, "_broker_path", return_value=pathlib.Path("broker.js")),
            mock.patch.object(self.plugin.subprocess, "run", return_value=completed),
        ):
            result = self.plugin._run_broker({"phase": "execute"})
        self.assertEqual(result["status"], "UNVERIFIED_WRITE")
        self.assertTrue(result["mutationMayHaveOccurred"])
        self.assertFalse(result["retryAllowed"])

    def test_active_operation_blocks_live_source_archaeology_but_keeps_ai_and_learning_tools(self):
        self.plugin._ACTIVE_LIVE_OPERATIONS["session-a"] = {
            "mode": "execute",
            "capability": "schedule.change_dates",
        }
        for tool_name in (
            "terminal",
            "execute_code",
            "read_file",
            "search_files",
            "browser_navigate",
            "browser_console",
            "computer_use",
            "write_file",
            "patch",
        ):
            decision = self.plugin._on_pre_tool_call(tool_name=tool_name, args={}, session_id="session-a")
            self.assertEqual(decision["action"], "block", tool_name)
            self.assertIn("village_operation", decision["message"])

        for tool_name in ("village_operation", "vision_analyze", "clarify", "session_search", "skill_manage"):
            self.assertIsNone(
                self.plugin._on_pre_tool_call(tool_name=tool_name, args={}, session_id="session-a"),
                tool_name,
            )
        self.assertIsNone(
            self.plugin._on_pre_tool_call(tool_name="terminal", args={}, session_id="session-b")
        )

    def test_capability_gap_enters_discovery_and_must_resume_instead_of_giving_up(self):
        completed = mock.Mock(
            returncode=0,
            stdout=(
                '{"ok":false,"ready":false,"status":"CAPABILITY_GAP",'
                '"mustResumeOriginalRequest":true}'
            ),
            stderr="",
        )
        with mock.patch.object(self.plugin, "_run_broker", return_value=json.loads(completed.stdout)):
            self.plugin._handle_village_operation(
                {
                    "phase": "prepare",
                    "capability": "new.operation",
                    "parameters": {},
                    "authorization": {"ownerApproved": True},
                },
                session_id="session-new",
            )

        state = self.plugin._ACTIVE_LIVE_OPERATIONS["session-new"]
        self.assertEqual(state["mode"], "discover")
        for tool_name in ("read_file", "search_files", "skill_manage"):
            self.assertIsNone(
                self.plugin._on_pre_tool_call(tool_name=tool_name, args={}, session_id="session-new"),
                tool_name,
            )
        for tool_name in ("write_file", "patch"):
            self.assertIsNone(
                self.plugin._on_pre_tool_call(
                    tool_name=tool_name,
                    args={"path": "C:/Village/my-gas-project2/scripts/windows/new-capability.js"},
                    session_id="session-new",
                ),
                tool_name,
            )

        safe_terminal = self.plugin._on_pre_tool_call(
            tool_name="terminal",
            args={"command": "git diff --check"},
            session_id="session-new",
        )
        self.assertIsNone(safe_terminal)
        unsafe_terminal = self.plugin._on_pre_tool_call(
            tool_name="terminal",
            args={"command": "curl https://script.google.com/macros/s/live/exec"},
            session_id="session-new",
        )
        self.assertEqual(unsafe_terminal["action"], "block")
        self.assertIn("development", unsafe_terminal["message"].lower())
        indirect_network = self.plugin._on_pre_tool_call(
            tool_name="terminal",
            args={"command": "node scripts/windows/discover-and-call-live.js"},
            session_id="session-new",
        )
        self.assertEqual(indirect_network["action"], "block")
        for tool_name in ("execute_code", "browser_navigate", "web_extract", "computer_use"):
            decision = self.plugin._on_pre_tool_call(
                tool_name=tool_name,
                args={"url": "https://script.google.com/macros/s/live/exec"},
                session_id="session-new",
            )
            self.assertEqual(decision["action"], "block", tool_name)

        nudge = self.plugin._on_pre_verify(session_id="session-new")
        self.assertEqual(nudge["action"], "continue")
        self.assertIn("resume", nudge["message"].lower())

    def test_uncertain_execute_cannot_be_retried_without_reconciliation_and_fresh_approval(self):
        responses = [
            {"ok": True, "ready": True, "policy": "internal_write"},
            {"ok": False, "status": "BROKER_ERROR", "error": "timeout"},
        ]
        with mock.patch.object(self.plugin, "_run_broker", side_effect=responses) as broker:
            self.plugin._handle_village_operation(
                {
                    "phase": "prepare",
                    "capability": "payment.update_method",
                    "parameters": {"tid": "260723-010", "method": "card"},
                    "authorization": {"ownerApproved": True},
                },
                session_id="session-write",
            )
            failed = json.loads(
                self.plugin._handle_village_operation(
                    {
                        "phase": "execute",
                        "capability": "payment.update_method",
                        "parameters": {"tid": "260723-010", "method": "card"},
                        "authorization": {"ownerApproved": True},
                    },
                    session_id="session-write",
                )
            )
            blocked = json.loads(
                self.plugin._handle_village_operation(
                    {
                        "phase": "execute",
                        "capability": "payment.update_method",
                        "parameters": {"tid": "260723-010", "method": "card"},
                        "authorization": {"ownerApproved": True},
                    },
                    session_id="session-write",
                )
            )

        self.assertEqual(failed["status"], "BROKER_ERROR")
        self.assertEqual(blocked["status"], "RETRY_BLOCKED")
        self.assertFalse(blocked["retryAllowed"])
        self.assertEqual(broker.call_count, 2)
        state = self.plugin._ACTIVE_LIVE_OPERATIONS["session-write"]
        self.assertEqual(state["mode"], "uncertain_write")
        nudge = self.plugin._on_pre_verify(session_id="session-write")
        self.assertNotIn("phase=execute", nudge["message"])
        self.assertIn("reconcil", nudge["message"].lower())

    def test_gap_must_validate_promote_confirm_then_resume_the_original_request(self):
        responses = [
            {"ok": False, "status": "CAPABILITY_GAP", "mustResumeOriginalRequest": True},
            {"ok": True, "validated": True, "validationId": "validation-1"},
            {"ok": True, "promoted": True, "promotionId": "promotion-1"},
            {"ok": True, "confirmed": True, "runtimeConfirmed": True, "liveCatalogConfirmed": True},
            {"ok": True, "ready": True, "policy": "internal_write"},
        ]
        with mock.patch.object(self.plugin, "_run_broker", side_effect=responses):
            original = {
                "phase": "prepare",
                "capability": "new.operation",
                "parameters": {"tradeId": "260723-010"},
                "authorization": {"ownerApproved": True},
            }
            self.plugin._handle_village_operation(original, session_id="session-new")
            self.assertEqual(self.plugin._ACTIVE_LIVE_OPERATIONS["session-new"]["mode"], "discover")
            self.assertEqual(
                self.plugin._ACTIVE_LIVE_OPERATIONS["session-new"]["originalRequest"]["parameters"],
                {"tradeId": "260723-010"},
            )

            self.plugin._handle_village_operation(
                {"phase": "validate_candidate", "capability": "new.operation", "candidateRoot": "C:/Village/my-gas-project2"},
                session_id="session-new",
            )
            self.assertEqual(self.plugin._ACTIVE_LIVE_OPERATIONS["session-new"]["mode"], "tested")
            self.plugin._handle_village_operation(
                {
                    "phase": "promote",
                    "capability": "new.operation",
                    "validationId": "validation-1",
                    "authorization": {"ownerApproved": True, "systemAdminApproved": True},
                },
                session_id="session-new",
            )
            self.assertEqual(self.plugin._ACTIVE_LIVE_OPERATIONS["session-new"]["mode"], "promoted")
            self.plugin._handle_village_operation(
                {"phase": "confirm_registration", "capability": "new.operation", "promotionId": "promotion-1"},
                session_id="session-new",
            )
            self.assertEqual(self.plugin._ACTIVE_LIVE_OPERATIONS["session-new"]["mode"], "resume")
            self.plugin._handle_village_operation(original, session_id="session-new")
            self.assertEqual(self.plugin._ACTIVE_LIVE_OPERATIONS["session-new"]["mode"], "execute")

    def test_session_end_clears_the_boundary(self):
        self.plugin._ACTIVE_LIVE_OPERATIONS["session-a"] = {"capability": "schedule.change_dates"}
        self.plugin._on_session_end(session_id="session-a")
        self.assertNotIn("session-a", self.plugin._ACTIVE_LIVE_OPERATIONS)


if __name__ == "__main__":
    unittest.main()
