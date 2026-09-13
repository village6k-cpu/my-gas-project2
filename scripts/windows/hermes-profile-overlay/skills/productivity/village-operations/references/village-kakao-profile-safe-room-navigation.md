# Kakao room reads that preserve live collection

The authenticated `/chats` list in the owned Kakao automation Chrome is the
watcher's input surface. A customer `/chats/<room-id>` page cannot replace it.
Navigating the only list tab into a room stops collection for every customer,
even while the bridge and AI worker processes remain healthy.

## Read a customer conversation

1. Verify the configured Kakao DevTools endpoint and owned Chrome profile.
   On the Windows production runtime this is port 9223 with the
   `%LOCALAPPDATA%\Village\chrome-kakao` profile. Read the current tab inventory.
2. Preserve the list tab's ID and URL. Never use the first generic Kakao tab as
   a `Page.navigate` target, and never close or navigate a `/chats` list tab for
   customer work.
3. Prefer the existing `captureKakaoRoomSnapshot` helper in
   `tools/ai-browser-worker/worker.mjs`, which manages a customer-room read.
   When direct CDP is needed, reuse an exact matching customer-room tab or
   create a separate one with `PUT /json/new?<encoded-room-url>`.
4. Verify the room URL and customer title after loading. Read the whole relevant
   conversation, including later staff approvals, changes, and cancellations.
5. Close only a temporary room tab created by this operation, after verifying
   its current ID and URL still belong to the operation. Leave the list tab
   and other clients' tabs intact.
6. Confirm the original list is still present. For a collection-health check,
   use `inject-watcher-cdp.py --port 9223 --probe-only` from the active runtime;
   require authenticated list access and `watcherReady=true`.

If the list is already missing or authentication is unavailable, preserve the
remaining tabs and report the exact runtime fault to the existing recovery
path. Do not repeatedly restart Chrome or infer successful collection from a
process, port, or bridge `/health` response alone.

## Installation receipts and recovery

Plugin deployment must update every reviewed file's `sha256` **and `bytes`**,
then the canonical manifest hash, and pass `Test-KakaoPluginInstallReceipt`.
The startup launcher and scheduled watchdog must both accept the installed
receipt. A running gateway alone does not prove that automatic recovery works.

This guidance changes browser and deployment handling only. Interpret booking
intent from the full conversation and retain the current registration, price,
inventory, and customer-send rules.
