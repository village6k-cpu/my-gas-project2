#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
export VILLAGE_RUNTIME_ROOT="${1:?Provide the installed isolated runtime root}"
export RECOVERY_WATCHER_SOURCE="$VILLAGE_RUNTIME_ROOT/production-runtime/tools/kakao-dom-watcher-extension/content.js"
node --test tools/kakao-dom-bridge/durable-intake.test.mjs \
  tools/kakao-dom-bridge/intake-coordinator.test.mjs \
  tools/reservation-recovery/*.test.mjs
python3 tools/reservation-recovery/test_native_adapter_concurrency.py
python3 tools/reservation-recovery/test_collector.py
python3 tools/reservation-recovery/test_recovery_policy.py
python3 tools/reservation-recovery/test_launcher_ports.py
python3 tools/reservation-recovery/test_release.py
