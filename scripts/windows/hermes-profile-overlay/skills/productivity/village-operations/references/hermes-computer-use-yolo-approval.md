# Hermes computer_use approval bypass pitfall

## When this matters

Use this when a headless/non-interactive Hermes worker is launched with `--yolo` or expected approval bypass, but GUI/RPA navigation still stalls with messages like:

- `⏱ Timeout — denying command`
- `Tool computer_use returned error (60.xx s): {"error":"denied by user","action":"click"}`
- worker output says the target chat/page was visible in a list/preview but the actual room/page could not be opened/read

## Root cause pattern

Hermes has a normal dangerous-command approval layer and `computer_use` has its own approval callback for GUI actions. If these are not wired together, `hermes chat --yolo ...` can bypass shell approvals while `computer_use` actions (`click`, `scroll`, `type`, `focus_app`, etc.) still prompt. In a non-interactive worker, no one can answer the prompt, so it times out and the worker sees `denied by user`.

This can look like a Kakao/browser/navigation failure, but the decisive evidence is the Hermes profile log line from `tools.computer_use` plus the worker JSON containing `Timeout — denying command`.

## Debug recipe

1. Inspect the worker result/tail, not just the bridge health.
2. Search the worker Hermes profile logs for the same time window:
   - `Tool computer_use returned error`
   - `denied by user`
   - `Timeout — denying command`
3. Confirm whether the worker command included `--yolo` or the profile had `approvals.mode=off`.
4. If `--yolo` was present but `computer_use` still prompted, the issue is approval plumbing, not the target web app.

## Fix pattern

In Hermes core, `tools/computer_use/tool.py` should check the same global/session bypass sources as `tools.approval.check_all_command_guards()` before invoking its approval callback:

- frozen process `HERMES_YOLO_MODE` / CLI `--yolo`
- current session `/yolo`
- `approvals.mode == "off"`

Regression-test with the noop backend:

```bash
HERMES_YOLO_MODE=1 HERMES_COMPUTER_USE_BACKEND=noop PYTHONPATH=/path/to/hermes-agent \
  python - <<'PY'
import json
from tools.computer_use import tool

def deny_if_called(action, args, summary):
    raise AssertionError('computer_use approval callback should not be called in yolo')

tool.set_approval_callback(deny_if_called)
result = json.loads(tool.handle_computer_use({'action': 'click', 'element': 1}))
assert result == {'ok': True, 'action': 'click'}
print(result)
PY
```

Also verify the negative path in a fresh process without `HERMES_YOLO_MODE`: a callback returning `deny` should still produce `{"error":"denied by user","action":"click"}`.

## Reporting guidance

For production RPA incidents, explain this as:

- 원인: 무인 워커에서 `computer_use` 클릭 승인이 별도로 걸려 60초 후 자동 거부됨
- 영향: 목록/미리보기는 보였지만 실제 채팅방/페이지를 못 열어 안전가드가 작동함
- 조치: `computer_use`도 Hermes의 동일한 승인 우회 상태를 존중하게 수정하고 noop regression test로 검증
