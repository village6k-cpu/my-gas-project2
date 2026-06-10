# Kakao Reservation Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the legacy Kakao AI reservation input workflow to the top of the integrated `확인요청` view.

**Architecture:** A new focused React component owns paste/image/AI parse/edit/check/register state. `ConfirmView` renders it above the existing list and passes a refresh callback. Existing Next API proxies carry calls to GAS so authentication, CORS, and keys stay centralized.

**Tech Stack:** Next.js App Router, React client components, TypeScript, GAS proxy routes, static Node tests.

---

## File Structure

- Create `apps/today-dashboard/components/KakaoReservationInput.tsx`: input panel, AI parse, editable fields, equipment dropdown, availability result, immediate registration.
- Modify `apps/today-dashboard/components/ConfirmView.tsx`: render the new panel above the request list and refresh list after successful check/register.
- Modify `apps/today-dashboard/app/api/gas/route.ts`: whitelist `aiParse` and `registerAsync`.
- Add `test/today-dashboard-kakao-reservation-entry.static.test.js`: static regression guard for UI placement, API calls, catalog use, image support, and registration.

### Task 1: Add Static Guard

**Files:**
- Create: `test/today-dashboard-kakao-reservation-entry.static.test.js`

- [ ] **Step 1: Write the failing test**

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const confirmView = read('apps/today-dashboard/components/ConfirmView.tsx');
const inputView = read('apps/today-dashboard/components/KakaoReservationInput.tsx');
const gasRoute = read('apps/today-dashboard/app/api/gas/route.ts');

assert(confirmView.includes('KakaoReservationInput'), 'ConfirmView must render the Kakao reservation input panel');
assert(confirmView.includes('onRequestCreated={load}'), 'new reservation input must refresh the confirmation list');
assert(inputView.includes('카톡 예약입력'), 'panel must be labeled for Kakao reservation entry');
assert(inputView.includes('AI 파싱'), 'panel must expose AI parsing');
assert(inputView.includes('handlePasteImage') && inputView.includes('handleDropImage'), 'panel must support pasted and dropped images');
assert(inputView.includes('action=aiParse'), 'AI parsing must call the integrated GAS proxy');
assert(inputView.includes('dashboardEquipmentCatalog'), 'equipment dropdown must use the sheet-master catalog API');
assert(inputView.includes('insertAndCheckRequest'), 'availability check must write to 확인요청 through insertAndCheckRequest');
assert(inputView.includes('registerAsync'), 'result card must allow immediate registration');
assert(gasRoute.includes('"aiParse"') && gasRoute.includes('"registerAsync"'), 'GAS proxy must whitelist parser and registration actions');

console.log('today-dashboard Kakao reservation entry static checks passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/today-dashboard-kakao-reservation-entry.static.test.js`

Expected: fail because `KakaoReservationInput.tsx` does not exist.

### Task 2: Whitelist GAS Actions

**Files:**
- Modify: `apps/today-dashboard/app/api/gas/route.ts`

- [ ] **Step 1: Add actions**

Add `"aiParse"` to `WRITE_ACTIONS` because image/text parsing may use POST and should not be cached. Add `"registerAsync"` to `WRITE_ACTIONS` because it mutates confirmation requests into registered reservations.

- [ ] **Step 2: Run static test**

Run: `node test/today-dashboard-kakao-reservation-entry.static.test.js`

Expected: still fail until the component exists.

### Task 3: Build KakaoReservationInput Component

**Files:**
- Create: `apps/today-dashboard/components/KakaoReservationInput.tsx`

- [ ] **Step 1: Implement component**

Implement an expandable panel with text/image input, `AI 파싱`, editable fields, equipment rows, catalog suggestions, `가용 체크`, result display, and `바로 등록`.

- [ ] **Step 2: Run static test**

Run: `node test/today-dashboard-kakao-reservation-entry.static.test.js`

Expected: fail until `ConfirmView` renders the component.

### Task 4: Mount In ConfirmView

**Files:**
- Modify: `apps/today-dashboard/components/ConfirmView.tsx`

- [ ] **Step 1: Import and render**

Import `KakaoReservationInput` and render it at the top of the `main` content, before error/loading/list states. Pass `onRequestCreated={load}`.

- [ ] **Step 2: Run static test**

Run: `node test/today-dashboard-kakao-reservation-entry.static.test.js`

Expected: pass.

### Task 5: Verify

**Files:**
- Existing project files only.

- [ ] **Step 1: Run targeted static test**

Run: `node test/today-dashboard-kakao-reservation-entry.static.test.js`

Expected: pass.

- [ ] **Step 2: Run full static suite**

Run: `for f in test/*.js; do node "$f"; done`

Expected: all tests pass.

- [ ] **Step 3: Run Next build**

Run: `npm run build` from `apps/today-dashboard`

Expected: build succeeds.
