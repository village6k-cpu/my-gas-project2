import importlib.util
from pathlib import Path
import unittest


INJECTOR_PATH = (
    Path(__file__).resolve().parents[1]
    / "tools"
    / "kakao-dom-bridge"
    / "inject-watcher-cdp.py"
)
SPEC = importlib.util.spec_from_file_location("inject_watcher_cdp", INJECTOR_PATH)
INJECTOR = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(INJECTOR)


def healthy_probe(**overrides):
    value = {
        "hasWatcher": True,
        "started": True,
        "observer": True,
        "heartbeatTimer": True,
        "topRowPollTimer": True,
        "transportReady": True,
        "pageEligible": True,
        "topRowsCount": 29,
        "topRowsScanAgeMs": 500,
        "watcherVersion": "2026-08-13-cdp-health-v16",
        "liveListProbeOk": True,
        "liveListItemCount": 100,
        "liveListHeadExpectedCount": 5,
        "liveListHeadMatchCount": 5,
    }
    value.update(overrides)
    return value


class WatcherHealthTest(unittest.TestCase):
    def test_rejects_a_fresh_watcher_scanning_a_stale_one_row_kakao_list(self):
        probe = healthy_probe(topRowsCount=1, liveListItemCount=100)

        self.assertFalse(
            INJECTOR.watcher_is_healthy(
                probe,
                "2026-08-13-cdp-health-v16",
            )
        )

    def test_rejects_a_full_sized_dom_whose_head_rows_are_stale(self):
        probe = healthy_probe(
            topRowsCount=29,
            liveListItemCount=100,
            liveListHeadExpectedCount=5,
            liveListHeadMatchCount=0,
        )

        self.assertFalse(
            INJECTOR.watcher_is_healthy(
                probe,
                "2026-08-13-cdp-health-v16",
            )
        )

    def test_accepts_a_watcher_whose_dom_is_consistent_with_the_live_list(self):
        self.assertTrue(
            INJECTOR.watcher_is_healthy(
                healthy_probe(),
                "2026-08-13-cdp-health-v16",
            )
        )

    def test_rejects_a_watcher_when_the_live_list_probe_failed(self):
        self.assertFalse(
            INJECTOR.watcher_is_healthy(
                healthy_probe(liveListProbeOk=False),
                "2026-08-13-cdp-health-v16",
            )
        )

    def test_live_list_probe_failure_is_degraded_without_reloading_kakao(self):
        probe = healthy_probe(liveListProbeOk=False)

        self.assertEqual(
            INJECTOR.watcher_probe_state(
                probe,
                "2026-08-13-cdp-health-v16",
            ),
            "live_list_probe_failed",
        )
        self.assertFalse(
            INJECTOR.watcher_should_reload(
                probe,
                "2026-08-13-cdp-health-v16",
            )
        )

    def test_stale_live_list_requests_a_bounded_kakao_page_reload(self):
        probe = healthy_probe(topRowsCount=1, liveListItemCount=100)

        self.assertEqual(
            INJECTOR.watcher_probe_state(
                probe,
                "2026-08-13-cdp-health-v16",
            ),
            "watcher_repair_required",
        )
        self.assertTrue(
            INJECTOR.watcher_should_reload(
                probe,
                "2026-08-13-cdp-health-v16",
            )
        )


if __name__ == "__main__":
    unittest.main()
