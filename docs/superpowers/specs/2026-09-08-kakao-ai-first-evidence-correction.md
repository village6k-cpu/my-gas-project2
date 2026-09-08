# Kakao conversation evidence: restore the native reasoning boundary

The user requires intelligent AI-first operation. Native Hermes must interpret the full customer conversation, identify the current request and applicable staff authorization, use the available authoritative reads, and choose the appropriate operation. Code must not substitute message position or bubble width for that judgment.

The September 7 implementation diverged from the September 7 design: a center-of-bubble sender heuristic became execution authority, unknown roles blocked inquiry revisions and registrations, and any message after staff approval invalidated registration. The September 8 edge-alignment and additional continuation-attestation workaround still retained that incorrect boundary.

This correction removes center and edge-based sender classification. DOM extraction retains explicit sender metadata and supplies actual bubble coordinates as observations. Conflicting metadata stays unknown. Hermes uses those observations with the complete conversation to determine missing sender roles and cites existing message IDs without rewriting source text.

An unknown extracted role is not contradictory evidence. Customer/staff selections may reference an unknown message; known opposing sender roles, overlapping customer/staff IDs, nonexistent IDs and altered text remain invalid. Snapshot integrity, room revision, exact request/trade, complete plan and period, inventory, operation deduplication and authoritative readback checks remain enforced.

Successful registration readback must also preserve Hermes' separate reply decision. It cannot erase an independently grounded price answer or mark that answer already delivered. Existing send-time price recomputation, reply grounding, freshness and duplicate checks still apply; failed or ambiguous registration still produces no-send review.

`confirmed=true` is Hermes' semantic judgment that the selected staff authorization still applies to the exact requested operation in the current full conversation. The selected approval need not be the latest staff message or the last message. Later cancellations, changes and withdrawn approvals must be evaluated by Hermes. The optional `post_confirmation_review` transport field remains backward compatible, but is not required and does not grant authorization.

Validation includes DOM extraction through its actual generated expression, immutable snapshot/evidence validators, the native Python tool transport, and isolated replays through the configured production model. Positive continuations and negative cancellation/withdrawal/customer-authored approval cases belong in model behavior verification. Mechanical tests must not label every later message a cancellation or preassign unknown senders to hide extraction failures.

This correction does not replay old customer writes or claim that a historical quote was delivered. The isolated replay tools have no production mutation or message backend.
