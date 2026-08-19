# V마운트 배터리 분실/미반납/변상 내역 lookup

Use when the user asks “V마운트/브이마운트/v배터리 분실해서 변상한 고객 누구?” or asks to identify past battery-loss responsibility.

## Fast source order

1. Search local Brain/Kakao first, especially:
   - `C:/Village/VILLAGE_Brain/Raw/kakao/04_final.jsonl`
   - `C:/Village/VILLAGE_Brain/Raw/kakao/01_internal_threads.jsonl`
   - `Ops/brain-context-latest.md` for summarized incident patterns
2. Search with spelling variants and action terms:
   - equipment: `V마운트`, `v마운트`, `브이마운트`, `V배터리`, `v배터리`, `v마운트배터리`, `V마운트배터리`
   - incident: `분실`, `미반납`, `안 들어왔`, `안들어왔`, `하나 안 들어왔`, `빈다`, `CCTV`, `청구`, `입금`, `결제`, `변상`, `배상`, `보상`
3. Search by candidate names if surfaced by the first pass. For the known 2024 case, `유영은`, `최지환`, `V마운트 10개`, `하나 안 들어왔`, `v마운트배터리 cctv` are high-yield queries.
4. Use Slack/ledger/Google Sheet as corroboration, not the first source. In the observed session, the live `거래내역` CSV and 재고관리-agent Slack keyword searches did not contain the V마운트 loss/변상 terms even though Kakao did.

## Interpretation rules

- Distinguish three levels clearly:
  1. **미반납/분실 정황 확인**: e.g. “10개 나간거 맞습니다 / 하나 안 들어왔네요”.
  2. **고객/팀 귀책 확인**: e.g. same thread ties the issue to a named customer/team.
  3. **변상/입금 완료 확인**: requires explicit `변상/입금/결제/청구 완료` evidence or bank/ledger match. Do not infer payment completion from missing-item evidence.
- Do not treat `customer-profiles.jsonl` `incidents: []` as proof no incident happened. It can be sparse even when Kakao has the operative record.
- A later clarification can downgrade an apparent missing case. Example: “V배터리 5개만 반납” for 박정병 later had “박정병은 배터리 저렇게만 가지고 간 거 맞고”, so do not list as a confirmed loss/변상 case.
- Some internal “V마운트 2개 분실” records may lack a customer name; report them as unnamed/internal inventory loss unless a later linked thread identifies the customer.

## Known high-confidence example from this lookup pattern

**유영은 감독팀 — 2024-01-28**

Kakao evidence:

- `t_int_000716` 2024-01-28 19:36~19:43:
  - “v마운트배터리 cctv 돌려봤어?”
  - “9개 나갔을 확률은?”
  - “유영은 감독”
  - “v마운트 배터리는 cctv 돌려봐야될 거 같다 9개 나갔을 확률 매우 높아보임”
- `t_int_000717` 2024-01-28 20:41~20:42:
  - “V마운트 10개 나간거 맞습니다”
  - “하나 안 들어왔네요”
  - “시네로이드는 ... 유영은 감독팀 파손 맞습니다”

Safe answer shape:

> 기록상 가장 확실한 건 **유영은 감독팀**입니다. 2024-01-28에 V마운트 10개 반출, 1개 미반납이 확인됩니다. 다만 원문상 “변상 입금 완료”까지는 직접 확인되지 않아, 변상 완료 여부는 입금/청구 내역 별도 확인 필요합니다.

## Short final-report format

Keep the answer terse and evidence-tiered:

- `확정`: 고객/팀, 날짜, 수량, 핵심 근거 문구
- `미확정`: 변상/입금 완료 여부, 금액, 고객 고지 여부
- `제외/주의`: 비슷하지만 해소된 후보

Avoid dumping raw paths unless the user asks; cite only enough evidence for operational confidence.