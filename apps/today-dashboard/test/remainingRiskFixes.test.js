// 잔여 리스크 수정 회귀 테스트 (정적 소스 단언)
// 1) 거래 특이사항(note_*) 내구 outbox — 전송 전 새로고침 유실 방지
// 2) 사진 변경 브로드캐스트 — 타 기기의 삭제/업로드 잔상이 모달 재오픈 없이 수렴
// 3) 실패 사진 전역 배지 — 화면 윈도우 밖 거래의 실패 잡도 보이고 재시도 가능
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appRoot = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(appRoot, file), "utf8");

test("거래 특이사항: 최신 목표가 localStorage outbox에 남고 성공 시에만 ACK된다", () => {
  const store = read("lib/data/store.ts");
  assert.match(store, /heybilly:trade-note-outbox:v1/, "노트 내구 outbox 키가 있어야 한다");
  // 저장 목표 기록: note 필드 patch가 outbox에 들어간다
  assert.match(store, /putTradeNoteOutboxPatch_\(/, "노트 patch를 outbox에 기록해야 한다");
  // 성공 ACK: persistTradeFieldPatch 성공 직후에만 제거
  assert.match(
    store,
    /await persistTradeFieldPatch\(tradeId, patch\);\s*\n\s*acknowledgeTradeNoteOutbox_\(tradeId, patch\)/,
    "persist 성공 직후에만 outbox를 ACK해야 한다"
  );
  // 재시작 재적용: replayDurableMutationOutboxes가 노트 목표를 복원한다
  assert.match(store, /readTradeNoteOutbox_\(\)/, "재시작 시 노트 outbox를 읽어야 한다");
  // 오래된 목표가 다른 직원의 새 노트를 덮지 않도록 TTL이 있어야 한다
  assert.match(store, /TRADE_NOTE_OUTBOX_TTL_MS/, "노트 outbox TTL 필요");
});

test("사진 변경: 성공 시 브로드캐스트를 보내고 수신 기기는 사진 캐시를 무효화한다", () => {
  const store = read("lib/data/store.ts");
  assert.match(store, /broadcastPhotoChange_\(/, "업로드/삭제 성공 시 브로드캐스트 발신 필요");
  assert.match(store, /loadedPhotoTrades\.delete\(/, "수신 시 사진 캐시 무효화 필요");
  assert.match(store, /photo-sync/, "공유 브로드캐스트 채널명이 있어야 한다");
});

test("사진 큐 전역 요약: 실패/대기 잡 수가 스토어 상태로 노출되고 배지가 렌더된다", () => {
  const queue = read("lib/data/photoUploadQueue.ts");
  const store = read("lib/data/store.ts");
  const shell = read("components/AppShell.tsx");
  assert.match(queue, /listPhotoUploadJobs|snapshotPhotoUploadJobs/, "큐 잡 스냅샷 export 필요");
  assert.match(queue, /notifyQueueChange|onQueueChange|queueChangeListeners/, "큐 변경 알림 훅 필요");
  assert.match(store, /photoQueueSummary/, "스토어 상태에 사진 큐 요약이 있어야 한다");
  assert.match(shell, /photoQueueSummary|PhotoQueueBadge/, "AppShell에 전역 배지가 있어야 한다");
});

test("제외 tombstone: 번호 재사용된 새 장비를 숨기지 않고, 추가 확정 시 해제된다", () => {
  const store = read("lib/data/store.ts");
  // 장비명 인지형: 이름이 다르면 재사용된 새 장비 — 필터하지 않는다
  assert.match(store, /tomb\.name && String\(item\.name \|\| ""\)\.trim\(\) !== String\(tomb\.name\)\.trim\(\)/,
    "tombstone은 장비명이 같을 때만 숨겨야 한다");
  // 추가 확정 시 해제
  assert.match(store, /function clearExcludedItemTombstones_\(/, "추가 확정 시 tombstone 해제 헬퍼 필요");
  assert.match(store, /clearExcludedItemTombstones_\(tradeId, Array\.from\(ids\)\)/,
    "현장추가 확정 품목의 tombstone을 해제해야 한다");
  // 기록 시 장비명 포함
  assert.match(store, /recordExcludedItemTombstone_\(entry\.tradeId, entry\.scheduleId, entry\.equipName\)/);
});

test("autoForce는 재시도·재생 경로에도 전파되어 서버 기준선 재검증이 유지된다", () => {
  const store = read("lib/data/store.ts");
  assert.match(store, /autoForce\?: boolean/, "완료 outbox 엔트리에 autoForce가 있어야 한다");
  assert.match(store, /autoForce: force && !hasCheckoutBaseline/, "outbox 기록 시 autoForce 저장");
  assert.match(store, /latest\.force && latest\.autoForce \? \{ autoForce: 1 \}/, "재생 경로 전파");
  assert.match(store, /force && autoForce \? \{ autoForce: 1 \}/, "결과 재확인 경로 전파");
});

test("사진 큐: online 부활도 네트워크 원인 게이트를 지키고, 오프라인 wake는 공회전하지 않는다", () => {
  const q = read("lib/data/photoUploadQueue.ts");
  assert.match(q, /addEventListener\("online"[\s\S]{0,900}NETWORK_ERROR_RE\.test\(String\(job\.lastError \|\| ""\)\)/,
    "online 부활도 재시작 부활과 같은 네트워크 원인 게이트를 써야 한다");
  assert.match(q, /const delay = Math\.max\(offline \? 60_000 : 250/,
    "오프라인엔 250ms 4Hz 공회전 대신 60초 폴백");
});
