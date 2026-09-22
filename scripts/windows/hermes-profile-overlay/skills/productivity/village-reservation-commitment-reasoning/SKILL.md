---
name: village-reservation-commitment-reasoning
description: Use when deciding from a full Kakao conversation whether a concrete Village rental is mutually confirmed, still quote-only, awaiting a material choice, closed, or unknown.
metadata:
  hermes:
    tags: [village, kakao, reservations, intent, reasoning]
    related_skills: [village-staff-kakao-reservation-register, village-kakao-schedule-reconciliation]
---

# Village Reservation Commitment Reasoning

Infer the current reservation state from the complete chronological conversation.
This skill supplies semantic classification only. It does not authorize a write,
customer send, or recovery action; the calling operational skill owns those
boundaries.

## Build one evolving agreement

Track the conversation as one stateful agreement rather than scoring isolated
messages or searching for a magic confirmation phrase.

1. Reconstruct the latest concrete plan: customer, period, equipment, quantity,
   and any price or substitution that materially affects acceptance.
2. Accumulate customer choices and Village commitments in time order. A later
   mutually accepted substitution replaces the earlier unavailable choice.
3. Treat an accepted addition, removal, or timing change as an amendment to the
   existing agreement. Do not erase the already confirmed core.
4. Carry unresolved questions forward only when they still affect whether the
   current plan can be performed. Separate optional or independently resolvable
   extras from the confirmed core.
5. Base the result on meaning and conversational sequence, not the presence or
   absence of words such as reservation, confirmation, quote, or thanks.

## State continuity

Once both sides have accepted a concrete performable plan, keep it confirmed
unless later evidence explicitly cancels it, rejects it, or replaces a material
part with an unresolved alternative. A request for a quote, invoice, document,
payment instructions, or other administrative follow-up does not move a
confirmed agreement back to inquiry or quote-only. A later accepted amendment
also preserves confirmation.

Conversely, politeness or a document request cannot create confirmation by
itself. Require a concrete plan plus reciprocal commitment somewhere in the
verified chronology.

## Classification

Return exactly one current semantic state with a concise evidence trail:

- `confirmed_booking` - a concrete plan has reciprocal commitment and no open
  material decision prevents performance.
- `quote_only` - the customer is comparing or requesting terms and no concrete
  plan has yet received reciprocal commitment.
- `pending_substitute` - a required substitute or material condition is still
  awaiting acceptance. Preserve any separable confirmed core in the evidence.
- `inquiry` - the exchange has not reached a concrete booking proposal.
- `closed` - the customer or Village explicitly declined or cancelled it.
- `unknown` - the full chronology or a material fact cannot be verified.

Include `current_plan`, `reciprocal_commitments`, `open_material_decisions`, and
`confidence`. If the evidence is incomplete, say what is missing instead of
turning absence into a negative decision.

## Handoff

Pass the classification and evidence to the calling reconciliation or
registration skill. That skill decides authorization, deduplication, catalog
normalization, partial registration, mutation, and readback. Do not invent an
execution blocker from a resolvable alias or optional component; let the focused
execution skill resolve it against authoritative data.
