> **[정책 우선 고지 2026-08-12]** 이 문서의 인프라 자가 재시작/복구 지시(맥 방언 원문)는 2026-08-11 사장님 정책으로 대체됨 — **치유는 워치독 소유, 업무 턴 중 자가수리 금지** (SKILL.md 'Infrastructure incident guard'가 우선). 원문은 참고용으로 보존.

# Village Kakao scheduled manual send

Use this reference when the user asks to send a specific Kakao message to a named customer after a delay (for example, “김원석 한테 1시간 30분 뒤에 이거 보내줘”). This is a customer-facing side effect, but the user has explicitly requested the send and the delay, so schedule a one-shot job rather than merely reminding the user.

## Pattern

1. Resolve the intended target and message exactly from the user text. Do not rewrite the content except for obvious Slack markup cleanup the user explicitly provided (for example, `<tel:010...|010...>` → the visible phone number if the user gives the cleaned version).
2. Compute the fire time with a real time/date tool before scheduling. Use local KST/current machine timezone output, not mental arithmetic.
3. Prefer a one-shot `cronjob` with `no_agent=true` and a self-contained script under `~/.hermes/scripts/`.
4. The script should:
   - Use a per-send idempotency key and a local lock/sent marker before any customer-facing POST. One-shot cron can be re-entered by overlapping scheduler ticks or restarts while `last_run_at` is still unset; side-effect scripts must be at-most-once themselves.
   - Check `GET http://127.0.0.1:8787/health`.
   - If unhealthy/unreachable, run `/Users/village6k/my-gas-project2/scripts/kakao-automation start`, then re-check health.
   - `POST /manual-send` with `{"customerName":"...","text":"...","idempotencyKey":"..."}`. Use `roomTitle` only if customer name is insufficient. The bridge also suppresses identical customer/text duplicates within its dedupe window, but the script lock is still required.
   - Use a long timeout (manual sends can take several minutes while the worker opens/verifies the chat). If Hermes cron's script timeout is lower than the HTTP timeout, raise `cron.script_timeout_seconds` or keep the script bounded; otherwise the HTTP request may continue inside the bridge after the cron wrapper reports failure.
   - Print a short Korean success/failure report; with `no_agent=true`, stdout is delivered verbatim.
   - Exit non-zero on failure so scheduler surfaces an alert.
5. Create the cron job with `repeat=1`, `deliver="origin"`, and a descriptive name including customer and scheduled time.
6. Report to the user only the scheduled time, target, content, and job id. Do not claim the Kakao send happened until the scheduled job reports success.

## Minimal script shape

```python
#!/usr/bin/env python3
import json, subprocess, urllib.request, urllib.error
from datetime import datetime

ROOT = "/Users/village6k/my-gas-project2"
BRIDGE = "http://127.0.0.1:8787"
CUSTOMER = "김원석"
MESSAGE = "...exact message..."

def request_json(method, path, payload=None, timeout=10):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["content-type"] = "application/json; charset=utf-8"
    req = urllib.request.Request(f"{BRIDGE}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, json.loads(res.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read().decode("utf-8") or "{}")
        except Exception:
            return exc.code, {"raw": "HTTP error body parse failed"}

def ensure_bridge():
    try:
        status, body = request_json("GET", "/health", timeout=5)
        if status == 200 and body.get("ok"):
            return
    except Exception:
        pass
    proc = subprocess.run(["./scripts/kakao-automation", "start"], cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
    if proc.returncode != 0:
        raise RuntimeError(proc.stdout[-1200:])
    status, body = request_json("GET", "/health", timeout=5)
    if status != 200 or not body.get("ok"):
        raise RuntimeError(f"bridge unhealthy after start: {status} {body}")

ensure_bridge()
status, body = request_json("POST", "/manual-send", {"customerName": CUSTOMER, "text": MESSAGE}, timeout=900)
result = body.get("result") if isinstance(body, dict) else None
if body.get("ok") and isinstance(result, dict) and result.get("sent"):
    print(f"✅ 예약발송 완료 ({datetime.now():%H:%M})\n- 대상: {CUSTOMER}\n- 내용: {MESSAGE}")
else:
    reason = result.get("reason") if isinstance(result, dict) else body.get("error")
    print(f"⚠️ 예약발송 실패 ({datetime.now():%H:%M})\n- 대상: {CUSTOMER}\n- HTTP: {status}\n- 이유: {reason or body}")
    raise SystemExit(2)
```

## Pitfalls

- Do not use a normal reminder if the user said “보내줘”; they expect the message to be sent automatically.
- Do not claim success at scheduling time. The real send result comes from the scheduled script.
- Avoid broad Kakao restarts that might disturb the staff Chrome profile; use the existing `scripts/kakao-automation start` path, which preserves the normal automation Chrome profile rules.
- Keep the scheduled script self-contained because future cron runs do not inherit the chat context.
