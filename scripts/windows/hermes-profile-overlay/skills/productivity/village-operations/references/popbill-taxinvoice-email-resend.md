# Popbill tax invoice email resend / recipient correction

Use this when the user asks to “change the email and issue again” for already-issued Village tax invoices.

## Core rule

If the tax invoice is already issued/Hometax-confirmed and only the recipient email is wrong, **do not create another tax invoice or another corrected tax invoice**. Resend the existing Popbill document email to the corrected address.

Reissue/correction is only for invoice content changes: buyer identity, amount, write date, tax details, etc. Email delivery address correction is a resend operation.

## Popbill REST endpoint

Popbill supports tax-invoice email resend through the existing document key:

```http
POST https://popbill.linkhub.co.kr/Taxinvoice/{MgtKeyType}/{MgtKey}
Authorization: Bearer {token}
Content-Type: application/json; charset=utf-8
X-HTTP-Method-Override: EMAIL

{"receiver":"new-address@example.com"}
```

For Village issued sales invoices use:

```text
MgtKeyType = SELL
```

Successful response:

```json
{"code":1,"message":"이메일 재전송 완료"}
```

## Recommended workflow

1. Resolve all relevant trade IDs and existing Popbill management keys.
2. Verify each Popbill document exists and record current state/amount:
   - `GET /Taxinvoice/SELL/{mgtKey}`
   - Check `invoiceeCorpName`, `invoiceeCorpNum`, `supplyCostTotal`, `taxTotal`, `stateCode`, and `ntssendErrCode`/`ntsresultDT` if Hometax confirmation matters.
3. For each existing document key, call the email resend endpoint above with the requested `receiver`.
4. Treat `code:1` / `이메일 재전송 완료` as Popbill resend accepted.
5. Add a trade note such as:

```text
세금계산서 이메일 재전송 완료(new-address@example.com) / 관리키 {mgtKey}
```

For a trade with both negative correction and corrected reissue, record both keys in the note.

## Pitfalls

- “다시 발행” in staff language may mean “send it again to the right email.” If the invoice facts are unchanged, prefer email resend over reissue.
- Do not overwrite the original management key just to track an email resend. Add a note instead.
- If multiple documents exist for one trade due to correction flow, resend all relevant documents the recipient needs: usually the negative correction and the corrected replacement.
- Do not rely on Popbill issue receipt alone as Hometax confirmation. Use NTS fields/state guard when reporting “홈택스 확정.”
