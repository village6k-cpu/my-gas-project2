# Card cancellation capability update

Implemented NICE CARD cardless full cancellation in the existing Toss Front
staff settings, plus card-present fallback. The original VAN, TID, VAN key and
VAT split remain attached to each approval. SDK cache recovery rejects approval
identity mismatches. A durable intent is saved and read back before each cancel
call; timeouts/crashes never automatically resend a financial operation. Cached
success repairs local/ledger state. Semantic ledger warnings retain sync pending.

The result template supports only two buttons, so eligible NICE transactions
first select a method and then see the exact approval confirmation screen.

Observed production receipts in the reported duplicate case are NICEPAY, not
NICE. Official Toss forum topic 61 explicitly excludes NICEPAY from cardless
cancellation. No server remote-cancellation queue was added: that cannot make
this provider support a cardless refund. The Hermes audit now returns VAN,
per-approval limitations and exact terminal matching identity without exporting
VAN keys or raw card data. It cannot execute a remote terminal refund.

Validation:
- All 13 Toss Front test files passed, including existing payment/receipt paths.
- Hermes audit: 11 tests passed.
- Added behavioral coverage for NICEPAY/KSNET/BARCODE/missing key refusal,
  exact tax/TID/key forwarding, legacy metadata recovery, identity mismatch,
  persistence-before-execution, timeout/restart no-resend, cached success repair,
  invalid success response, semantic ledger failure and 2-button template limit.
- Live read-only query returned unsupported_van for both reported approvals.
- Identical skill installed into live root and kakaoworker Hermes homes with
  backups under candidate/control/cardless-capability-20261104-172517.
- Native Hermes run selected skill_view + terminal and returned correct NICEPAY
  rejection in 3 model calls. No cancellation, financial update or message sent.

Delivery limitation:
- ZIP built with the existing terminal config (ignored by git; contains token).
- First-party CUA browser inventory: Local browser use is disabled in Work settings.
- Therefore no developer-portal upload or live terminal version verification.
- Existing NICEPAY approvals still require the original card/merchant-supported
  cancellation process. New source/ZIP alone does not enable cardless NICEPAY.
