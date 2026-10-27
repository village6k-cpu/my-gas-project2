# Native registered-change adapter overlay

These two Python files snapshot the current deployed `kakao_village` registered-change validator and tool schema. They add only `external_supply_allocation` to the existing durable registered-change transport; all other plugin files remain owned by the existing Hermes installation.

Deploy only after reviewing the diff against the live files, backing them up, and confirming the native consumer is idle. Copy only these two files, preserve the remaining plugin/config/auth, and do not restart Chrome or the root Hermes gateway. The native consumer imports its plugin at process startup, so a bounded native-consumer reload is required after installation. No customer/Slack sending is authorized by this tool.

Run `python test/native-external-supply.test.py` plus worker/HTTP tests. Procurement confirmation records supplier + exact count + existing rental period now; physical pickup/return remains separate work. The executor reuses GAS `setScheduleSupplyAllocation`, performs exact note/quantity/period CAS and verifies every public row after the write. Identical allocations are read-only no-ops. Uncertain POST/readback errors remain fenced and must never be retried automatically.
