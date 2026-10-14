# Village 확인요청 할인유형 근거와 고객DB 보강

Use this for Village Kakao intake, quote calculation, registration, and discount reconciliation.

## Resolve one commercial term

For the current trade, produce: `discount_type`, actual evidence/speaker, matched customer identity, and source (`conversation`, `customer_db`, or `default`). Normalized values: `일반`, `학생`, `개인사업자/프리랜서`, `단골`, `제휴`.

1. Read the actual customer/staff conversation and same-room memo. Interpret the customer's stated student/business status and staff acceptance semantically. Use the current trade's supported value, including explicit `일반`, ahead of stale customerDB values. Shop sample forms are templates, not the customer's status.
2. When current evidence is absent, read Village 2.0 `고객DB` A/B/I. A supplied phone must match the normalized phone exactly. Only when phone is absent may a unique name match supply contact and discount. A different-phone same-name record supplies neither.
3. Leave an unsupported preliminary candidate blank/null so DB fallback remains possible. Use `일반` for final registration only when neither current evidence nor the identity-safe DB supplies a discount. Material ambiguity remains labelled for review, not silently assigned a rate.

Contact absence does not block RQ creation: create with blank contact when no unique identity exists; verify contact before registration.

## Execution and readback

- Worker intake enrichment and post-intake reconciliation preserve the resolved conversation discount; DB fills absence. Catalog quotes apply the same precedence. GAS `insertAndCheckRequest` repeats it before dedupe.
- For an existing RQ, use the guarded `customer_identity_update.discount_type` with exact expected name/contact. Preserve unrelated terms and avoid duplicate booking writes.
- Verify RQ M → contract master K → generated contract discount/total → Village 2.0 ledger I amount. The ledger has no discount-type column; preserve its layout. A master discount mismatch is not registration success.
- Existing registered-trade corrections use the guarded `updateTradeDiscount` operation with fresh current value/revision and authoritative readback. Check settlement first; do not silently reprice paid history. Customer delivery is a separate authorization.

## Verification

Read-only enrichment/quote cases: explicit student vs DB general → student; explicit business vs DB general → freelancer; silent chat vs same-phone DB student → student; explicit general vs DB student → general; shop example student only → blank before final fallback; supplied phone mismatch vs same-name loyal → no DB enrichment.

Use actual worker behavior tests and verify computed totals, not only prompt strings. The old GAS `info&sheet=고객DB` can omit I; use Village 2.0 GViz A/B/I or the official server lookup. Deploy the existing GAS web-app version and refresh the owned idle bridge when loaded code changes; process health alone does not prove discount propagation.
