---
name: village-history-evidence
description: Only for explicit Village history; never current operations.
version: 2.1.0
author: Village
license: private
platforms: [windows]
metadata:
  hermes:
    tags: [village, history, policy, evidence, strategy]
---

# Village Brain

Use this skill when a question depends on Village history, accumulated evidence,
policy rationale, customer knowledge across time, or strategic analysis. It is a
read/evidence capability attached to stock Hermes, not the owner of operational
execution.

## What Village Brain is

Village Brain is the governed knowledge system rooted at `C:/Village/VILLAGE_Brain`.
It combines raw sources, normalized system artifacts, Wiki knowledge, compiled
context, and provenance. The folder structure matters less than the evidence
chain from source to answer.

The normal starting point is the compiled context:

`C:/Village/VILLAGE_Brain/Ops/brain-context-latest.md`

Use [Windows runtime and sources](references/windows-runtime-and-sources.md) for
exact path and shell rules.

## When it helps

- Why a policy or operating decision exists.
- What happened in an earlier customer, equipment, finance, or incident history.
- Cross-period patterns, recurring failure modes, or owner preferences.
- Strategy, investment, outsourcing, positioning, or process-design analysis.
- Drafting a staff explanation in the owner's established voice.
- Locating the provenance behind a remembered fact.

Do not select this skill merely because a request mentions Village. Ordinary
quote preparation, confirmation entry, schedule change, and current operational
lookup should use their live source and relevant operational procedure.

## Evidence order

1. Read the smallest compiled section that addresses the question.
2. Follow its source pointers when precision, conflict, or auditability matters.
3. Distinguish direct evidence, normalized inference, and your own inference.
4. State time scope and uncertainty when evidence may be stale or incomplete.
5. Prefer a current owner correction over an older summary, while retaining the
   earlier evidence as history rather than deleting it.

## Current facts

Current reservations, schedules, availability, prices, payments, inventory,
receivables, and tax status come from the matching live system/API readback.
Village Brain can explain history or policy around those facts but cannot prove
today's value from a cached document.

If a current fact and historical evidence disagree, report the disagreement and
use the live source for the current answer. Do not rewrite history to match it.

## Customer and owner knowledge

- Use stable customer identity evidence, not name similarity alone.
- Separate confirmed facts from relationship impressions and inferred patterns.
- Do not expose private customer history outside the owner/staff context that
  authorized the lookup.
- Draft in the owner's tone without inventing approval, promises, or policy.

## Policy and strategy

- Cite the decision/evidence date when it affects interpretation.
- Compare alternatives and tradeoffs rather than converting judgment into a
  mechanical score.
- For equipment and finance analysis, separate historical utilization/cashflow
  evidence from current asset, price, and ledger truth.
- When evidence is thin, label the conclusion as an inference and say what would
  change it.

## Permitted knowledge write

Record an owner correction or decision only when the current request clearly
asks to preserve it or when the normal native learning lifecycle records a
verified reusable lesson. Keep provenance, date, scope, and the owner's wording.
Never write current reservation or ledger state into Brain as a substitute for
updating its authoritative operational system.

## Boundaries

- Brain retrieval is read-only unless the owner explicitly authorizes the narrow
  knowledge capture described above.
- It does not authorize a Sheet/GAS mutation, final registration, tax issuance,
  or customer-facing send.
- A process, file, or health endpoint is not proof of a business outcome.
- Do not search secrets, browser cookies, or account credentials to answer a
  knowledge question.
- Gary Tan's G-Brain is a separate optional system. The name does not refer to
  Village Brain and neither system is invoked implicitly by the other.

## Exceptional references

The preserved package includes focused evidence procedures such as
`finance-ledger-forensics.md`, `cinema-camera-market-pricing.md`, and
`kakao-dom-watcher-incident-recovery.md`. Open only the one that materially helps
the present question.

The complete former entrypoint remains in
[the lossless legacy archive](references/legacy-village-brain-first-2026-08-15.md)
for audit and rule-recovery, not routine loading.

## Learning

- Put a verified reusable historical/policy lesson in the narrowest Brain source
  or reference with provenance.
- Keep stable selection and evidence rules here; keep case narratives outside
  the root.
- Never promote a transient live value or a guessed workaround into policy.
