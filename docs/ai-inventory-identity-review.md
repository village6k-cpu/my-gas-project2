# AI inventory identity review

Unresolved names from current schedules and open confirmation requests enter `getInventoryStockQuestions().investigations` before any Slack report or owner reply. The native Slack worker receives the complete physical catalog and set compositions. It decides identity; string matching does not limit its choices.

`review-stock` first supports dry-run. `link_existing` records a stable identity in `inventory_identity_aliases`, with current source/catalog evidence and target ID/name/version checked at apply time. It does not update stock, maintenance, or equipment-ledger timestamps. Alias collisions and unfinished audit creations are checked under the existing audit lock. The GAS risk calculation reads the mapping and the server verifies effective reuse. Identical retries read the saved receipt.

`ask_owner` stores a concrete question before local Slack delivery. Claims rotate by last claim time, use a lease, reconcile complete Slack history and metadata before retries, and authorize a POST only after checking the current source. Owner replies are reread from the whole verified thread and can create component-only missing stock through the existing confirmation and master-mirror path. Missing price remains null. Customer/model choice is not a stock count or a global alias; unanswered model choices remain visible as `waiting_model_choice`, with the exact question and owner reply, until the booking is actually resolved by its scoped workflow.

Unreviewed identity warnings no longer produce vague human alerts. The raw inventory uncertainty stays available to AI, and true shortages retain their existing delivery/registration checks. The identity-only notification gate reports `inventoryVerified:false`; it does not assert stock availability.

The scan uses a 155-second absolute request deadline and a 55-second maintenance budget, inside the existing 180-second runner limit. A slow Slack thread cannot discard previously collected investigations. Slack credentials remain in the existing local Hermes runtime; the cloud uses the separate internal API credential.

Validation: GAS identity queue and shortage/receipt regression tests, server source-to-alias readback and component-to-owner-to-master integration, local Slack pagination/crash-window/lease tests, whole Today Dashboard tests and production build. The unrelated Windows benchmark contract mismatch remains a baseline failure; the offline replay's order-sensitive parallel failure passes in an isolated rerun. No runtime model change is part of this patch.
