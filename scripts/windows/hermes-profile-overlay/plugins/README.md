# Native Kakao adapter overlays

`kakao_village/__init__.py` and `registered_change_tool.py` snapshot the registered-change validator and tool schema for `external_supply_allocation`. The independent `pending_identity.py` overlay validates pending booking contact updates. An unchanged booking name comes from the existing request. A changed name must occur in the selected customer messages.

Deploy only after reviewing the diff against the live files, backing them up, and confirming the native consumer is idle. Copy only the files required for the change and preserve the remaining plugin/config/auth. The native consumer imports its plugin at process startup, so a bounded native-consumer reload is required after installation. Chrome and the root Hermes gateway stay running.

Run `python test/native-external-supply.test.py` plus worker/HTTP tests. Procurement confirmation records supplier + exact count + existing rental period now; physical pickup/return remains separate work. The executor reuses GAS `setScheduleSupplyAllocation`, performs exact note/quantity/period CAS and verifies every public row after the write. Identical allocations are read-only no-ops. Uncertain POST/readback errors remain fenced and must never be retried automatically.
