# Local Studio Mac HomeTax handoff

Use this contract only when Popbill cannot perform an explicitly owner-authorized
cash-receipt issue. The execution host is `맥에이전트` on **이 로컬 스튜디오맥**.

Reply once in the original Slack thread with the following fixed block. Use a
fresh lowercase UUIDv4 for every business handoff, copy only verified fields, and
do not add keys or prose after the closing marker.

```text
<@U0BSAFTPTS9> 작업 요청 (홈택스 CUA)
[MAC_AGENT_HANDOFF_V1]
handoff_id: hb-{fresh-lowercase-uuid}
task_type: hometax_cash_receipt_issue
authorization: owner_explicit
customer_name: {verified-customer-name}
transaction_id: {YYMMDD-NNN}
transaction_date: {YYYY-MM-DD}
amount_krw: {integer-won}
purpose: income_deduction
phone: {verified-01X-XXXX-XXXX}
item: {verified-single-line-item}
[/MAC_AGENT_HANDOFF_V1]
```

Do not emit the block for a draft, lookup-only request, missing owner approval,
an edited or replayed Slack message, or an unsupported tax action. Never retry
with the same `handoff_id` after an ambiguous or running result; ask the owner to
review it. `스튜디오맥 접수` is only an acknowledgement. Only the MacAgent final
readback in the same thread proves issuance.
