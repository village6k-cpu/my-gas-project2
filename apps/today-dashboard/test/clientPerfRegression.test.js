// 클라이언트 성능 결함 수정 회귀 테스트 (정적 소스 단언)
// - 숨김 pane 폴링 게이트 (FollowUpView 30초 / OperationsView 90초)
// - 사진 업로드 큐: 영구 실패 잡 dead-letter 처리 + wake 타이머 선점
// - 장비 카탈로그: 로드 실패가 ready로 고착되지 않고 백오프 재시도
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appRoot = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(appRoot, file), "utf8");

function sourceBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${startMarker} 구현을 찾을 수 있어야 한다`);
  return source.slice(start, end);
}

test("후속조치 폴링: 숨김 pane·백그라운드 탭에서 멈추고 복귀 시 즉시 1회 로드한다", () => {
  const follow = read("components/FollowUpView.tsx");
  assert.match(follow, /active:\s*paneActive\s*=\s*true\s*\}:\s*\{\s*active\?:\s*boolean/, "active prop을 선택적으로 받아야 한다");
  assert.match(follow, /if \(!paneActive\) return;/, "비활성 pane이면 인터벌을 걸지 않아야 한다");
  assert.match(follow, /document\.hidden/, "백그라운드 탭 가드(document.hidden)가 있어야 한다");
  assert.match(follow, /visibilitychange/, "탭 복귀 시 즉시 로드하는 리스너가 있어야 한다");
  assert.match(follow, /\[status, load, paneActive\]/, "active가 effect 의존성에 포함되어 전환 시 즉시 1회 로드된다");
});

test("운영판 폴링: 숨김 pane에서 멈추고 active 전환 시 즉시 1회 로드한다", () => {
  const ops = read("components/OperationsView.tsx");
  assert.match(ops, /active\s*=\s*true\s*\}:\s*\{\s*active\?:\s*boolean/, "active prop을 선택적으로 받아야 한다");
  assert.match(ops, /if \(!active\) return;/, "비활성 pane이면 인터벌을 걸지 않아야 한다");
  assert.match(ops, /\[load, active\]/, "active가 effect 의존성에 포함되어 전환 시 즉시 1회 로드된다");
});

test("AppShell: 후속조치·운영판 pane에 active를 내려주고, pane 래퍼는 memo + keep-mounted다", () => {
  const shell = read("components/AppShell.tsx");
  assert.match(shell, /const Pane = memo\(/, "pane 래퍼는 React.memo여야 한다");
  assert.match(shell, /pane\("follow", FollowUpView, true\)/, "후속조치 pane에 active를 전달해야 한다");
  assert.match(shell, /pane\("operations", OperationsView, true\)/, "운영판 pane에 active를 전달해야 한다");
  // keep-mounted 유지: 숨김은 hidden 클래스 전환이지 언마운트가 아니다 (상태 보존·전환 즉시성)
  assert.match(shell, /className=\{active \? "" : "hidden"\}/);
  // 다른 pane 컴포넌트 시그니처는 그대로 — active 없이 렌더된다
  assert.match(shell, /pane\("schedule", ScheduleView\)/);
  assert.match(shell, /pane\("inventory", InventoryView\)/);
});

test("사진 큐: 자동 재시도 소진 뒤에도 증빙 원본과 실패 타일을 보존한다", () => {
  const q = read("lib/data/photoUploadQueue.ts");
  const store = read("lib/data/store.ts");
  // 최종 실패 경로도 IDB에 보존하되 readyJobs가 MAX_ATTEMPTS 이상을 자동 재전송하지 않는다.
  const failBlock = sourceBlock(q, "} catch (error) {", "handlers.onFailure(job, message, willRetry);");
  assert.match(failBlock, /\} else \{[\s\S]*?idbWrite\(job\)/, "소진 잡도 작업자가 폐기할 때까지 IndexedDB에 보존한다");
  assert.doesNotMatch(failBlock, /idbDelete\(job\.queueId\)/, "전송 실패만으로 촬영 증빙을 삭제하면 안 된다");
  const resume = sourceBlock(q, "export async function resumePhotoUploads", "export async function retryPhotoUpload");
  assert.match(resume, /jobs\.set\(job\.queueId, job\)/, "재시작 때 소진 잡도 메모리 큐에 복원한다");
  // 부활은 조건부여야 한다: 네트워크 원인 소진 + 비영구 잡만. (무조건 초기화는 서버가
  // 영구 거절한 잡까지 무한 재전송하고, 부활 자체가 없으면 오프라인 한 번으로 굳는다)
  assert.match(resume, /!job\.permanent && job\.attempts >= MAX_ATTEMPTS && NETWORK_ERROR_RE\.test/,
    "네트워크 원인으로 소진된 비영구 잡만 재시작 시 부활한다");
  assert.match(store, /resumePhotoUploads\(\)\.then\(restorePhotoUploadTiles_\)/, "복원 잡을 카드 실패 타일로 연결해야 한다");
  assert.match(store, /localPhotoPreviews\.set\(job\.queueId, job\.data\)/, "수동 재시도용 미리보기도 복원해야 한다");
  const retry = sourceBlock(q, "export async function retryPhotoUpload", "export async function discardPhotoUpload");
  assert.match(retry, /job\.attempts = 0/, "수동 재시도는 attempts를 초기화해 다시 전송 가능해야 한다");
  assert.match(retry, /idbWrite\(job\)/, "수동 재시도 잡은 다시 IndexedDB에 보존된다");
});

test("사진 큐: 더 이른 재시도가 필요하면 기존 wake 타이머를 선점한다", () => {
  const q = read("lib/data/photoUploadQueue.ts");
  const wake = sourceBlock(q, "function scheduleWake", "async function processQueue");
  assert.match(wake, /clearTimeout\(wakeTimer\)/, "더 이른 마감이면 기존 타이머를 clearTimeout해야 한다");
  assert.match(wake, /wakeAt/, "예정 발화 시각을 추적해 비교해야 한다");
  assert.doesNotMatch(wake, /if \(wakeTimer\) return;/, "기존 타이머 존재만으로 조기 반환하면 안 된다(최대 60초 지연 회귀)");
});

test("장비 카탈로그: 로드 실패가 ready로 고착되지 않고 백오프 재시도한다", () => {
  const cat = read("lib/data/equipmentCatalog.ts");
  const catchBlock = sourceBlock(cat, ".catch((error) => {", ".finally(");
  assert.match(catchBlock, /ready:\s*false/, "실패 시 ready(완료 플래그)를 세우면 안 된다");
  assert.doesNotMatch(catchBlock, /ready:\s*true/, "실패를 완료로 고착시키면 세션 내내 빈 카탈로그가 된다");
  assert.match(cat, /MAX_AUTO_RETRIES = 5/, "자동 재시도는 최대 5회로 제한한다");
  assert.match(cat, /retryCooldownMs/, "재시도 사이에 지수 백오프 쿨다운을 둔다");
  const success = sourceBlock(cat, ".then(async (response) => {", ".catch((error) => {");
  assert.match(success, /failCount = 0/, "성공 시 재시도 카운터를 초기화한다");
  assert.match(cat, /export function retryEquipmentCatalog/, "수동 강제 재로드 경로가 있어야 한다");
});

test("렌더 안정화: ScheduleCard·VillageTimeline은 memo, 타임라인 행·날짜 셀은 useMemo다", () => {
  const card = read("components/ScheduleCard.tsx");
  const tl = read("components/VillageTimeline.tsx");
  assert.match(card, /export const ScheduleCard = memo\(/, "ScheduleCard는 React.memo여야 한다");
  assert.match(tl, /export const VillageTimeline = memo\(/, "VillageTimeline은 React.memo여야 한다");
  assert.match(tl, /const rows = useMemo\(/, "행 구성은 useMemo여야 한다");
  assert.match(tl, /const headerCells = useMemo\(/, "날짜 헤더 셀은 useMemo여야 한다");
  assert.match(tl, /const dayStripes = useMemo\(/, "주말·오늘 배경 셀은 useMemo여야 한다");
});
