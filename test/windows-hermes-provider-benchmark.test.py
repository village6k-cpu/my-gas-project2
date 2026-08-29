from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
RUNNER_PATH = ROOT / "scripts" / "windows" / "hermes-kakao-provider-benchmark.py"


def load_runner():
    spec = importlib.util.spec_from_file_location("hermes_kakao_provider_benchmark", RUNNER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {RUNNER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ProviderBenchmarkContractTests(unittest.TestCase):
    def test_provider_backed_evidence_requires_twenty_proven_calls_per_arm(self):
        runner = load_runner()
        common = {
            "provider": "xai-oauth",
            "model": "grok-4.5",
            "reasoning_effort": "xhigh",
            "max_turns": 90,
            "disabled_toolsets": ["computer_use"],
            "tools_signature": "tools-sha",
            "skills_signature": "skills-sha",
        }
        baseline = [
            {"total_ms": 1000 + index, "provider_calls": 1, "process_starts": 1}
            for index in range(20)
        ]
        gateway = [
            {
                "total_ms": 500 + index,
                "agent_ms": 450 + index,
                "provider_calls": 1,
                "process_starts": 0,
                "post_action_agent_runs": 0,
                "session_reused": True,
                "schedule": index % 4 == 0,
                "owner_review_required": index % 4 == 0,
                "send_count": 0,
                "write_count": 0,
            }
            for index in range(20)
        ]

        evidence = runner.build_evidence(common, baseline, gateway)
        self.assertEqual(evidence["measurement_kind"], "provider_backed")
        self.assertEqual(evidence["baseline"]["sample_count"], 20)
        self.assertEqual(len(evidence["gateway"]["samples"]), 20)

        gateway[-1]["provider_calls"] = 0
        blocked = runner.build_evidence(common, baseline, gateway)
        self.assertEqual(blocked["measurement_kind"], "unproven_provider")

        with self.assertRaisesRegex(ValueError, "at least 20"):
            runner.build_evidence(common, baseline[:19], gateway)

    def test_loopback_bridge_serializes_claims_and_forces_schedule_owner_review(self):
        runner = load_runner()
        event = {
            "schema": "village-kakao-gateway-event/v1",
            "job_id": "benchmark-job-1",
            "room_key": "benchmark-room",
            "room_revision": 1,
            "prompt": "synthetic schedule prompt",
            "detected_at": "2099-01-01T00:00:00Z",
            "raw": {"scenario": "schedule", "synthetic": True},
            "lease_id": "10000000-0000-4000-8000-000000000001",
        }
        with runner.LoopbackBenchmarkBridge([event]) as bridge:
            headers = {"Authorization": f"Bearer {bridge.token}"}
            with urlopen(Request(f"{bridge.url}/hermes/v1/events?consumer_id=test&wait_ms=0", headers=headers)) as response:
                claimed = json.load(response)
            self.assertEqual(claimed["event"]["job_id"], "benchmark-job-1")

            confirmation = {
                "schema": "village-confirmation-request/v1",
                "job_id": "benchmark-job-1",
                "room_key": "benchmark-room",
                "room_revision": 1,
                "lease_id": event["lease_id"],
                "decision": {"should_write_to_sheet": False, "sheet_row_candidate": {}},
            }
            request = Request(
                f"{bridge.url}/hermes/v1/tools/confirmation-request",
                data=json.dumps(confirmation).encode("utf-8"),
                headers={**headers, "Content-Type": "application/json"},
                method="POST",
            )
            with urlopen(request) as response:
                receipt = json.load(response)
            self.assertEqual(receipt["status"], "owner_review_required")

            result = {
                "job_id": "benchmark-job-1",
                "room_key": "benchmark-room",
                "room_revision": 1,
                "lease_id": event["lease_id"],
                "content": "synthetic result",
            }
            request = Request(
                f"{bridge.url}/hermes/v1/results",
                data=json.dumps(result).encode("utf-8"),
                headers={**headers, "Content-Type": "application/json"},
                method="POST",
            )
            with urlopen(request) as response:
                self.assertTrue(json.load(response)["ok"])

            sample = bridge.wait_for_terminal("benchmark-job-1", timeout_seconds=1)
            self.assertTrue(sample["schedule"])
            self.assertTrue(sample["owner_review_required"])
            self.assertEqual(sample["send_count"], 0)
            self.assertEqual(sample["write_count"], 0)
            with urlopen(Request(f"{bridge.url}/hermes/v1/events?consumer_id=test&wait_ms=0", headers=headers)) as response:
                self.assertIsNone(json.load(response)["event"])

    def test_isolated_profile_config_keeps_cli_and_gateway_tools_identical(self):
        runner = load_runner()
        with tempfile.TemporaryDirectory() as temp_dir:
            profile = Path(temp_dir)
            runner.write_profile_config(profile, workspace=profile / "workspace")
            content = (profile / "config.yaml").read_text(encoding="utf-8")
        self.assertIn("provider: xai-oauth", content)
        self.assertIn("default: grok-4.5", content)
        self.assertIn("reasoning_effort: xhigh", content)
        self.assertIn("max_turns: 90", content)
        self.assertIn("disabled_toolsets: [computer_use]", content)
        self.assertIn("cli: [skills, village]", content)
        self.assertIn("kakao_village: [skills, village]", content)
        self.assertIn("allow_from: [village-kakao-bridge]", content)

    def test_owned_profile_cleanup_retries_after_a_transient_windows_handle(self):
        runner = load_runner()
        with tempfile.TemporaryDirectory() as temp_dir:
            profiles_root = Path(temp_dir) / "profiles"
            target = profiles_root / "native-provider-bench-test-run-gateway"
            target.mkdir(parents=True)
            (target / ".village-provider-benchmark-profile").write_text(
                json.dumps({"run_id": "test-run", "arm": "gateway"}), encoding="utf-8"
            )
            real_rmtree = runner.shutil.rmtree
            attempts = 0

            def flaky_rmtree(path):
                nonlocal attempts
                attempts += 1
                if attempts == 1:
                    raise OSError("transient handle")
                return real_rmtree(path)

            with patch.object(runner.shutil, "rmtree", side_effect=flaky_rmtree):
                runner._cleanup_profile(target, profiles_root, "test-run")
            self.assertEqual(attempts, 2)
            self.assertFalse(target.exists())

    @unittest.skipUnless(__import__("os").name == "nt", "Windows process tree contract")
    def test_gateway_shutdown_terminates_the_owned_windows_process_tree(self):
        runner = load_runner()
        process = Mock()
        process.pid = 43210
        process.poll.return_value = None
        completed = Mock(returncode=0)
        with patch.object(runner.subprocess, "run", return_value=completed) as invoked:
            runner._terminate_owned_process_tree(process)
        invoked.assert_called_once_with(
            ["taskkill", "/PID", "43210", "/T", "/F"],
            stdout=runner.subprocess.PIPE,
            stderr=runner.subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )


if __name__ == "__main__":
    unittest.main()
