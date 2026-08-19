# Historical Equipment Incident Screening

Use this for a fact-based answer to “who previously lost, misreturned, damaged, or failed to return **[equipment]**?”

## Scope and safety

- This is a historical evidence lookup, not a present-stock count and not a legal fault finding.
- Do not merge model families from vague text. `M`, `N`, Nano, motors, controllers, D-tap cables, chargers, and parent-set components need their own evidence labels.
- Do not disclose customer phone numbers in a general report.

## Evidence workflow

1. **Build aliases.** Include official label, common Korean shorthand, English spelling, and parent sets where the gear can appear as a component.
2. **Search broad historical evidence.** Use Kakao/Supabase documents first; search incident terms with each alias:
   - `미반납`, `분실`, `안 들어옴`, `안 보임`, `반납 안`
   - `파손`, `고장`, `수리`, `센터`, `견적`, `청구`
   - `다른 장비`, `바꿔`, `교환`, `퀵`, `입금`, `확인`
3. **Capture the source identity.** Record the document `source_ref`, especially the Kakao chat ID. A search result can be a clipped single incident message and is never enough to conclude the incident remains open.
4. **Read the full thread.** Fetch all documents for the same chat/source, inspect the incident timestamp plus later messages. Look specifically for:
   - customer admission/denial;
   - photo/CCTV verification;
   - physical return or wrong-item exchange;
   - quick/courier dispatch;
   - payment request and explicit payment confirmation;
   - staff confirmation that count/item is now correct.
5. **Cross-check operational state when the question is current.** For a live “who still has it?” answer, read `스케줄상세` + `계약마스터` joined by `거래ID`; distinguish normal active rentals from overdue returns. Do not infer a present overdue item from a years-old Kakao alert.

## Classification

| Class | Standard of evidence | Final wording |
|---|---|---|
| 현재 확인 필요 | Explicit alert; no later recovery, return, or settlement confirmation found | `기록상 종결 확인 없음 — 우선 확인` |
| 과거 사고·종결 확인 | Later thread evidence says returned/found/quick sent/paid, or staff confirms | `과거 이력이나 종결 확인됨 — 현재 추적 대상 제외` |
| 파손 주장/책임 미확정 | Damage was reported but causation/customer responsibility or settlement has no resolution | `파손 접수 이력, 귀책·정산은 로그상 미확정` |
| 제외 | Different model, unrelated accessory, routine equipment issue, or no incident evidence | `이번 장비/사고 범위에서는 제외` |

## Compact report shape

```text
🔴 현재 확인 필요
- 이름 — 날짜 / 정확한 장비·구성품 / 마지막 확인 상태

🟠 파손·정산 미확정
- 이름 — 날짜 / 보고된 증상 / 반박·미결 여부

✅ 종결 확인되어 제외
- 이름 — 반환·퀵·입금 등 확인 근거
```

Keep the result short. State the evidence limitation as `카카오/내부로그 기준` when live schedule and inventory readback was not performed.
