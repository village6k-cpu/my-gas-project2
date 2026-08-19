# Manual quote preview: OSEE monitor + loyal/long-term discount

Use when staff asks for a customer-facing/manual quote with no resolvable registered trade, especially wording like `김세진한테 osee 모니터 단골 할인이랑 장기 할인 적용해서 18회차 견적서`.

## Key pattern

- Treat this as a **manual quote preview first**, not a registered-trade quote and not a confirmation-request insertion.
- Search/verify equipment price from live `세트마스터`/`장비마스터` first.
  - Observed item: `OSEE MEGA22S4`
  - Observed day-rate: `40,000`
- If the customer message says `여기로 보내주시면 됩니다!` but no phone is visible/verified, do **not** auto-send. Generate a no-send preview artifact and ask for approval/send gate.
- For manual quote preview via the document GAS, `sendEstimateManual` with blank/invalid `연락처` can return:
  - `status: "ERROR"`
  - `error: "연락처가 유효하지 않습니다."`
  - **but still include `fileId` and `url`**
- In that case, treat the returned `fileId` as a successful no-send preview. Export CSV/PDF from the sheet, verify `%PDF`, and inspect text/visual render before reporting.

## Payload shape

```json
{
  "action": "sendEstimateManual",
  "key": "village2026",
  "manualData": {
    "고객명": "김세진",
    "연락처": "",
    "할인유형": "단골",
    "대여기간": "18회차",
    "items": [
      {"품목": "OSEE MEGA22S4", "수량": 1, "일수": 18, "단가": 40000}
    ]
  }
}
```

## Expected math for this observed case

- 정가소계: `40,000 × 1 × 18 = 720,000`
- `단골` multiplier: 사업자20% × 단골10% = `0.8 × 0.9`
- 18회차/일 장기할인: `45%` → multiplier `0.55`
- Combined multiplier: `0.396`
- 공급가액: `285,120`
- 부가세: `28,520`
- 합계 VAT 포함: `313,640`

## Final report shape

Keep short:

```text
✅ 김세진 견적서 미리보기 생성 완료
고객 발송은 아직 안 했음.
- 품목: OSEE MEGA22S4
- 수량/회차: 1대 × 18회차
- 할인: 단골(사업자20% + 단골10%) + 장기45%
- 정가소계: 720,000원
- 최종 합계 VAT 포함: 313,640원
MEDIA:/tmp/...
```

Only send after explicit approval such as `보내`, unless the user explicitly waived the approval gate.