# Paid after issue: Kakao notice only

Use when tax invoices already exist and staff then confirms payment and asks only to tell the customer by Kakao that the invoices were issued.

## Exact boundary

1. Read back the existing management keys and amounts. Do not re-issue or call `issueTaxInvoice`/`registIssue` to change an already-issued invoice from 청구 to 영수.
2. Read the exact customer chat tail and perform the recipient+text duplicate preflight before sending.
3. Prepare only the authorized Kakao notice: customer name, each issued amount, total, invoicee business name, recipient email, and `입금 확인` wording.
4. Send once to the exact resolved customer chat and verify the exact outgoing text in the conversation DOM before reporting completion.

Do not add a bank account, payment request, document bundle, or ledger mutation unless staff separately asks for it.

## Windows fast path

- Use the fixed runtime/source locations in `windows-runtime-and-sources.md`; do not recursively search `C:\Village` or the Hermes installation.
- Open `village-kakao-scheduled-manual-send.md` for the exact authenticated bridge `/manual-send` request and idempotency contract; use it immediately rather than discovering the helper in source.
- If Kakao CDP/bridge is unavailable, start only the documented `Village-Kakao-Production-Start` scheduled task, then probe `9223` and `8787` once.
- Open the exact customer room with `openKakaoTargetChatViaDevtools`. Require a `/chats/{numericId}` page/target before sending.
- Use the existing Kakao send helper when it retains the resolved target. If direct CDP is required, use that target's WebSocket, fill the native `textarea`, click `전송`, and verify the sent DOM marker.

## Message shape

```text
{이름} 감독님, 안녕하세요.
요청하신 세금계산서 {N}건 발행 완료했습니다.

1) {거래 또는 항목}: {금액}원
2) {거래 또는 항목}: {금액}원
합계 {합계}원 (입금 확인)

발행처: {상호}
수신 메일: {이메일}
메일함(스팸 포함) 확인 부탁드립니다. 감사합니다.
```
