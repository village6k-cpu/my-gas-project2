# Tax-invoice recipient info lookup (계산서 발행 정보가 어떻게 되지?)

Use when staff asks for a customer's existing 세금계산서/계산서 발행 정보 without explicitly asking to issue.

## Safe lookup sequence

1. **Do not issue or mutate.** This wording is an information lookup, not approval to 발행.
2. Search `거래내역` by customer name/phone and list prior rows with:
   - 거래ID, 날짜, 연락처
   - 발행처 상호(G), 사업자번호(H)
   - 증빙유형(K), 발행상태(L), 입금상태(M), 비고(N), 관리키(O)
3. Prefer the **most recent row where G/H are filled and K=세금계산서** as the existing recipient info.
4. Cross-check `발행처DB` by the 사업자번호 for 대표자명/email/address/업태/종목 when available.
5. Also report the status of the current/latest target row if it looks related: e.g. `세금계산서 요청은 있는데 G/H/L/M 비어 있음`.

## Public CSV / gviz pitfall

The public `거래내역` CSV is usable for read-only lookup. `발행처DB` via public `gviz` can be malformed: row 1 may contain old concatenated lists of 사업자번호/상호/대표자/email in single cells, while later rows may contain proper normalized records. If direct `발행처DB` lookup is malformed or incomplete, treat the prior verified `거래내역` row's G/H as the primary evidence and use snippets from the malformed `발행처DB` only as supporting confirmation.

## Final answer shape

Keep it short and operational:

- 상호
- 사업자번호
- 대표자
- 이메일
- 참고: prior issued trade / current row status

Do **not** include long lookup methodology unless the user asks.