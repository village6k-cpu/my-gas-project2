# Inventory semantic durable storage implementation plan

> **For agentic workers:** Use superpowers:executing-plans and test-driven-development. This incident already has assigned file ownership; do not delegate or commit other workers' files.

**Goal:** Preserve every AI judgment byte while removing its growing payload from the shared Script Properties quota.

**Architecture:** Before migration, retain the existing JSON properties. After an explicit, verified migration, read a private immutable Drive gzip snapshot through one small manifest property. Create and read back a complete next snapshot before replacing that manifest under the existing ScriptLock. Keep old and uncommitted files for recovery; never silently fall back after an active manifest fails.

**Tech stack:** GAS DriveApp, Utilities gzip/SHA256, ScriptProperties, ScriptLock; Node VM behavioral tests.

**Spec:** Incident decision: all 214 original judgments (147556 value bytes), including 14 no-longer-current scopes and all reasons, must survive. Public version 804 must continue reading legacy properties until a compatible public reader is deployed.

## Constraints and ownership

- Own inventorySemanticStorage.js, inventorySemanticReview.js, semantic tests, this plan, and the semantic routes in sheetAPI.js. Other workers own photo/worker changes.
- Source and tests only. No live migration, Drive creation, property deletion, deployment or independent commit.
- The migration execute gate probes the fixed production /exec using an internal-key POST and nonce. A /dev-only reader cannot enable migration.
- No schema, catalog, customer, send receipt or stock-allocation changes. Return metadata only from storage administration.
- A manifest activates the Drive authority. Missing/corrupt/private-access failures must throw; never reinterpret those as an empty judgment map.
- Retain full original raw JSON strings, unknown fields, inactive evidence and prior immutable snapshots. No TTL or garbage collection.

## Implementation and tests

- [x] RED: legacy reads; byte-identical migration; old public build rejection; permission/hash failures; property quota and ambiguous pointer writes; concurrent CAS; partial migration cleanup; no fallback on corrupted active files.
- [x] Implement a namespace-specific adapter with one manifest, SHA256 of canonical key/raw-string map, private-file checks, request-memory cache keyed by the exact manifest, and immutable copy-on-write snapshots.
- [x] Integrate the existing read and validated batch-write paths. Legacy operation remains unchanged until explicit migration. Reject writes while legacy cleanup is incomplete. Existing sourceHash and equipment identity validation remains authoritative.
- [x] Expose read-only metadata status and explicit migration with expectedSnapshotHash. Public probe runs before lock/file creation; lock-time source CAS prevents changing evidence after the probe.
- [x] GREEN: 103 semantic/inventory/API/probe tests passed; syntax and diff checks passed. Parent reviews and commits all workers together.

## Recovery and operational limits

- A failed create/read/ACL check leaves the current manifest and legacy records untouched. An uncertain manifest write is reconciled by exact readback; do not delete anything unless the intended manifest is confirmed.
- Cleanup deletes only legacy keys whose raw values still equal the verified snapshot, with a manifest CAS before every deletion. Interrupted cleanup is resumable with the same expected snapshot; normal writes stay blocked until complete.
- Restore is an operator-reviewed manifest CAS to a verified retained file under ScriptLock, never a blind pointer reset. No automatic restore endpoint is added.
- After cutover, never roll the public deployment back to a reader that only knows legacy properties. Such a rollback requires a separately verified restoration of every original legacy record first; retaining files alone does not make public version 804 compatible.
- Storage grows in Drive by one compressed snapshot per actual changed batch; identical writes create no file. At the measured size, each version is roughly 33 KB binary gzip. Monitor Drive quota separately; allocation failure preserves the previous authority.
- This removes semantic growth from Script Properties. Guide/photo no-replay records require their own durable storage decision; this adapter must not accidentally migrate unrelated prefixes.

API references checked: [DriveApp createFile](https://developers.google.com/apps-script/reference/drive/drive-app), [File access and sharing](https://developers.google.com/apps-script/reference/drive/file), [Utilities gzip](https://developers.google.com/apps-script/reference/utilities/utilities).
