# Verified standing catalog and inventory corrections

The owner answers naturally in the existing Slack thread. The optional native `village-master` plugin selects only the current authenticated owner turn. The issuer directly re-reads Slack author, bot question, workspace, thread and text; a caller-supplied `verifiedOwner` boolean or memory is not authority. No Hermes core patch, message polling, indexing, replay, hook or middleware is added.

## Supported operations

- `village_master_price`: fill the missing standard daily rate of an existing exact catalog product. Explicit zero is a price; blank is not. Existing contradictory prices require review and are not automatically replaced.
- `village_master_create`: append an absent catalog product with explicit components and per-unit quantities. The preceding bot question states the product, composition and daily-rate scope. The owner can answer just `5,000원`. A one-off waiver/discount never creates a global rate or stock claim.
- The user explicitly included entirely new physical equipment/stock. The question also states each new physical name, major/category, total stock and maintenance count. These counts are independently bound to the same source; rental quantity is never used as owned stock. Missing facts are asked once. Existing IDs, names and aliases are not overwritten or duplicated.

Canonical conversational guidance: [master-correction-native.md](../scripts/windows/hermes-profile-overlay/skills/productivity/village-operations/references/master-correction-native.md).

## Authoritative inventory first

`equipment_ledger` in the existing village Supabase schema is the stock origin. `장비마스터` is its mirror. The existing service-only `confirm_missing_inventory_stock` RPC already atomically allocates IDs, guards existing/alias/pending-audit identities, writes equipment and event rows, and records an idempotent source receipt. Reuse it; do not create a second inventory system or bypass it with generic sheet writes.

The on-demand internal `/api/internal/catalog-stock` route requires the existing separate `SLACK_OPS_SYNC_SECRET`, configured inventory-owner IDs and service-role server client. It independently fetches the Slack original again using existing server credentials. It previews the proposed catalog append before any inventory write, calls the existing stock RPC with a stable per-source/per-item key, and uses the existing guarded mirror/readback helper. No database migration or new signing key is needed. A standalone new equipment item receives its confirmed rate; a kit component does not inherit the whole kit price.

The local issuer uses the existing private Slack/API configuration and `slack-heybilli.env` internal API credential. No signing proof is printed or audited. Once physical stock/mirror is verified, it obtains a fresh catalog revision, issues the payload-bound 2-minute HMAC proof and applies the catalog operation. Price-fill payloads keep their existing digest format for compatibility.

## Catalog append and downstream readback

Dedicated internal POST `masterCorrection` handles preview/apply. Preview never writes, including previews of named prospective physical inventory. Apply requires that new physical rows actually exist and match the confirmed name/classifications/counts. `create` is authorized only by a verified component question and exact signed composition/new-stock payload. Generic write permissions are not expanded.

ScriptLock serializes cooperating GAS catalog/list/mirror writers. Exact snapshot checks before planning and immediately before mutation detect intervening changes. A prepared write-ahead receipt is flushed in `마스터정정이력`, then a single catalog range is appended; full snapshot/row readback marks it verified. Existing sheet columns and rows are not restructured. Source audit strings are prefixed to prevent formula interpretation.

After append, the existing scoped 목록 writer refreshes dropdown names while preserving B+ content; the narrow template helper updates/appends only the target product/price pair. For newly created physical equipment, only those IDs are appended to `실사 기록` A:D, preserving existing physical count/status/history inputs. Each target is read back. A verified result allows the saved quotation workflow to continue after checking current cancellation/registration state; customer sending/registration permissions remain separate.

## Partial failure and concurrency limits

Inventory RPC transactions and catalog writes span separate services; they are not one transaction. `inventory_saved_catalog_pending` explicitly means inventory may be saved while catalog work is unfinished. `master_saved_sync_pending` means catalog is saved while downstream work needs attention. Reuse the same original message, operation ID and prepared payload; never create a fresh ID to bypass uncertainty. Changed evidence or divergent current data requires reconciliation rather than overwriting.

The native runner serializes each source with an exclusive local lock. A killed process can leave a lock; inspect the process, prepared request, durable receipts and authoritative data before recovering it. Newer owner corrections/cancellation, edited/complex source messages or incomplete thread pagination prevent automatic authorization. Sources older than one hour require current review.

ScriptLock is not an atomic compare-and-swap against manual sheet editors. Cross-service/manual edits can still require review. Do not claim atomic inventory+catalog creation or real operational success based only on fixtures or tool acceptance.

## Verification and deployment

Use source/issuer/proof/adapter tests, isolated native-runner fixtures, existing inventory tests, the app build and official repository integration gate. Check live schema before mutation. Deploy through feature `finishbranch.sh` and main `integrate.sh`, maintaining the existing GAS URL and intended Vercel project. Then update only the optional plugin and relevant root/worker skill blocks, with backups and current hash checks, and restart root gracefully if necessary. Preserve the existing signing key, voice phase and all unrelated runtime files. Never fabricate live product names, prices or stock for smoke testing.
