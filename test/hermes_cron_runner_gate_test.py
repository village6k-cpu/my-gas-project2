import importlib.util
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "tools" / "slack-heybilli-sync" / "hermes-cron-runner.py"
SPEC = importlib.util.spec_from_file_location("hermes_cron_runner_gate", MODULE_PATH)
runner = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(runner)


class HermesAiInvocationGateTests(unittest.TestCase):
    def gate(self, directory):
        return runner.AiInvocationGate(Path(directory) / "ai-gate.db")

    def test_ready_inventory_gets_exactly_two_successful_full_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            gate = self.gate(directory)
            calls = []

            for _ in range(3):
                code = runner.gated_invoke(
                    gate,
                    fingerprint="a" * 64,
                    max_passes=2,
                    invoke=lambda: calls.append("full-agent") or 0,
                )
                self.assertEqual(code, 0)

            self.assertEqual(calls, ["full-agent", "full-agent"])
            self.assertEqual(gate.inspect("a" * 64), {
                "completed_passes": 2,
                "max_passes": 2,
                "status": "completed",
            })

    def test_one_pass_work_is_not_repeated(self):
        with tempfile.TemporaryDirectory() as directory:
            gate = self.gate(directory)
            calls = []

            runner.gated_invoke(gate, "b" * 64, 1, lambda: calls.append(1) or 0)
            runner.gated_invoke(gate, "b" * 64, 1, lambda: calls.append(2) or 0)

            self.assertEqual(calls, [1])

    def test_active_claim_blocks_overlapping_process(self):
        with tempfile.TemporaryDirectory() as directory:
            first_gate = self.gate(directory)
            second_gate = self.gate(directory)

            claim = first_gate.try_claim("c" * 64, 2)

            self.assertIsNotNone(claim)
            self.assertIsNone(second_gate.try_claim("c" * 64, 2))

    def test_nonzero_or_exception_becomes_uncertain_and_never_auto_replays(self):
        for outcome in ("nonzero", "exception"):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as directory:
                gate = self.gate(directory)
                calls = []

                def invoke():
                    calls.append(outcome)
                    if outcome == "exception":
                        raise RuntimeError("provider disconnected after a possible write")
                    return 7

                if outcome == "exception":
                    with self.assertRaisesRegex(RuntimeError, "provider disconnected"):
                        runner.gated_invoke(gate, "d" * 64, 2, invoke)
                else:
                    self.assertEqual(runner.gated_invoke(gate, "d" * 64, 2, invoke), 7)

                self.assertEqual(runner.gated_invoke(
                    gate,
                    "d" * 64,
                    2,
                    lambda: calls.append("replayed") or 0,
                ), 0)
                self.assertEqual(calls, [outcome])
                self.assertEqual(gate.inspect("d" * 64)["status"], "uncertain")

    def test_runtime_fingerprint_changes_with_skill_or_model_config(self):
        base = runner.runtime_fingerprint("e" * 64, b"trusted skill v1", b"model: codex\nreasoning: medium\n")
        skill_changed = runner.runtime_fingerprint("e" * 64, b"trusted skill v2", b"model: codex\nreasoning: medium\n")
        config_changed = runner.runtime_fingerprint("e" * 64, b"trusted skill v1", b"model: codex\nreasoning: high\n")

        self.assertRegex(base, r"^[a-f0-9]{64}$")
        self.assertNotEqual(base, skill_changed)
        self.assertNotEqual(base, config_changed)


if __name__ == "__main__":
    unittest.main()
