# New catalog products implementation plan

Goal: create a missing 세트마스터 product from the owner's ordinary same-thread daily-rate reply, preserving the existing missing-rate flow.

Architecture: extend the existing official native plugin, direct Slack source verification, signed payload, locked append/audit/readback and downstream sync. No Hermes core changes, background tasks, invented stock or new owner commands. User explicitly included entirely new equipment and inventory. Reuse confirm_missing_inventory_stock on the existing server, verify its 장비마스터 mirror, then append the new catalog product. No database migration or new credential is needed.

Spec: user clarification on 2026-11-12 plus docs/master-corrections-design.md. Scope is new catalog products as well as missing rates. The existing server create adapter already defines A:G rows and first-row pricing; reuse it. Generic writes and a new message-monitoring service are unnecessary.

Review focus: source-bound composition, same-name conflict, unknown components, transaction exception, retry after a partial append/sync.

- [x] Add failing source/issuer/GAS/plugin tests for new-product authorization and component tampering.
- [x] Extend contextual source parsing, issueProof and the GAS proof gate for verified create payloads; preserve existing-price restrictions.
- [x] Add village_master_create to the same optional plugin toolset and update quote guidance with a natural question specifying the new product, composition and explicit new physical counts.
- [x] Run focused tests and the isolated real-runner fixture; review once for material append/authorization risks. Fixed the sheet-only existing identity duplication found in review; bounded re-review passed. App 570 tests and build passed; native fixture 9 passed. Root integration suite had one skill-length failure, fixed by keeping the new pointer on one line and verifying that suite again.
- [ ] Finish feature branch, integrate with repository checks, deploy the existing GAS URL, update the optional user plugin/skills and verify root connectivity, production preview and unchanged real master data.

The isolated fixture is not proof of an actual operational quotation. Never create a fabricated product or price in the live sheets for testing. Keep the existing signing key and historical voice phase unchanged.
