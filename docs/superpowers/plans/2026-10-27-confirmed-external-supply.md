# Confirmed external supply recovery

Goal: confirmed staff procurement updates the existing schedule allocation, independently of pickup confirmation.
Architecture: extend the existing fenced registered-change tool with external_supply_allocation; reuse setScheduleSupplyAllocation CAS without registration, contract regeneration or checkout mutation. Keep AI interpretation, exact source revision and authoritative full readback.

- [ ] Add failing native validation/execution tests for total2/own1/external1, malformed quantity/supplier/period, stale baseline, no-send and full preservation.
- [ ] Connect strict typed JS/Python schema and existing native durable operation/receipt; verify current source rather than names or keywords.
- [ ] Run native/bridge regression suites and isolated HTTP transport tests; integrate official scripts, install exact runtime patch preserving customizations and historical holds.
- [x] Recover the named row once through existing CAS and independently read public/DB evidence; preserve real checkout1.
- [ ] Update the existing follow-up with exact version CAS, keeping real unresolved pickup/return and pricing work.

Constraints: no customer/Slack sends, no historical replay, no Chrome/Hermes restart, no new booking/price operations. Existing GAS function is unchanged; no GAS redeployment required.
