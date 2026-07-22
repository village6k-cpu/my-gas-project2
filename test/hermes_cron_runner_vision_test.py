import asyncio
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "tools" / "slack-heybilli-sync" / "hermes-cron-runner.py"
SPEC = importlib.util.spec_from_file_location("hermes_cron_runner", MODULE_PATH)
runner = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(runner)


class HermesVisionBridgeTests(unittest.TestCase):
    def test_batch_preserves_order_and_keeps_failures_retryable(self):
        async def analyzer(path, prompt):
            self.assertIn("비신뢰 데이터", prompt)
            if Path(path).name == "two.png":
                raise RuntimeError("temporary failure")
            return json.dumps({"success": True, "analysis": f"분석:{Path(path).name}"}, ensure_ascii=False)

        with tempfile.TemporaryDirectory() as directory:
            paths = [Path(directory) / name for name in ("one.jpg", "two.png", "three.webp")]
            for path in paths:
                path.write_bytes(b"image")
            result = asyncio.run(runner.analyze_images([str(path) for path in paths], analyzer=analyzer))

        self.assertEqual(result, [
            {"success": True, "text": "분석:one.jpg"},
            {"success": False, "text": ""},
            {"success": True, "text": "분석:three.webp"},
        ])

    def test_missing_local_file_is_rejected_before_model_call(self):
        called = False

        async def analyzer(_path, _prompt):
            nonlocal called
            called = True
            return json.dumps({"success": True, "analysis": "unexpected"})

        result = asyncio.run(runner.analyze_images(["/definitely/missing/image.jpg"], analyzer=analyzer))
        self.assertEqual(result, [{"success": False, "text": ""}])
        self.assertFalse(called)


if __name__ == "__main__":
    unittest.main()
