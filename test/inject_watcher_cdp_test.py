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


def healthy_extension_probe(**overrides):
    value = {
        "hasWatcher": False,
        "started": False,
        "observer": False,
        "heartbeatTimer": False,
        "topRowPollTimer": False,
        "transportReady": False,
        "pageEligible": True,
        "topRowsCount": 0,
        "topRowsScanAgeMs": None,
        "watcherVersion": "",
        "liveListProbeOk": True,
        "liveListItemCount": 100,
        "liveListHeadExpectedCount": 5,
        "liveListHeadMatchCount": 5,
        "extensionVersion": "2026-08-13-cdp-health-v16",
        "extensionStatus": "running",
    }
    value.update(overrides)
    return value


class WatcherHealthTest(unittest.TestCase):
    def test_accepts_current_space_channel_chat_routes(self):
        list_url = "https://business.kakao.com/space/353491/channel/_xhPMls/chats"
        detail_url = f"{list_url}/4845268282772547"

        self.assertTrue(INJECTOR.is_authenticated_chat_path("/space/353491/channel/_xhPMls/chats"))
        self.assertTrue(INJECTOR.is_authenticated_chat_path("/space/353491/channel/_xhPMls/chats/4845268282772547"))
        self.assertEqual(INJECTOR.chat_list_url(detail_url), list_url)
        selected = INJECTOR.choose_kakao_page([
            {
                "type": "page",
                "url": list_url,
                "webSocketDebuggerUrl": "ws://current-list",
            }
        ])
        self.assertEqual(selected["webSocketDebuggerUrl"], "ws://current-list")

    def test_repairs_stale_target_metadata_when_runtime_is_still_about_blank(self):
        class FakeCDP:
            def __init__(self):
                self.paths = iter(["blank", "/_xhPMls/chats"])
                self.navigations = []

            def call(self, method, params=None):
                if method == "Runtime.evaluate":
                    return {
                        "result": {
                            "result": {
                                "value": next(self.paths),
                            }
                        }
                    }
                if method == "Page.navigate":
                    self.navigations.append(params["url"])
                    return {"result": {}}
                raise AssertionError(f"unexpected CDP method: {method}")

        cdp = FakeCDP()
        destination = "https://business.kakao.com/_xhPMls/chats"

        self.assertTrue(
            INJECTOR.ensure_chat_list_runtime(
                cdp,
                destination,
                wait_seconds=0.1,
            )
        )
        self.assertEqual(cdp.navigations, [destination])

    def test_accepts_the_running_extension_after_a_repair_reload_removes_the_cdp_watcher(self):
        self.assertTrue(
            INJECTOR.watcher_is_healthy(
                healthy_extension_probe(),
                "2026-08-13-cdp-health-v16",
            )
        )

    def test_does_not_reload_a_live_list_owned_by_the_running_extension(self):
        probe = healthy_extension_probe()

        self.assertEqual(
            INJECTOR.watcher_probe_state(
                probe,
                "2026-08-13-cdp-health-v16",
            ),
            "healthy",
        )
        self.assertFalse(
            INJECTOR.watcher_should_reload(
                probe,
                "2026-08-13-cdp-health-v16",
            )
        )

    def test_running_extension_still_rejects_a_stale_dom_head(self):
        self.assertFalse(
            INJECTOR.watcher_is_healthy(
                healthy_extension_probe(liveListHeadMatchCount=0),
                "2026-08-13-cdp-health-v16",
            )
        )

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
