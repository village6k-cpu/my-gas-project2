# Candidate addition to existing village-operations quote skill (NOT installed)

Use the existing conversation naturally. Do not ask the owner to learn commands or tags.

When a product has no standard daily unit price, ask one clear ordinary question in the existing Slack thread: “폴리 1개 하루 기본 단가 얼마로 등록할까요?” Substitute the exact canonical product name. This asks for a master rate, not a deal-specific discount. If the missing decision is a transaction total, discount, or one-off waiver, keep the question trade-scoped instead. Never ask about an already verified standard rate again.

When the authenticated owner replies “5000원” in that thread, connect it to the exact prior question. Invoke village_master_price with canonical target and numeric price; question_ts is optional if the tool can uniquely establish the immediately preceding question. Do not supply or invent authority fields. The native extension selects the current source; the backend directly re-reads Slack author, text and thread. The owner does not need to repeat the product or say “상시”.

A standard-rate answer fills a missing master daily rate. A “이번 고객 무료” decision affects only that trade and must never write global zero. Exact “0원” to a clearly standard-rate question is explicit zero. Blank, total, quantity, discount, vague “무료”, multiple questions, missing day/unit, staff/customer replies, edits, later cancellation and contradictory current master values are not global authorization. Ask only for the unresolved fact.

On verified completion with downstreamSync=verified, continue the existing quote preview from the saved transaction. Re-read its cancellation/status before resuming. Do not recreate a cancelled reservation, re-send customer messages, or duplicate registration. Existing quote/customer-send approval rules remain in force.

On master_saved_sync_pending, say the master rate was saved but synchronization still needs attention; do not finalize the quotation. Retry only the same source-derived operation. On needs_review, use the original question and answer to explain the one ambiguity. Do not claim master storage succeeded based on memory storage alone.

Legacy unanswered questions: only reuse a directly fetched question with trusted bot identity and clear single product/day/unit/master scope. An old generic “이번 폴리 얼마?” lacks that scope; ask once whether it is the standard daily rate or this transaction's exception. Do not promote old waivers or mined memory to global catalog facts.

## Operational boundaries
No Hermes core modifications. This candidate uses the official user-plugin register_tool interface, existing skills, and existing Slack credential on the same host. ContextVar identity only selects the current message and blocks accidental CLI/child use; it is NOT sufficient authority. Direct Slack API verification and a payload-bound proof remain mandatory. Same-OS-user arbitrary code/credential access is outside this boundary, as with existing service credentials.

Installation/enablement and any gateway restart remain on hold pending review. The extension does no background polling, indexing or message replay. It runs only during a correction call. Remove the optional plugin/skill block to roll back; the master API can remain disabled without touching quote history.

## Interrupted-process recovery
The local issuer serializes each source with an exclusive .lock file. Normal failures release it. A killed process may leave the lock behind. Never automatically delete it: first establish that no issuer is still running, inspect its prepared request and server receipt/readback, then recover only the unfinished step using the same source-derived operation ID. Do not change IDs to bypass the lock. Pre-verification wrong guesses can be corrected; once a verified prepared request exists, a different payload requires review.
