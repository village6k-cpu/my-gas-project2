# Manual Kakao quote with staff price override + pending RQ context

Use when staff provides a Kakao/customer screenshot for a manual quote and adds a one-off instruction such as `DJI는 1만원으로 해서 견적서 발송 개인사업자 할인`.

## Durable workflow

1. Treat the screenshot as the source of truth for customer-facing quote facts unless a live sheet row clearly supersedes it:
   - customer name / Kakao room title
   - top-level requested items and quantities
   - rental period
   - special notes and requested substitutions
2. Search existing `확인요청`/customer DB only as supporting context:
   - Resolve phone/identity if later approved for send.
   - Detect existing pending RQ and availability/model-selection warnings.
   - Do **not** silently replace screenshot period with a pending RQ period if they differ. Report the mismatch.
3. For staff price overrides, override the line unit price in `manualData.items` even when `세트마스터` has a different G-column price.
   - Example: `DJI SDR 트랜스미션` normally had G=20,000, but staff said `dji는 1만원으로`; quote row must be `단가 10,000` and quantity still comes from the screenshot/RQ.
   - Keep the exact matched sheet item name (e.g. `DJI SDR 트랜스미션`) so the official template remains consistent.
4. Use the official manual preview route first:
   - `sendEstimateManual` with blank/omitted phone for no-send preview.
   - Expected preview result is `status: ERROR`, `error: 연락처가 유효하지 않습니다.`, plus `fileId/url`.
   - Export/verify CSV and a `gid=0` PDF; attach the PDF and clearly say `고객 발송은 아직 안 했음`.
5. Verify the exported CSV/PDF contains:
   - customer name and screenshot period
   - staff override price and resulting line amount
   - requested discount label, e.g. `할인 (사업자20%)`
   - VAT-included total
6. Surface blockers separately before asking for approval:
   - pending RQ time differs from screenshot time
   - pending RQ availability/model-selection warnings such as `5인치 모니터` or `매트박스` model choice
   - any unresolved note such as requested 7-inch monitor substitution
7. Only after explicit approval (`보내`, `발송`) should you use the real phone from customer DB/RQ and call the official send path. Do not treat the initial word `발송` in a staff remote-control request as bypassing this user’s quote approval gate unless the user explicitly confirms after seeing the preview.

## Reporting shape

Keep the result short:

- `견적서 미리보기 생성 완료 / 고객 발송 아직 안 함`
- customer, period, discount, staff override line, total
- one short `⚠️ 발송 전 확인 필요` block for mismatches/blockers
- attach `MEDIA:/...pdf`
