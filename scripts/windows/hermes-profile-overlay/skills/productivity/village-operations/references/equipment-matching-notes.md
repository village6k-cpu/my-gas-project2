# Equipment matching notes for Village confirmation requests

Session-derived notes for natural-language Kakao/staff reservation text. Always verify against the live `목록` sheet before insertion; these are fast-start hints, not replacements for lookup.

## Confirmed aliases

| User/Kakao text | Sheet/list match | Notes |
|---|---|---|
| `600c`, `600C` | `어퓨쳐 600C` | Set expansion may include `헤드 / 발라스터 / 클램프 / 라인*2`, `소프트박스`, `C스탠드`. |
| `포그머신` | `포그 머신` | Direct list match once spaced. |
| `탑클램프`, `탑 클램프` | `탑 클램프 M11-095` or `탑 클램프 MB-55` | If user only says 탑클램프 and prior context does not specify model, choose one only with an assumption note. |
| `fx3` | `소니 FX3 바디세트` | Use 풀세트 only if user says 풀세트. |
| `70-200 gm2`, `70200gm2` | `소니 GM 70-200mm II` | Search `70-200`; `gm2` alone may return nothing. |
| `75볼 트라이` | one of `셔틀러에이스 M (75볼)`, `스몰리그 (75볼)`, `캠기어 마크4 (75볼)` | Ambiguous. Use recent/customer context if visible; otherwise mark assumption in 비고/추가요청. |
| `스피커` | likely `JBL 파티박스` or `하만카돈` | `스피커` search may return 0. Read/search full list and record assumption. |

## Exclusions and non-rental notes

- `메모리 리더기 반출x` means do not add a standalone memory reader item. Put it in `비고`/`추가요청`.
- FX3 바디세트 may auto-expand to `소니 CF-A 리더기` even when the note says reader is not going out. Mention the note in the final report so staff knows the sheet warning is from set expansion vs the customer’s actual requested outgoing gear.

## Known warnings to surface

- `안전고리` may appear as `❓ 미등록 장비` because it is not in 장비마스터/세트마스터. Still enter it if the user explicitly requested it; report the warning.
- 600C set expansion may show `소프트박스` as `⚠️ 모델 선택 필요`. Surface this as a manual follow-up item.
- Set components like `헤드 / 발라스터 / 클램프 / 라인*2` or `마이크*2 / 마이크 송신기` may show 미등록. Report if operationally relevant, but do not confuse them with the user’s top-level requested items.

## Verification pattern

After insert, read `확인요청` by the created `reqID` and check:

1. first row has correct customer/phone/date
2. all top-level intended items are present or intentionally noted as excluded
3. warnings are understood and summarized
4. no 알림톡/등록 was triggered unless explicitly requested
