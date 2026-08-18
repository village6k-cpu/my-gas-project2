---
name: village-capability-development
description: Use when a Village operation lacks a safe executable path.
---

# Village Capability Development

## Core contract

Use this skill only after the AI understands the requested outcome but finds no
existing bounded path that can execute it safely. Treat the gap as development
work, not permission to improvise a live write or abandon the original request.
Keep business interpretation in the AI; add deterministic code only for schema,
identity, safety, execution, and authoritative readback.

## Native lifecycle

1. **`CAPABILITY_GAP`** — Preserve the original request, authorization scope,
   exact missing operation, and current object identity. Do not turn one missing
   action into a new all-purpose Village layer.
2. **`discover`** — Search native skills, current source, and authoritative APIs
   for an existing path. If none exists, use a `codex/` worktree. During
   `discover`, there must not be any live write, send, registration, or deploy.
3. **`validate_candidate`** — Write a failing regression test first. Implement
   the narrowest reusable boundary, then run focused tests, syntax checks, and
   diff checks without live credentials or customer effects.
4. **`promote`** — Use the existing reviewed branch/integration workflow. This
   is an owner-reviewed promotion; background review or curator work must never
   deploy code, change schedules, register reservations, or contact customers.
5. **`confirm_registration`** — Start a fresh runtime when required and prove
   the installed runtime or GAS route plus authoritative live readback. A file,
   commit, process, port, or successful request alone is insufficient.
6. **`record_learning`** — Use native `skill_manage` to create or patch a focused
   agent-managed skill with only reusable, readback-proven knowledge. Never
   patch the owner-managed `village-operations` package autonomously.
7. **`resume`** — Return to the original request with fresh live state, execute
   once through the promoted boundary, verify the material result, and complete
   the original request. Do not ask the owner to repeat it merely because the
   capability was initially missing.

## Stop conditions

- If a safe existing path is found, use it and do not create a new capability.
- If promotion or live effects lack current authorization, preserve the tested
  candidate and original request, report `BLOCKED`, and do not simulate success.
- If execution is ambiguous, reconcile authoritative state before any retry.
- If the lesson is customer-specific or unverified, do not record it as a skill.

## Quick check

Before resuming, require all of these: the original intent is unchanged, the
candidate passed its tests, the promoted bytes match the validated bytes, the
fresh runtime exposes the capability, and any live effect still has authority.
