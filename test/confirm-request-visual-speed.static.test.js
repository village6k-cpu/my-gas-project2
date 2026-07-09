const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const confirmView = read('apps/today-dashboard/components/ConfirmView.tsx');
const appShell = read('apps/today-dashboard/components/AppShell.tsx');

assert.match(
  confirmView,
  /type ConfirmEquipmentRole\s*=\s*"set-header"\s*\|\s*"set-component"\s*\|\s*"single"/,
  '확인요청 장비 목록은 세트 헤더, 세트 구성품, 단품 역할을 명시적으로 나눠야 한다'
);

assert.match(
  confirmView,
  /function buildConfirmEquipmentRows\(/,
  '세트/구성품 위계는 렌더링 중 즉석 추측이 아니라 전처리 함수에서 계산해야 한다'
);

assert.match(
  confirmView,
  /data-confirm-role=\{row\.role\}/,
  '세트 헤더와 구성품 행은 DOM 역할 표식을 가져야 QA에서 반복 확인할 수 있다'
);

assert(
  confirmView.includes('bg-brand-50 px-3 py-2') && confirmView.includes('text-brand-700') && confirmView.includes('border-l-brand-200'),
  '세트 헤더는 오늘 일정 대시보드처럼 연한 헤더와 세트 배지 정도로만 구분돼야 한다'
);

assert.doesNotMatch(
  confirmView,
  /bg-brand-600 px-3 py-2\.5 text-white shadow-sm/,
  '확인요청 세트 헤더 전체를 진한 버튼색으로 칠하면 오늘 일정 대시보드 톤보다 과하다'
);

assert.match(
  confirmView,
  /const KakaoReservationInput\s*=\s*dynamic\(/,
  '카톡 AI 예약 입력 패널은 확인요청 진입 속도를 위해 dynamic import로 분리해야 한다'
);

assert.match(
  confirmView,
  /const \[showKakaoInput,\s*setShowKakaoInput\] = useState\(false\)/,
  '확인요청 첫 화면은 카톡 AI 예약 입력 패널을 필요할 때만 열어야 한다'
);

assert.doesNotMatch(
  confirmView,
  /<KakaoReservationInput onRequestCreated=\{load\} \/>/,
  '카톡 AI 예약 입력 패널을 확인요청 진입과 동시에 마운트하면 목록 표시가 느려진다'
);

assert.match(
  confirmView,
  /const CONFIRM_LIST_CACHE_KEY = "village-confirm-list-cache-v1"/,
  '확인요청 목록은 최근 성공 응답을 캐시해서 다음 진입 때 즉시 보여줘야 한다'
);

assert.match(
  confirmView,
  /useState<Req\[\]>\(\(\) => readConfirmListCache\(\)\)/,
  '확인요청 목록은 첫 렌더에서 캐시된 항목을 바로 사용해야 한다'
);

assert.match(
  confirmView,
  /const cards\s*=\s*useMemo\(/,
  '확인요청 카드 렌더링은 탭 전환/입력 중 불필요한 map 재생성을 줄이기 위해 memoized cards를 사용해야 한다'
);

assert.match(
  confirmView,
  /const EMPTY_CONFIRM_EQUIPS: Equip\[\]\s*=\s*\[\]/,
  '장비목록이 비어 있는 요청도 렌더마다 새 배열을 만들지 않도록 고정 빈 배열을 써야 한다'
);

assert.match(
  appShell,
  /import dynamic from "next\/dynamic"/,
  '앱 셸은 큰 화면 컴포넌트를 탭별로 지연 로딩해야 한다'
);

assert.doesNotMatch(
  appShell,
  /import \{ (TodayView|ScheduleView|FollowUpView|OperationsView|ConfirmView) \} from/,
  'AppShell이 모든 탭 컴포넌트를 정적 import하면 초기 진입과 메뉴 전환이 느려진다'
);

assert.match(
  appShell,
  /const handleNav\s*=\s*useCallback\(/,
  '탭 이동 핸들러는 하위 네비게이션 리렌더를 줄이도록 안정적인 callback이어야 한다'
);

console.log('confirm request visual hierarchy and navigation speed checks passed');
