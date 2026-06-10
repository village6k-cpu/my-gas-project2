# Kakao Reservation Entry Design

## Goal
Bring the legacy Kakao AI reservation input flow into the integrated today dashboard, mounted at the top of the `확인요청` view.

## Scope
- Add an expandable `카톡 예약입력` panel above the existing confirmation request list.
- Support text paste, image paste/drop, AI parsing, editable reservation fields, equipment editing, sheet-master equipment dropdowns, availability check, and immediate registration.
- Keep the existing confirmation request list and actions intact.
- Use integrated app API routes so the public GAS key and CORS behavior stay behind the Next app.

## Architecture
- `ConfirmView` owns list refresh and renders the new panel.
- `KakaoReservationInput` is a focused client component for the input/parsing/edit/check/register flow.
- `/api/gas` exposes the needed legacy `aiParse` and `registerAsync` actions.
- `/api/confirm` continues to run `insertAndCheckRequest`.
- Equipment options come from `dashboardEquipmentCatalog`, which is already backed by `목록` and `세트마스터`.

## Behavior
- The panel is collapsed by default and opened from a top button in the `확인요청` header area.
- `AI 파싱` calls `/api/gas?action=aiParse` with text and optional base64 image in a POST body.
- If AI parsing fails, the panel still opens the edit form and reports the error rather than blocking the operator.
- `가용 체크` calls `/api/confirm` with `action=run`, `func=insertAndCheckRequest`, and the edited reservation payload.
- On success, the result card shows `요청ID`, equipment results, duplicate message if present, and `바로 등록`.
- `바로 등록` calls `/api/gas?action=registerAsync&reqID=...`, then refreshes the confirmation request list.

## Non-Goals
- Do not redesign the entire confirmation request board.
- Do not move the feature to a separate bottom tab.
- Do not iframe or link out to `docs/request.html`.
- Do not add customer auto-send behavior here.

## Risks
- Image payloads can become large; keep the existing size guard and use POST instead of a long query string.
- Existing `aiParse` depends on GAS Script Properties. If `ANTHROPIC_API_KEY` is missing, the UI must show a clear error.
- The legacy HTML has many regex helpers; this first integrated version should lean on AI parse plus manual edits, not copy the full regex parser wholesale.
