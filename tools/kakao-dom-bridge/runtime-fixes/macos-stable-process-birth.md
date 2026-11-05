# macOS receiver recovery, 2026-11-05

The shared Kakao collection tab was left showing a customer-name search after document delivery. Heartbeats continued while new customers disappeared from the collector. The recovery supervisor detected a mismatched live list, but refused recovery because the running worker's stored PID birth fingerprint differed from a fresh read by exactly one second. psutil 7.2.2 adjusts default macOS creation timestamps for wall-clock changes, making that unsuitable as a persistent cross-interpreter identity.

The patch uses the unadjusted macOS kernel creation timestamp in both Hermes status writers and supervisor verification. PID, argv, profile home, code path, and exact birth comparison remain mandatory. Linux and Windows behavior is unchanged. Legacy workers need an idle restart so their stored fingerprint uses the stable value. Do not edit a live gateway status record or relax matching tolerance.

The document-delivery recovery procedure now uses a separate owned temporary search list and preserves the incoming collection list's search and consultation filters.

Validation: regression suite failed 3 tests before and passed all 5 after; existing supervisor suite passed 9 tests. Runtime activation hashes and gates were verified before idle worker and watcher restart. Live receiver then reported watcher ready, 20 visible rows, fresh heartbeat, and all five live API head rows matching DOM rows. Customer change was separately repaired using an exact period, a stable operation id, no customer notification, and authoritative schedule/ledger/contract readback.

Run installed-runtime regression checks with:

```sh
VILLAGE_RUNTIME_ROOT=/path/to/isolated/runtime python3 tools/kakao-dom-bridge/runtime-fixes/test_macos_process_birth.py
```

Back up each exact file and activation/manifest before applying the reviewed patch; update their SHA256 entries while preserving activation gates. Do not apply it blindly to a different Hermes/psutil version. The installed target is outside GAS; no GAS source or web-app deployment is involved.
