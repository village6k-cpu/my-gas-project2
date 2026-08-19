# Hermes Slack follow-up patch maintenance

Use this when Village Kakao automation patches Hermes Slack Socket Mode to support `village_followup_*` buttons/modals.

## What must coexist

Village follow-up actions are local/custom Slack handlers, but upstream Hermes Slack adapter also owns Socket Mode startup, watchdog, and cleanup. When updating or merging `gateway/platforms/slack.py`, preserve both:

- Custom action/view registrations:
  - `village_followup_(send|edit_send|status_.+)`
  - `village_followup_edit_send_submit`
- Upstream robust startup path:
  - `_start_socket_mode_handler()`
  - `_running = True` only after handler startup
  - `_ensure_socket_watchdog()`
  - failed-start cleanup via `_stop_socket_mode_handler()`

Do **not** revert to a raw `AsyncSocketModeHandler(...); create_task(start_async())` block if the current upstream file has the watchdog helper path.

## Conflict-resolution pattern

If `scripts/patch-hermes-village-followup-slack` leaves conflict markers or `git status` shows `UU gateway/platforms/slack.py`:

1. Open the conflict around Slack action registration/startup.
2. Keep the Village action/view registration immediately before Socket Mode startup.
3. Keep the upstream atomic startup/watchdog block.
4. Remove `<<<<<<<`, `=======`, `>>>>>>>` markers.
5. Verify and mark resolved:
   - `python -m py_compile gateway/platforms/slack.py`
   - `git diff --check`
   - `git add gateway/platforms/slack.py`
6. Run any available Slack admin/follow-up focused tests before telling the user the live patch is fixed.

## Why this matters

Without the custom handlers, Slack follow-up buttons/modals stop working. Without the upstream watchdog startup block, Socket Mode can silently lose resilience/reconnect behavior. The correct maintenance action is a merge of both behaviors, not choosing one side.
