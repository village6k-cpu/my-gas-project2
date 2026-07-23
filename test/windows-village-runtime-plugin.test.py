import concurrent.futures
import importlib.util
import json
import os
import pathlib
import tempfile
import threading
import time
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
        self.hermes_env = mock.patch.dict(os.environ, {"HERMES_HOME": ""})
        self.hermes_env.start()
        self.plugin = load_plugin()

    def tearDown(self):
        self.hermes_env.stop()

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

    def test_broker_timeout_uses_the_child_policy_marker_for_a_direct_read(self):
        timeout = self.plugin.subprocess.TimeoutExpired(
            cmd=["node.exe", "broker.js"],
            timeout=300,
            stderr=b"VILLAGE_EXECUTION_POLICY:read_only\n",
        )
        with (
            mock.patch.object(self.plugin, "_node_path", return_value="node.exe"),
            mock.patch.object(self.plugin, "_broker_path", return_value=pathlib.Path("broker.js")),
            mock.patch.object(self.plugin.subprocess, "run", side_effect=timeout),
        ):
            result = self.plugin._run_broker(
                {"phase": "execute", "capability": "inventory.lookup"}
            )
        self.assertEqual(result["status"], "READ_FAILED")
        self.assertEqual(result["policy"], "read_only")
        self.assertFalse(result["mutationMayHaveOccurred"])

    def test_non_object_broker_output_preserves_the_direct_read_policy(self):
        completed = mock.Mock(
            returncode=0,
            stdout="[]",
            stderr="VILLAGE_EXECUTION_POLICY:read_only\n",
        )
        with (
            mock.patch.object(self.plugin, "_node_path", return_value="node.exe"),
            mock.patch.object(self.plugin, "_broker_path", return_value=pathlib.Path("broker.js")),
            mock.patch.object(self.plugin.subprocess, "run", return_value=completed),
        ):
            result = self.plugin._run_broker(
                {"phase": "execute", "capability": "schedule.timeline"}
            )
        self.assertEqual(result["status"], "READ_FAILED")
        self.assertEqual(result["policy"], "read_only")
        self.assertFalse(result["mutationMayHaveOccurred"])

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

        for tool_name in ("village_operation", "vision_analyze", "clarify", "session_search"):
            self.assertIsNone(
                self.plugin._on_pre_tool_call(tool_name=tool_name, args={}, session_id="session-a"),
                tool_name,
            )
        self.assertEqual(
            self.plugin._on_pre_tool_call(
                tool_name="skill_manage",
                args={"action": "create", "name": "unsafe-live-mutation"},
                session_id="session-a",
            )["action"],
            "block",
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
        with mock.patch.object(
            self.plugin, "_run_broker", return_value=json.loads(completed.stdout)
        ) as broker:
            self.plugin._handle_village_operation(
                {
                    "phase": "prepare",
                    "capability": "new.operation",
                    "parameters": {},
                    "authorization": {"ownerApproved": True},
                },
                session_id="session-new",
            )

            premature_complete = json.loads(
                self.plugin._handle_village_operation(
                    {"phase": "complete", "capability": "new.operation"},
                    session_id="session-new",
                )
            )

        state = self.plugin._ACTIVE_LIVE_OPERATIONS["session-new"]
        self.assertEqual(state["mode"], "discover")
        self.assertEqual(premature_complete["status"], "INCOMPLETE_LIFECYCLE")
        self.assertEqual(broker.call_count, 1)
        for tool_name in ("read_file", "search_files"):
            self.assertIsNone(
                self.plugin._on_pre_tool_call(tool_name=tool_name, args={}, session_id="session-new"),
                tool_name,
            )
        skill_mutation = self.plugin._on_pre_tool_call(
            tool_name="skill_manage",
            args={"action": "create", "name": "new-operation"},
            session_id="session-new",
        )
        self.assertEqual(skill_mutation["action"], "block")
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

    def test_active_lifecycle_cannot_switch_capability_or_escape_through_another_phase(self):
        responses = [
            {"ok": False, "status": "CAPABILITY_GAP", "mustResumeOriginalRequest": True},
            {"ok": True, "capability": "inventory.lookup"},
        ]
        with mock.patch.object(self.plugin, "_run_broker", side_effect=responses) as broker:
            self.plugin._handle_village_operation(
                {
                    "phase": "prepare",
                    "capability": "new.operation",
                    "parameters": {},
                    "authorization": {"ownerApproved": True},
                },
                session_id="session-bound",
            )
            switched = json.loads(
                self.plugin._handle_village_operation(
                    {
                        "phase": "execute",
                        "capability": "inventory.lookup",
                        "parameters": {"query": "camera"},
                    },
                    session_id="session-bound",
                )
            )

        self.assertEqual(switched["status"], "LIFECYCLE_MISMATCH")
        self.assertEqual(broker.call_count, 1)
        state = self.plugin._ACTIVE_LIVE_OPERATIONS["session-bound"]
        self.assertEqual(state["mode"], "discover")
        self.assertEqual(state["capability"], "new.operation")

        for mode in (
            "discover",
            "tested",
            "promoted",
            "confirmation_pending",
            "promotion_failed",
            "resume",
            "execute",
            "executing",
            "uncertain_write",
        ):
            self.plugin._ACTIVE_LIVE_OPERATIONS["session-bound"] = {
                "mode": mode,
                "capability": "new.operation",
            }
            decision = self.plugin._on_pre_tool_call(
                tool_name="skill_manage",
                args={"action": "create", "name": "escape"},
                session_id="session-bound",
            )
            self.assertEqual(decision["action"], "block", mode)
            for escape_tool in ("delegate_task", "cronjob", "web_search"):
                decision = self.plugin._on_pre_tool_call(
                    tool_name=escape_tool,
                    args={"task": "continue elsewhere"},
                    session_id="session-bound",
                )
                self.assertEqual(decision["action"], "block", (mode, escape_tool))

    def test_uncertain_execute_cannot_be_retried_without_reconciliation_and_fresh_approval(self):
        responses = [
            {"ok": True, "ready": True, "policy": "internal_write"},
            {"ok": False, "status": "BROKER_ERROR", "error": "timeout"},
            {
                "ok": True,
                "reconciliation": True,
                "reconciliationOutcome": "not_applied",
                "result": {"items": []},
            },
            {"ok": True, "verified": True},
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

            fabricated = json.loads(
                self.plugin._handle_village_operation(
                    {
                        "phase": "execute",
                        "capability": "payment.update_method",
                        "parameters": {"tid": "260723-010", "method": "card"},
                        "authorization": {
                            "ownerApproved": True,
                            "retryAfterReconciliationApproved": True,
                        },
                        "reconciliationEvidence": {
                            "reconciliationId": "fabricated",
                            "originalCapability": "payment.update_method",
                        },
                    },
                    session_id="session-write",
                )
            )
            fabricated_complete = json.loads(
                self.plugin._handle_village_operation(
                    {
                        "phase": "complete",
                        "capability": "payment.update_method",
                        "reconciliationEvidence": {
                            "reconciliationId": "fabricated",
                            "originalCapability": "payment.update_method",
                        },
                    },
                    session_id="session-write",
                )
            )
            reconciled = json.loads(
                self.plugin._handle_village_operation(
                    {
                        "phase": "reconcile",
                        "capability": "finance.lookup",
                        "parameters": {"query": "260723-010"},
                    },
                    session_id="session-write",
                )
            )
            changed_target = json.loads(
                self.plugin._handle_village_operation(
                    {
                        "phase": "execute",
                        "capability": "payment.update_method",
                        "parameters": {"tid": "different-trade", "method": "cash"},
                        "authorization": {
                            "ownerApproved": True,
                            "retryAfterReconciliationApproved": True,
                        },
                        "reconciliationEvidence": {
                            "reconciliationId": reconciled["reconciliationId"],
                            "originalCapability": reconciled["originalCapability"],
                        },
                    },
                    session_id="session-write",
                )
            )
            retried = json.loads(
                self.plugin._handle_village_operation(
                    {
                        "phase": "execute",
                        "capability": "payment.update_method",
                        "parameters": {"tid": "260723-010", "method": "card"},
                        "authorization": {
                            "ownerApproved": True,
                            "retryAfterReconciliationApproved": True,
                        },
                        "reconciliationEvidence": {
                            "reconciliationId": reconciled["reconciliationId"],
                            "originalCapability": reconciled["originalCapability"],
                        },
                    },
                    session_id="session-write",
                )
            )

        self.assertEqual(failed["status"], "BROKER_ERROR")
        self.assertEqual(blocked["status"], "RETRY_BLOCKED")
        self.assertFalse(blocked["retryAllowed"])
        self.assertEqual(fabricated["status"], "RETRY_BLOCKED")
        self.assertEqual(fabricated_complete["status"], "RECONCILIATION_REQUIRED")
        self.assertTrue(reconciled["reconciliationId"])
        self.assertEqual(reconciled["originalCapability"], "payment.update_method")
        self.assertEqual(changed_target["status"], "RETRY_BLOCKED")
        self.assertTrue(retried["ok"])
        self.assertEqual(broker.call_count, 4)
        self.assertNotIn("session-write", self.plugin._ACTIVE_LIVE_OPERATIONS)

        replayed = json.loads(
            self.plugin._handle_village_operation(
                {
                    "phase": "execute",
                    "capability": "payment.update_method",
                    "parameters": {"tid": "260723-010", "method": "card"},
                    "authorization": {
                        "ownerApproved": True,
                        "retryAfterReconciliationApproved": True,
                    },
                    "reconciliationEvidence": {
                        "reconciliationId": reconciled["reconciliationId"],
                        "originalCapability": reconciled["originalCapability"],
                    },
                },
                session_id="session-write",
            )
        )
        self.assertEqual(replayed["status"], "RETRY_BLOCKED")
        self.assertEqual(broker.call_count, 4)

    def test_one_reconciliation_receipt_can_reach_only_one_concurrent_retry(self):
        reconciliation_id = "7b46aa5c-293c-4850-a10b-ce4163226265"
        self.plugin._ACTIVE_LIVE_OPERATIONS["session-race"] = {
            "mode": "uncertain_write",
            "capability": "payment.update_method",
            "originalRequest": {
                "capability": "payment.update_method",
                "parameters": {"tid": "260723-010", "method": "card"},
            },
            "lastReconciliation": {
                "reconciliationId": reconciliation_id,
                "reconciledAt": time.time(),
                "result": {"reconciliationOutcome": "not_applied"},
            },
        }
        entered = threading.Event()
        release = threading.Event()
        calls = []

        def broker(_args):
            calls.append(1)
            entered.set()
            release.wait(timeout=2)
            return {"ok": True, "verified": True}

        request = {
            "phase": "execute",
            "capability": "payment.update_method",
            "parameters": {"tid": "260723-010", "method": "card"},
            "authorization": {
                "ownerApproved": True,
                "retryAfterReconciliationApproved": True,
            },
            "reconciliationEvidence": {
                "reconciliationId": reconciliation_id,
                "originalCapability": "payment.update_method",
            },
        }
        barrier = threading.Barrier(2)

        def invoke():
            barrier.wait(timeout=2)
            return json.loads(
                self.plugin._handle_village_operation(
                    request,
                    session_id="session-race",
                )
            )

        with (
            mock.patch.object(self.plugin, "_run_broker", side_effect=broker),
            concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor,
        ):
            futures = [executor.submit(invoke) for _ in range(2)]
            self.assertTrue(entered.wait(timeout=2))
            release.set()
            results = [future.result(timeout=2) for future in futures]

        self.assertEqual(len(calls), 1)
        self.assertEqual(sum(result.get("ok") is True for result in results), 1)
        self.assertEqual(
            sum(result.get("status") in {"RETRY_BLOCKED", "OPERATION_IN_PROGRESS"} for result in results),
            1,
        )

    def test_reconciliation_outcome_separates_complete_from_retry(self):
        reconciliation_id = "d2099d64-b33a-4912-9630-e41624e59040"
        state = {
            "mode": "uncertain_write",
            "capability": "payment.update_method",
            "lastReconciliation": {
                "reconciliationId": reconciliation_id,
                "reconciledAt": time.time(),
                "result": {"reconciliationOutcome": "not_applied"},
            },
        }
        self.plugin._ACTIVE_LIVE_OPERATIONS["session-outcome"] = state
        evidence = {
            "reconciliationId": reconciliation_id,
            "originalCapability": "payment.update_method",
        }
        with mock.patch.object(self.plugin, "_run_broker", return_value={"ok": True}) as broker:
            wrong_outcome = json.loads(
                self.plugin._handle_village_operation(
                    {
                        "phase": "complete",
                        "capability": "payment.update_method",
                        "reconciliationEvidence": evidence,
                    },
                    session_id="session-outcome",
                )
            )
            self.assertEqual(wrong_outcome["status"], "RECONCILIATION_REQUIRED")
            self.assertEqual(broker.call_count, 0)

            state["lastReconciliation"]["result"]["reconciliationOutcome"] = "already_applied"
            self.plugin._ACTIVE_LIVE_OPERATIONS["session-outcome"] = state
            completed = json.loads(
                self.plugin._handle_village_operation(
                    {
                        "phase": "complete",
                        "capability": "payment.update_method",
                        "reconciliationEvidence": evidence,
                    },
                    session_id="session-outcome",
                )
            )
            self.assertTrue(completed["ok"])
            self.assertEqual(broker.call_count, 1)
            self.assertNotIn("session-outcome", self.plugin._ACTIVE_LIVE_OPERATIONS)

    def test_read_only_failure_never_enters_uncertain_write(self):
        responses = [
            {"ok": True, "ready": True, "policy": "read_only"},
            {
                "ok": False,
                "status": "BROKER_ERROR",
                "mutationMayHaveOccurred": True,
                "error": "synthetic timeout",
            },
        ]
        with mock.patch.object(self.plugin, "_run_broker", side_effect=responses):
            self.plugin._handle_village_operation(
                {
                    "phase": "prepare",
                    "capability": "inventory.lookup",
                    "parameters": {"query": "camera"},
                },
                session_id="session-read",
            )
            failed = json.loads(
                self.plugin._handle_village_operation(
                    {
                        "phase": "execute",
                        "capability": "inventory.lookup",
                        "parameters": {"query": "camera"},
                    },
                    session_id="session-read",
                )
            )
        self.assertEqual(failed["status"], "BROKER_ERROR")
        self.assertNotIn("session-read", self.plugin._ACTIVE_LIVE_OPERATIONS)

    def test_generic_write_response_loss_reconciles_with_the_preserved_operation_receipt(self):
        observed = []

        def broker(args):
            observed.append(dict(args))
            if args["phase"] == "prepare":
                return {"ok": True, "ready": True, "policy": "internal_write"}
            if args["phase"] == "execute":
                return {
                    "ok": False,
                    "status": "WRITE_OUTCOME_UNCERTAIN",
                    "mutationMayHaveOccurred": True,
                }
            if args["phase"] == "reconcile":
                return {
                    "ok": True,
                    "reconciliation": True,
                    "reconciliationOutcome": "already_applied",
                    "result": {"status": "applied"},
                }
            if args["phase"] == "complete":
                return {"ok": True, "completed": True}
            raise AssertionError(args)

        with mock.patch.object(self.plugin, "_run_broker", side_effect=broker):
            self.plugin._handle_village_operation(
                {
                    "phase": "prepare",
                    "capability": "equipment.add",
                    "parameters": {"tid": "260723-010", "equipName": "FX3"},
                    "authorization": {"ownerApproved": True},
                },
                session_id="session-generic-receipt",
            )
            self.plugin._handle_village_operation(
                {
                    "phase": "execute",
                    "capability": "equipment.add",
                    "parameters": {"tid": "260723-010", "equipName": "FX3"},
                    "authorization": {"ownerApproved": True},
                },
                session_id="session-generic-receipt",
            )
            reconciled = json.loads(
                self.plugin._handle_village_operation(
                    {
                        "phase": "reconcile",
                        "capability": "operation.receipt",
                        "parameters": {},
                    },
                    session_id="session-generic-receipt",
                )
            )
            completed = json.loads(
                self.plugin._handle_village_operation(
                    {
                        "phase": "complete",
                        "capability": "equipment.add",
                        "reconciliationEvidence": {
                            "reconciliationId": reconciled["reconciliationId"],
                            "originalCapability": "equipment.add",
                        },
                    },
                    session_id="session-generic-receipt",
                )
            )

        execute_call = next(item for item in observed if item["phase"] == "execute")
        reconcile_call = next(item for item in observed if item["phase"] == "reconcile")
        self.assertRegex(execute_call["operationId"], r"^[a-f0-9-]+$")
        self.assertEqual(reconcile_call["originalOperationId"], execute_call["operationId"])
        self.assertEqual(reconcile_call["parameters"], {"operationId": execute_call["operationId"]})
        self.assertTrue(completed["ok"])
        self.assertNotIn("session-generic-receipt", self.plugin._ACTIVE_LIVE_OPERATIONS)

    def test_promotion_failure_must_roll_back_before_discovery_can_continue(self):
        responses = [
            {"ok": False, "status": "CAPABILITY_GAP", "mustResumeOriginalRequest": True},
            {"ok": True, "validated": True, "validationId": "validation-1"},
            {
                "ok": False,
                "status": "PROMOTION_RECOVERY_REQUIRED",
                "promotionId": "promotion-1",
                "capability": "interrupted.operation",
                "recoveryRequired": True,
            },
            {"ok": True, "rolledBack": True, "promotionId": "promotion-1"},
        ]
        with mock.patch.object(self.plugin, "_run_broker", side_effect=responses):
            original = {
                "phase": "prepare",
                "capability": "new.operation",
                "parameters": {"tradeId": "260723-010"},
                "authorization": {"ownerApproved": True},
            }
            self.plugin._handle_village_operation(original, session_id="session-recovery")
            self.plugin._handle_village_operation(
                {
                    "phase": "validate_candidate",
                    "capability": "new.operation",
                    "candidateRoot": "C:/Village/my-gas-project2",
                },
                session_id="session-recovery",
            )
            promoted = json.loads(
                self.plugin._handle_village_operation(
                    {
                        "phase": "promote",
                        "capability": "new.operation",
                        "validationId": "validation-1",
                        "authorization": {"ownerApproved": True, "systemAdminApproved": True},
                    },
                    session_id="session-recovery",
                )
            )
            self.assertTrue(promoted["recoveryRequired"])
            state = self.plugin._ACTIVE_LIVE_OPERATIONS["session-recovery"]
            self.assertEqual(state["mode"], "promotion_failed")
            self.assertEqual(state["capability"], "interrupted.operation")
            self.assertEqual(state["originalRequest"]["parameters"], {"tradeId": "260723-010"})

            rolled_back = json.loads(
                self.plugin._handle_village_operation(
                    {
                        "phase": "rollback_promotion",
                        "capability": "interrupted.operation",
                        "promotionId": "promotion-1",
                        "authorization": {"ownerApproved": True, "systemAdminApproved": True},
                    },
                    session_id="session-recovery",
                )
            )
            self.assertTrue(rolled_back["rolledBack"])
            state = self.plugin._ACTIVE_LIVE_OPERATIONS["session-recovery"]
            self.assertEqual(state["mode"], "discover")
            self.assertEqual(state["capability"], "new.operation")
            self.assertEqual(state["originalRequest"]["parameters"], {"tradeId": "260723-010"})

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

    def test_confirmation_mismatch_enters_recoverable_pending_state(self):
        responses = [
            {"ok": False, "status": "CAPABILITY_GAP", "mustResumeOriginalRequest": True},
            {"ok": True, "validated": True, "validationId": "validation-1"},
            {"ok": True, "promoted": True, "promotionId": "promotion-1"},
            {
                "ok": False,
                "confirmed": False,
                "status": "REGISTRATION_NOT_CONFIRMED",
                "promotionId": "promotion-1",
                "runtimeConfirmed": True,
                "liveCatalogConfirmed": False,
                "rollbackAvailable": True,
            },
        ]
        with mock.patch.object(self.plugin, "_run_broker", side_effect=responses):
            self.plugin._handle_village_operation(
                {"phase": "prepare", "capability": "new.operation", "parameters": {}},
                session_id="session-pending",
            )
            self.plugin._handle_village_operation(
                {"phase": "validate_candidate", "capability": "new.operation"},
                session_id="session-pending",
            )
            self.plugin._handle_village_operation(
                {
                    "phase": "promote",
                    "capability": "new.operation",
                    "validationId": "validation-1",
                    "authorization": {"ownerApproved": True, "systemAdminApproved": True},
                },
                session_id="session-pending",
            )
            result = json.loads(
                self.plugin._handle_village_operation(
                    {
                        "phase": "confirm_registration",
                        "capability": "new.operation",
                        "promotionId": "promotion-1",
                    },
                    session_id="session-pending",
                )
            )

        self.assertFalse(result["confirmed"])
        state = self.plugin._ACTIVE_LIVE_OPERATIONS["session-pending"]
        self.assertEqual(state["mode"], "confirmation_pending")
        nudge = self.plugin._on_pre_verify(session_id="session-pending")
        self.assertIn("rollback", nudge["message"].lower())

    def test_uncertain_operation_id_survives_plugin_restart_for_reconciliation(self):
        with tempfile.TemporaryDirectory() as hermes_home, mock.patch.dict(
            os.environ, {"HERMES_HOME": hermes_home}
        ):
            first = load_plugin()
            responses = [
                {"ok": True, "ready": True, "policy": "internal_write"},
                {
                    "ok": False,
                    "status": "WRITE_OUTCOME_UNCERTAIN",
                    "mutationMayHaveOccurred": True,
                },
            ]
            with mock.patch.object(first, "_run_broker", side_effect=responses):
                first._handle_village_operation(
                    {
                        "phase": "prepare",
                        "capability": "equipment.add",
                        "parameters": {"tid": "260723-010", "equipName": "FX3"},
                        "authorization": {"ownerApproved": True},
                    },
                    session_id="session-restart",
                )
                first._handle_village_operation(
                    {
                        "phase": "execute",
                        "capability": "equipment.add",
                        "parameters": {"tid": "260723-010", "equipName": "FX3"},
                        "authorization": {"ownerApproved": True},
                    },
                    session_id="session-restart",
                )
            old_operation_id = first._ACTIVE_LIVE_OPERATIONS["session-restart"]["operationId"]
            first._on_session_reset(session_id="session-restart")
            first._ACTIVE_LIVE_OPERATIONS.clear()

            restarted = load_plugin()
            observed = {}

            def reconcile(args):
                observed.update(args)
                return {
                    "ok": True,
                    "reconciliation": True,
                    "reconciliationOutcome": "already_applied",
                    "result": {"status": "applied"},
                }

            with mock.patch.object(restarted, "_run_broker", side_effect=reconcile):
                result = json.loads(
                    restarted._handle_village_operation(
                        {
                            "phase": "reconcile",
                            "capability": "operation.receipt",
                            "parameters": {},
                        },
                        session_id="session-restart",
                    )
                )

            self.assertTrue(result["ok"])
            self.assertEqual(observed["originalOperationId"], old_operation_id)
            self.assertEqual(observed["parameters"], {"operationId": old_operation_id})

    def test_process_loss_during_write_reloads_as_uncertain_not_executing(self):
        with tempfile.TemporaryDirectory() as hermes_home, mock.patch.dict(
            os.environ, {"HERMES_HOME": hermes_home}
        ):
            first = load_plugin()
            with mock.patch.object(
                first,
                "_run_broker",
                return_value={"ok": True, "ready": True, "policy": "internal_write"},
            ):
                first._handle_village_operation(
                    {
                        "phase": "prepare",
                        "capability": "equipment.add",
                        "parameters": {"tid": "260723-010", "equipName": "FX3"},
                        "authorization": {"ownerApproved": True},
                    },
                    session_id="session-crash",
                )
            with mock.patch.object(first, "_run_broker", side_effect=SystemExit("crash")):
                with self.assertRaises(SystemExit):
                    first._handle_village_operation(
                        {
                            "phase": "execute",
                            "capability": "equipment.add",
                            "parameters": {"tid": "260723-010", "equipName": "FX3"},
                            "authorization": {"ownerApproved": True},
                        },
                        session_id="session-crash",
                    )
            operation_id = first._ACTIVE_LIVE_OPERATIONS["session-crash"]["operationId"]

            restarted = load_plugin()
            durable = restarted._get_state("session-crash")
            self.assertEqual(durable["mode"], "uncertain_write")
            self.assertEqual(durable["operationId"], operation_id)
            observed = {}

            def reconcile(args):
                observed.update(args)
                return {
                    "ok": True,
                    "reconciliation": True,
                    "reconciliationOutcome": "already_applied",
                    "result": {"status": "applied"},
                }

            with mock.patch.object(restarted, "_run_broker", side_effect=reconcile):
                result = json.loads(
                    restarted._handle_village_operation(
                        {
                            "phase": "reconcile",
                            "capability": "operation.receipt",
                            "parameters": {},
                        },
                        session_id="session-crash",
                    )
                )
            self.assertTrue(result["ok"])
            self.assertEqual(observed["originalOperationId"], operation_id)

    def test_direct_read_process_loss_reloads_as_safe_retryable_read(self):
        with tempfile.TemporaryDirectory() as hermes_home, mock.patch.dict(
            os.environ, {"HERMES_HOME": hermes_home}
        ):
            first = load_plugin()
            catalog = {
                "ok": True,
                "capabilities": [
                    {"id": "schedule.timeline", "policy": "read_only"}
                ],
            }
            with mock.patch.object(
                first,
                "_run_broker",
                side_effect=[catalog, SystemExit("crash")],
            ):
                with self.assertRaises(SystemExit):
                    first._handle_village_operation(
                        {
                            "phase": "execute",
                            "capability": "schedule.timeline",
                            "parameters": {"date": "2026-07-23"},
                        },
                        session_id="session-direct-read-crash",
                    )

            restarted = load_plugin()
            durable = restarted._get_state("session-direct-read-crash")
            self.assertEqual(durable["mode"], "execute")
            self.assertEqual(durable["policy"], "read_only")
            self.assertFalse(durable["mutationMayHaveOccurred"])

            with mock.patch.object(
                restarted,
                "_run_broker",
                return_value={
                    "ok": True,
                    "policy": "read_only",
                    "result": {"events": []},
                    "mutationMayHaveOccurred": False,
                },
            ):
                result = json.loads(
                    restarted._handle_village_operation(
                        {
                            "phase": "execute",
                            "capability": "schedule.timeline",
                            "parameters": {"date": "2026-07-23"},
                        },
                        session_id="session-direct-read-crash",
                    )
                )

            self.assertTrue(result["ok"])
            self.assertEqual(
                restarted._get_state("session-direct-read-crash"), {}
            )

    def test_session_end_and_reset_preserve_unfinished_state(self):
        self.plugin._ACTIVE_LIVE_OPERATIONS["session-a"] = {"capability": "schedule.change_dates"}
        self.plugin._on_session_end(session_id="session-a")
        self.assertIn("session-a", self.plugin._ACTIVE_LIVE_OPERATIONS)
        self.plugin._on_session_reset(session_id="session-a")
        self.assertIn("session-a", self.plugin._ACTIVE_LIVE_OPERATIONS)


if __name__ == "__main__":
    unittest.main()
