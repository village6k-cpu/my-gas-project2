const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const confirmView = read('apps/today-dashboard/components/ConfirmView.tsx');
const inputView = read('apps/today-dashboard/components/KakaoReservationInput.tsx');
const gasRoute = read('apps/today-dashboard/app/api/gas/route.ts');

assert(
  confirmView.includes('KakaoReservationInput'),
  'ConfirmView must render the Kakao reservation input panel'
);

assert(
  confirmView.includes('onRequestCreated={handleKakaoRequestCreated}'),
  'new reservation input must refresh the confirmation list after creation'
);

assert(
  confirmView.includes('setShowKakaoInput(false)'),
  'new reservation input must close after it creates a request so the fast list stays primary'
);

assert(
  inputView.includes('카톡 예약입력'),
  'panel must be labeled for Kakao reservation entry'
);

assert(
  inputView.includes('AI 파싱'),
  'panel must expose AI parsing'
);

assert(
  inputView.includes('handlePasteImage') && inputView.includes('handleDropImage'),
  'panel must support pasted and dropped images'
);

assert(
  inputView.includes('action=aiParse'),
  'AI parsing must call the integrated GAS proxy'
);

assert(
  inputView.includes('dashboardEquipmentCatalog'),
  'equipment dropdown must use the sheet-master catalog API'
);

assert(
  inputView.includes('insertAndCheckRequest'),
  'availability check must write to 확인요청 through insertAndCheckRequest'
);

assert(
  inputView.includes('registerAsync'),
  'result card must allow immediate registration'
);

assert(
  gasRoute.includes('"aiParse"') && gasRoute.includes('"registerAsync"'),
  'GAS proxy must whitelist parser and registration actions'
);

console.log('today-dashboard Kakao reservation entry static checks passed');
