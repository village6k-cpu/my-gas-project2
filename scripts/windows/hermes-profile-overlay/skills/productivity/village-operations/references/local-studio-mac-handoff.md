# Local Studio Mac HomeTax handoff

Use this contract only when Popbill cannot perform an explicitly owner-authorized
cash-receipt issue. The execution host is `맥에이전트` on **이 로컬 스튜디오맥**.

Reply once in the original Slack thread with the following fixed block. The Slack
reply itself must be one fenced `text` block. The opening and closing fences are
part of the transport contract: do not send the payload as ordinary Slack text,
and do not add prose before the opening fence or after the closing fence. This
prevents Slack from rewriting field names, mentions, or phone numbers. Use a fresh
lowercase UUIDv4 for every business handoff and copy only verified fields.

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

## Read-only Studio Mac CUA readiness check

Use this template only for a non-mutating connection check requested by the
owner. It verifies that HeyBilly can reach the MacAgent CUA execution path on
**이 로컬 스튜디오맥**. It does not authorize HomeTax issuance or any other
financial action. The Slack reply itself must be one fenced `text` block with
no prose before or after it.

```text
<@U0BSAFTPTS9> 작업 요청 (스튜디오맥 CUA 상태 확인)
[MAC_AGENT_READINESS_V1]
handoff_id: hb-{fresh-lowercase-uuid}
task_type: studio_mac_cua_readiness
authorization: read_only
[/MAC_AGENT_READINESS_V1]
```

Do not add customer, transaction, amount, purpose, phone, or item fields to the
readiness block. A readiness `PASS` proves only the local CUA execution boundary;
it never proves or authorizes a business mutation.
