---
name: village-operations
description: Use when staff requests Village operational work.
version: 2.0.0
author: Village
license: private
platforms: [windows]
metadata:
  hermes:
    tags: [village, operations, reservations, documents, payments]
---

# Village Operations

Use this skill when the owner or staff asks Hermes to inspect, prepare, change,
or verify Village operational work. Hermes interprets the request and chooses
the relevant evidence and tool. Deterministic code validates and executes an
already understood action; it does not replace business judgment.

## Authority

- The current user may authorize internal Village work in the current request.
- An internal write approval does not authorize a customer-facing send.
- Kakao, SMS, iMessage, email, or proactive/cross-channel Slack delivery needs
  separate explicit approval for the exact recipient and content.
- Final registration is the owner-confirmed narrow exception: it includes exactly
  one registration-complete Alimtalk per trade. Correction, preview, and
  `sendEstimate` never inherit this authorization.
- Preview, draft, lookup, calculation, and readback are not final registration
  or delivery.
- Passwords, 2FA, CAPTCHA, device approval, and account recovery remain with
  the user.

## Source of truth

Choose the narrowest authoritative live source for the requested fact:

1. Current reservation, schedule, price, payment, inventory, and customer state
   comes from the matching Sheet/GAS/API read route and its readback.
2. A visible Kakao or Slack message is evidence of what was said, not proof that
   a Sheet write, document creation, or delivery succeeded.
3. Village Brain supplies historical evidence, policy rationale, and strategy;
   it does not override current live state.
4. Local skill memory records reusable procedure and judgment, never a stale
   customer-specific value.
5. The Mac mirror and backups are historical recovery inputs, not runtime truth.

Windows paths and command boundaries live in
[Windows runtime and sources](references/windows-runtime-and-sources.md).

## Interpret before execution

- Read the whole request and preserve source dates/times, quantities, option
  groupings, discounts, memo text, and whether the user asked to act or preview.
- Resolve aliases contextually against the broad equipment/customer sources.
  Do not replace interpretation with a growing keyword table.
- If one plausible interpretation is materially safer and reversible, proceed
  with it and state the assumption. If alternatives change money, equipment,
  recipient, or schedule, ask one focused question.
- Reuse an existing bounded operation when it expresses the understood action.
  Do not inspect large implementations just to rediscover a documented command.
- Never report success from a process, port, request acceptance, or tool exit
  alone when authoritative readback is available.

## Shared execution contract

For an authorized mutation:

1. Resolve the exact business object and capture its current identity/state.
2. Check duplicates, conflicts, stale identifiers, and send/write boundaries.
3. Build the complete intended result before making the first write.
4. Execute the minimum bounded action; avoid parallel writes to one object.
5. Read back the authoritative state and compare every material field.
6. Report what changed, what was not sent, and any remaining uncertainty.

On timeout or ambiguous failure, inspect readback before retrying. Never blindly
repeat a possibly completed write or send.

## Confirmation requests and reservations

- Infer the complete request from the supplied text/image and relevant customer
  context before calling an execution tool.
- Resolve equipment to exact catalog names using broad searches and context.
- Split into the minimum schedules when different equipment groups have
  different pickup or return times.
- Confirmation-request pickup minutes floor to the hour and return minutes ceil
  to the hour; exact hours remain unchanged. `27일 24:00` rolls into the next day,
  `28일 00:00`. If the result is not a valid forward interval, stop.
- For an existing partial request that is unregistered, read back its complete
  authoritative top-level equipment list, merge the AI-decided additions, then
  replace once and verify the full list. Never send an additions-only list as a
  new full request or silently create a duplicate.
- Treat confirmation-request entry and final registered reservation as separate
  operations with separate readback.
- Use the focused `village-confirm-request` skill only after reasoning has
  produced the exact plan; its runner is an execution boundary.

## Schedule changes

- Identify the exact transaction/request before changing dates or equipment.
- Preserve unaffected items, price fields, contacts, memos, and document links.
- For additions/removals/date changes, preview the delta, validate conflicts,
  apply once, and read back both schedule detail and contract state.
- Never clone or re-register merely because a lookup was inconvenient.

See [registered trade date and item changes](references/registered-trade-date-change-remove-item.md)
for the bounded correction path.

For one authorized registered-trade correction, resolve the active runtime root
from [Windows runtime and sources](references/windows-runtime-and-sources.md),
have the AI produce explicit JSON, and run `node.exe "<active-runtime-root>/scripts/windows/village-registered-trade-correction.js" execute --input-file "<absolute-json>"`.
The runner validates and executes the decision in one bounded request; it never
interprets business intent.

## Quotes and documents

- Decide whether the request is an unregistered preview, pending-request quote,
  or registered-trade document before choosing data and pricing rules.
- Preserve customer source text when a requested field has no safer normalized
  representation; do not silently omit it.
- Recalculate totals from authoritative item prices, quantities, rental period,
  explicit discounts, and approved overrides.
- Preview and final delivery are separate. Generate or verify the artifact first,
  then send only with exact approval and delivery readback.
- Prefer an existing stable artifact/link when the requested correction does not
  require regeneration.

For the common fast preview path, open
[manual Kakao single quote preview](references/manual-kakao-single-quote-preview.md).

For registered multi-trade quote bundles, ad-hoc stacked discounts, or a question
about an existing bundle total, open
[registered batch quote verification](references/batch-registered-quotes-ad-hoc-loyal-discount.md)
before querying remote ledgers.

For a registered-trade item, quantity, or price correction, open
[registered quote/schedule item correction](references/registered-quote-schedule-item-correction.md)
directly.

## Payments, settlement, and tax

- Resolve the exact transaction and compare contract, payment, bank/card, and
  tax evidence without assuming one ledger proves another.
- Separate “paid,” “matched,” “receivable,” and “tax document issued.”
- Issuing or resending a tax invoice is an external action and requires explicit
  authorization plus provider readback.
- Never infer a current balance from historical Brain material.

## Returns and equipment

- Distinguish not-yet-due, overdue, missing-accessory, damage, inventory-count,
  investment, and disposal questions before acting.
- Use the equipment master and live schedule for current ownership/availability;
  use incident history only as supporting evidence.
- Preserve staff wording in incident/memo fields when normalization would erase
  operational meaning.
- An alert or memo update does not itself authorize customer contact.

## Messaging and follow-up

- Read the full current conversation before drafting or classifying a response.
- Keep internal follow-up work distinct from customer reply work.
- Detect duplicate delivery using recipient, conversation, content, and current
  delivery state; do not rely on one local queue row.
- A draft can be proactive; automatic sending remains gated by explicit runtime
  policy, grounding, recipient verification, and visible delivery proof.
- Slack card creation, update, thread reply, and channel-visible notification are
  distinct outcomes and require the requested one.

## Ambiguity and failure

- Label unresolved facts `UNKNOWN` and external/user-dependent blocks `BLOCKED`.
- Do not make up contact details, equipment variants, prices, dates, discounts,
  or success states.
- Prefer one precise clarification over a long questionnaire.
- Preserve evidence after a failure; do not clean logs, queues, tabs, artifacts,
  or dirty worktrees merely to make the status look healthy.

## Find exceptional detail

The preserved support library contains incident-specific procedures. Only when
no direct reference above matches an exceptional task, open the
[operational reference map](references/operational-reference-map.md), then read
the one or two references that match. The complete former entrypoint remains in
[the lossless legacy archive](references/legacy-village-operations-2026-08-15.md)
for audits and rule-recovery, not routine task execution.

## Learn as you work

- Record a reusable correction only after authoritative readback proves it.
- Do not autonomously patch any file in this owner-managed package, including
  this root or its references.
- Record new reusable evidence in a focused agent-managed skill. Move it into
  this package only through an owner-reviewed promotion.
- Do not encode one customer's name, one incident's transient state, or a guessed
  workaround as a universal rule.
- Keep this owner-managed root pinned to stable cross-task contracts. Preserve
  native usage and curator metadata for focused agent-managed skills so Hermes
  can still improve and consolidate reusable capabilities over time.
