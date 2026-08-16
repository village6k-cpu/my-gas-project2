# Hermes Village Native Skill Lifecycle Design

**Date:** 2026-08-15
**Status:** Approved direction; implementation pending
**Primary objective:** Keep Hermes itself as the decision-maker while preserving Village knowledge, native learning, restart durability, and predictable task latency.

## 1. Non-negotiable principles

1. Preserve stock Hermes behavior and its native skill lifecycle.
2. AI interprets requests and chooses the work. Deterministic code may retrieve, validate, enforce negative safety gates, execute an approved action, and verify readback; it must not replace business judgment.
3. Do not introduce a Village broker, router, plugin decision layer, or universal execution entrypoint.
4. Preserve every existing operational rule before restructuring. Nothing from the current 108 KB skill is discarded.
5. A restart, watchdog recovery, profile launch, or migration helper must not roll back native learning.
6. Village Brain and Gary Tan's G-Brain are separate systems and must never share a name or implied ownership.
7. No customer send, schedule mutation, Sheet/GAS write, deployment, commit, or push is part of the restructuring and benchmark phases.

## 2. Confirmed current state

### 2.1 Skill loading pressure

- Root `village-operations/SKILL.md` is 108,438 bytes, 613 lines, and 100,523 decoded characters.
- Its root body names 92 support references but also repeats large amounts of task detail directly in the entrypoint.
- Its description claims reservations, schedules, equipment, documents, payments, settlement, tax, Slack, Kakao, Sheets, and project APIs, so nearly every Village action matches it.
- `village-brain-first/SKILL.md` is 23,025 bytes and its description claims every Village business question, so ordinary operations may load both skills.
- Hermes places skill names and descriptions in the system prompt, instructs the model to load even partially relevant skills, and returns the complete root `SKILL.md` when selected.

### 2.2 Native Hermes standards

The locally running Hermes source says:

- `/learn` authors one reusable skill rather than a custom routing layer.
- Skill descriptions must be one sentence of at most 60 characters because the prompt index truncates longer descriptions.
- A simple skill should be about 100 lines and a complex skill about 200 lines.
- Detailed source material belongs in `references/`, reusable commands in `scripts/`, and templates in `templates/`.
- A skill must not be an empty router, index, or hub that only points elsewhere.
- The native curator consolidates related narrow skills into a class-level umbrella with short labeled subsections and support files.

Therefore the umbrella concept is valid, but the current 108 KB catch-all entrypoint is not a healthy native umbrella.

### 2.3 Migration/parity synchronization

`sync-hermes-profile-overlay.ps1` was introduced during the Mac-to-Windows migration. It builds a staging skill tree from a snapshot/source tree, adds Windows adapters, attempts to preserve changed local files and learning metadata, and atomically replaces the target profile's `skills` directory.

The actual launch paths differ:

- The root `Hermes_Gateway` scheduled task currently starts the Hermes gateway directly and does not invoke the parity sync on every boot.
- Root parity state records an explicit sync on 2026-08-14 13:43 KST.
- Kakao production startup and watchdog recovery call `start-kakao-staging.ps1`, which invokes the parity sync for the `kakaoworker` profile on every start.

The current preservation logic reduces data loss, but it does not resolve the architectural defect: a live native Hermes skill store and a migration snapshot both act like canonical owners. The system has accumulated conflict-resolution code solely because startup is performing migration work.

### 2.4 Why native curation did not prevent growth

- `village-operations` was created on 2026-06-02 and accumulated 348 recorded patches, 450 views, and 714 uses.
- The current native curator implementation arrived in the local Hermes source on 2026-08-04, after most of that growth.
- The root curator was seeded on 2026-08-13 KST and has completed zero real runs. Its first automatic run is deferred for the default seven-day interval.
- LLM umbrella consolidation is disabled by default even when deterministic stale-skill curation is enabled.
- The `.usage.json` records for `village-operations`, `village-brain-first`, and `village-confirm-request` have `created_by: null`. Hermes interprets this as “not curator-managed,” regardless of authorship written inside the Markdown frontmatter.
- The two focused Village skills that do have `created_by: agent` are curator-managed. This explains the earlier “2 managed, 153 unmanaged” report: most imported/local skills are invisible to autonomous curation, not necessarily broken.

The resulting feedback loop was:

1. A broad description caused `village-operations` to match nearly every Village task.
2. Hermes correctly followed its prompt to improve a loaded skill after difficult work.
3. Each quote, schedule, payment, Kakao, migration, and incident lesson was patched into the same root file.
4. No eligible native curator pass consolidated or externalized those patches.
5. The migration sync promoted the accumulated Mac-era file and later Windows adapter into a canonical deployment artifact.
6. Always-on memory and channel prompts duplicated selected shortcuts, temporarily masking the cost for familiar tasks while increasing contradiction and variance.

## 3. Target architecture

```text
Slack staff request
        |
        v
Stock Hermes reasoning and native skill selection
        |
        +--> village-operations: compact, substantive umbrella
        |       +--> one relevant reference when detail is needed
        |
        +--> village-brain-first only for history, policy, evidence, or strategy
        |
        v
Existing GAS/API/runner: lookup, validation, execution, readback
        |
        v
Authoritative Sheets/GAS state
```

There is no custom broker between Slack and Hermes and no code-based semantic task router.

### 3.1 `village-operations`

Keep the name for continuity, but rebuild the root as a substantive native class-level umbrella:

- One description of at most 60 characters, scoped to staff-requested Village operations.
- Approximately 100-200 lines.
- Contains the shared reasoning contract: authority, source-of-truth selection, AI-first interpretation, write/send distinction, readback, uncertainty handling, and learning expectations.
- Contains short labeled sections for reservation/confirmation, schedule changes, quotes/documents, payments/tax, returns/equipment, and messaging.
- Each section contains only the common decision boundary and points to the exact existing support reference for exceptional detail.
- Does not invoke `village_operation`, a broker, another routing skill, or a mandatory Brain load.
- Does not carry long incident narratives, bulk alias banks, historical examples, or OS command tutorials in the root.

All 108 KB of existing content is first copied into a lossless archive and then classified. Unique reusable content is retained either in the compact root or a referenced support file. Duplicate or stale text remains recoverable in the archive and is never silently deleted.

### 3.2 `village-brain-first`

Narrow the description and body to history, policy, evidence, customer knowledge, and strategic analysis that genuinely require Village Brain.

- Ordinary quote generation, confirmation entry, schedule change, and live-state lookup must not match this skill solely because they are Village work.
- Current facts continue to come from Sheets/GAS/API readback.
- The heading and instructions currently calling Village retrieval “GBrain” are renamed to Village Brain retrieval.
- Gary Tan's G-Brain remains a separate optional system with no implicit invocation from Village Brain.

### 3.3 Memory and channel prompts

- `MEMORY.md`: stable topology, boundaries, and high-impact facts needed on nearly every turn.
- `USER.md`: stable preferences and authority conventions.
- Channel prompts: role, channel-specific authority, and response style only.
- Operational procedures and equipment aliases do not return to always-on memory as a latency shortcut.
- Village Brain stores historical evidence and long-form knowledge.
- Sheets/GAS/API remain authoritative for current operational values.

### 3.4 Root and worker ownership

- Root Heybilli owns staff-facing Village operational reasoning and its native learning state.
- `kakaoworker` owns customer-event interpretation and Kakao runtime procedures.
- The worker does not receive a wholesale copy of the root skill tree on every launch.
- Shared business facts live in Village Brain or live APIs, not in two independently mutating copies of the same giant skill.
- Any initial worker seed is an explicit, one-time import. After import, that profile's native skill store owns its lifecycle.

## 4. Startup and synchronization policy

### 4.1 Remove migration from the hot path

- Remove parity synchronization from Kakao production/staging startup and watchdog recovery.
- Do not add it to root gateway startup.
- Keep the existing synchronization logic only as an explicitly invoked migration/recovery tool until its remaining callers and rollback paths are retired.
- Rename or document it so an operator cannot mistake it for a routine start requirement.

### 4.2 One owner per live file

- Active Hermes skill files and their `.usage.json`/curator state are the runtime source of truth.
- Mac Mini snapshots are read-only historical inputs.
- Git/backup snapshots are recovery artifacts, not automatic startup inputs.
- Exporting live skills for backup is one-way and non-destructive.
- Import requires an explicit command, a pre-import backup, hash comparison, and a conflict report; it never happens because a process restarted.

### 4.3 Restart durability proof

Before cutover, an isolated profile must prove:

1. Create or patch an agent-managed test skill through native `skill_manage` behavior.
2. Restart the gateway/profile through the real scheduled-task path.
3. Verify file hash, usage metadata, curator marker, and discoverability are preserved.
4. Repeat through the Kakao watchdog recovery path.

## 5. Long-term native learning lifecycle

### 5.1 Explicit ownership classes

Do not bulk-adopt all unmanaged skills.

- **Agent-managed:** learned operational umbrellas and focused operational supplements that Hermes should improve and consolidate.
- **User-managed:** safety boundaries, profile identity, and stable Brain integration policy.
- **Bundled/hub/external:** upstream-owned packages following normal Hermes protection rules.

`village-operations` is explicitly adopted into curator management after its compact form passes tests. Stable safety boundaries remain duplicated at the appropriate negative runtime gate or user-owned policy boundary so curation cannot remove the only copy of a critical send restriction.

### 5.2 Curator operation

- Run the first curator pass in an isolated copied profile with `--dry-run --consolidate`.
- Review its candidate set and verify it contains only explicitly adopted skills.
- Run one real isolated consolidation and validate the native backup/archive/restore path.
- Only after that proof, enable periodic native consolidation for the approved agent-managed set.
- Keep the native seven-day cadence and two-hour idle gate initially.
- Never use `adopt --all-unmanaged`.
- Curator backups and archives remain enabled; no skill is physically deleted.

### 5.3 Structural drift checks

Tests and health reporting may check objective structure without making semantic decisions:

- description length at most 60 characters;
- no universal “every Village question” trigger;
- root entrypoint within the approved complex-skill envelope;
- every referenced support file exists;
- no G-Brain/Village Brain conflation;
- no startup caller invokes the migration sync;
- a native learning patch survives restart.

These checks report or fail a maintenance test. They do not route customer work, choose equipment, or rewrite skills automatically.

## 6. Migration and rollout sequence

1. Capture hashes and a lossless backup of root and worker skills, usage metadata, curator state, config, and current launch definitions.
2. Build an isolated root profile clone; do not touch the live gateway.
3. Add failing structural tests for the confirmed defects.
4. Classify the 108 KB root content into shared core, task references, historical archive, live-state lookup, and obsolete duplicates.
5. Write the compact substantive `village-operations` root and preserve every retained reference.
6. Narrow `village-brain-first` and correct the G-Brain naming error.
7. Remove sync invocation from an isolated copy of the worker startup path and prove native learning durability across restart/watchdog recovery.
8. Run native curator dry-run and isolated real-run/rollback tests.
9. Benchmark fixed no-send fixtures using the same model, provider, reasoning level, machine, and cold-session conditions.
10. Review results with the owner before any live cutover.
11. Cut over atomically with a rollback snapshot; restart only the required gateway/profile.
12. Verify live skill hashes, catalog descriptions, root/worker process identity, and Slack response path without customer delivery.

## 7. Benchmark contract

Use at least these no-send fixtures:

- simple unregistered manual quote preview;
- registered-trade quote preview with a correction;
- confirmation request from text with one alias;
- confirmation request with split return times;
- existing schedule equipment addition;
- return equipment memo/update plan;
- historical/policy question that should load Village Brain;
- ordinary live-state question that should not load Village Brain.

Record:

- selected skills and support files;
- first-input tokens and maximum context;
- model API call count and tool-call count;
- model latency, tool latency, and wall time;
- output correctness, exact equipment names, totals, authority handling, and readback plan;
- whether any customer-send or live-mutation tool was attempted.

The candidate passes only when it preserves correctness and judgment while reducing irrelevant skill loading and long-tail latency. A smaller prompt alone is not success.

## 8. Rollback and safety

- Every mutable phase starts from a timestamped backup with SHA-256 inventory.
- Live root and worker are changed separately and can be rolled back separately.
- A failed benchmark or restart-durability test leaves the live system unchanged.
- A failed live readback rolls back the skill/config cutover, not business data.
- No destructive Git operation, force push, GAS deployment, customer send, schedule mutation, or Sheet write is authorized by this design.

## 9. Rejected approaches

### Restore the old 10,000-character always-on memory

This can make familiar tasks feel immediately smart but recreates duplicated procedure, contradictions, and uncontrolled every-turn prompt growth. It is a diagnostic fallback, not the target architecture.

### Replace the skill with a 6 KB broker or index

This violates the native prohibition against router/index-only skills and inserts a decision layer between Hermes and its tools.

### Split every operation into a separate skill

This fights the native curator's class-level umbrella design, increases trigger ambiguity, and invites later reconsolidation. Focused skills remain valid only when they are genuinely separate classes or are created naturally from new reusable capabilities.

### Keep whole-tree parity synchronization on startup

Even with preservation logic, it leaves two canonical owners and forces migration conflict resolution into every operational restart.

## 10. Completion criteria

- The 108 KB source is recoverable byte-for-byte.
- `village-operations` is a substantive native umbrella, not a broker or empty shell.
- Ordinary quote work loads neither the giant legacy root nor Village Brain.
- Village Brain and G-Brain are unambiguously separate.
- Root and worker learning survive their real restart paths.
- No routine startup path performs Mac/Windows skill-tree migration.
- Curator ownership is explicit; approved agent-managed skills are visible and user-managed skills remain protected.
- Fixed no-send benchmarks meet correctness gates and materially improve irrelevant context load and long-tail execution time.
- The live cutover has a tested rollback and does not mutate customer or business records.
