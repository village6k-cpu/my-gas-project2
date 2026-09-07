# Kakao staff-confirmed reservation acceptance

Use this contract when a customer equipment inquiry is followed by a Village staff reply that may authorize registration or an exact reservation change.

## Semantic authority

Native Hermes must interpret the full same-room conversation. Wording is open-ended. Examples such as `네`, `네네`, `가능합니다`, or a longer natural reply are illustrative only, not a closed vocabulary, fixed phrase list, allowlist, regex, substring test, or mutation trigger.

Reason over verified speaker roles, DOM order, the exact equipment, quantities, period and requested operation, plus any correction or superseding message. A clear, current and unconditional staff reply may itself authorize that exact mutation; a later customer acceptance can corroborate it but is not required.

`네` or `가능합니다` **is authorization** when the full conversation makes it the staff's clear, current answer approving the exact pending request. The identical word in an unrelated, ambiguous, conditional, or superseded context does not approve that request. Code must never decide this from the token alone; native Hermes decides from meaning. Conditional or tentative replies, partial scope, an unresolved stock check, customer-authored wording, or stale staff evidence are not authorization. If meaning or scope is uncertain, do not mutate and route one no-send owner review.

## Correct handling

- Every new customer equipment inquiry is recorded in 확인요청 independently of staff authorization.
- Treat exact, unconditional staff authority as a **staff-confirmed reservation mutation**, not as a generic phrase match.
- Execute only through the exact typed operation, immutable same-room evidence, lease/digest fence and authoritative readback. Never infer success from conversation text.
- Exact success is `no_reply`; do not send a duplicate customer reply or Slack card.
- If mutation is unavailable/failed, create exactly one operational follow-up that names the failed mutation (`확인요청 입력 실패`, `등록 실패`, etc.). Do not make a vague `답변 필요 / 예약 후보 확인 필요` card.
- Keep existing safety: do not use this pattern for price/payment/refund/damage/legal/tax-sensitive commitments.

## Execution boundary

Outer code may validate and execute typed evidence, but it must not infer authorization from a keyword, phrase, Korean acknowledgement, or customer-facing prose. It verifies only mechanical facts:

- customer and staff message IDs resolve to the immutable current room snapshot,
- roles and chronology are exact and the cited text/hash is unchanged,
- the cited staff message is current rather than superseded,
- the typed target/baseline/period matches the authoritative sheet state,
- the operation receipt and readback prove the exact effect.

Semantic regression scenarios must vary the language while preserving meaning, and must include misleading literal positives:

- clear short acknowledgement tied by context to one exact request: authorize;
- clear natural-language approval without any listed example phrase: authorize;
- literal `가능합니다` followed by a condition or unresolved check: do not authorize;
- literal `네` whose target is another question or whose speaker is the customer: do not authorize;
- later staff correction or different room revision: do not authorize.
