const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const appRoot = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(appRoot, file), "utf8");

function sourceFunction(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${startMarker} 구현을 찾을 수 있어야 한다`);
  return source.slice(start, end);
}

test("쓰기 액션 후 관련 읽기 캐시만 선별 무효화한다 (GET·POST 양쪽)", () => {
  const route = read("app/api/gas/route.ts");
  const callGet = sourceFunction(route, "async function callGet", "\nasync function callPost");
  const callPost = sourceFunction(route, "async function callPost", "\nexport async function GET");
  assert.match(callGet, /if \(isWrite\) \{[\s\S]*?invalidateCacheForWrite\(action\)/, "GET 쓰기 경로에서 관련 캐시를 비워야 한다");
  assert.match(callPost, /if \(isWrite\) invalidateCacheForWrite\(action\)/, "POST 쓰기 경로에서 관련 캐시를 비워야 한다");
  // 전체 clear는 연속 쓰기 중 사진/카탈로그 캐시까지 전멸시키므로 금지
  assert.doesNotMatch(callGet, /cache\.clear\(\)/, "쓰기마다 캐시 전체 clear 금지 (선별 무효화)");
  assert.doesNotMatch(callPost, /cache\.clear\(\)/, "쓰기마다 캐시 전체 clear 금지 (선별 무효화)");
});

test("선별 무효화: 화면 데이터는 비우고 사진/카탈로그 캐시는 유지한다", () => {
  const route = read("app/api/gas/route.ts");
  const volatileRe = /VOLATILE_ACTION_RE = \/(.+)\/;/.exec(route);
  assert.ok(volatileRe, "VOLATILE_ACTION_RE가 정의돼야 한다");
  const re = new RegExp(volatileRe[1]);
  // 쓰기 영향이 있는 화면 데이터는 무효화 대상
  assert.ok(re.test("action=dashboard&date=2026-07-18&key=x"), "dashboard 캐시는 무효화돼야 한다");
  assert.ok(re.test("key=x&action=timeline&from=a&to=b"), "timeline 캐시는 무효화돼야 한다");
  assert.ok(re.test("action=dashboardSearch&q=abc"), "검색 캐시는 무효화돼야 한다");
  // 쓰기와 무관한 무거운 읽기(사진 배치·장비 카탈로그·레이더)는 유지
  assert.ok(!re.test("action=dashboardPhotosBatch&tids=x"), "사진 배치 캐시는 유지돼야 한다");
  assert.ok(!re.test("action=dashboardEquipmentCatalog"), "장비 카탈로그 캐시는 유지돼야 한다");
  assert.ok(!re.test("action=radar"), "레이더 캐시는 유지돼야 한다");
  // 단, 사진 업로드 쓰기는 사진 캐시도 함께 무효화
  assert.match(route, /uploadDashboardPhoto[\s\S]*?dashboardPhoto/, "사진 업로드 시 사진 캐시를 무효화해야 한다");
});

test("nocache=1 요청은 프록시 캐시를 우회하되 GAS로는 파라미터를 그대로 전달한다", () => {
  const route = read("app/api/gas/route.ts");
  const callGet = sourceFunction(route, "async function callGet", "\nasync function callPost");
  assert.match(callGet, /sp\.get\("nocache"\)/, "nocache 파라미터를 해석해야 한다");
  assert.match(callGet, /if \(!isWrite && !noCache\)/, "nocache면 캐시 조회를 건너뛰어야 한다");
  assert.match(callGet, /r\.ok && !noCache && isCacheableBody\(body\)/, "nocache면 응답도 캐시하지 않아야 한다");
  // qs는 sp 전체 복사라 nocache가 GAS로 전달됨 — 삭제 코드가 없어야 한다
  assert.doesNotMatch(callGet, /qs\.delete\("nocache"\)/, "GAS 자체 CacheService 우회용 nocache는 전달을 유지한다");
});

test("에러 응답은 캐시하지 않고 업스트림 상태를 전파한다", () => {
  const route = read("app/api/gas/route.ts");
  const callGet = sourceFunction(route, "async function callGet", "\nasync function callPost");
  const callPost = sourceFunction(route, "async function callPost", "\nexport async function GET");
  assert.match(callGet, /r\.ok && !noCache && isCacheableBody\(body\)/, "r.ok + 정상 JSON일 때만 캐시해야 한다");
  assert.match(callGet, /status: r\.status/, "GET 응답이 업스트림 상태를 전파해야 한다");
  assert.match(callPost, /status: r\.status/, "POST 응답이 업스트림 상태를 전파해야 한다");
});

test("isCacheableBody: 정상 JSON만 캐시 대상 — {error:...}·HTML은 제외", () => {
  const route = read("app/api/gas/route.ts");
  const source = sourceFunction(route, "function isCacheableBody", "\n// 읽기 액션 화이트리스트")
    .replace(/\(body: string\): boolean/, "(body)")
    .replace(/const parsed: unknown =/, "const parsed =");
  const context = {};
  vm.runInNewContext(`${source}\nthis.isCacheableBody = isCacheableBody;`, context);
  assert.equal(context.isCacheableBody(JSON.stringify({ trades: [] })), true);
  assert.equal(context.isCacheableBody(JSON.stringify({ error: "쿼터 초과", stack: "..." })), false);
  assert.equal(context.isCacheableBody("<html><body>Error</body></html>"), false);
});

test("읽기 캐시에 상한과 만료 스윕이 있어 무한 성장하지 않는다", () => {
  const route = read("app/api/gas/route.ts");
  assert.match(route, /const MAX_CACHE_SIZE = \d+/, "캐시 상한 상수가 있어야 한다");
  assert.match(route, /function pruneCache/, "pruneCache가 있어야 한다");
  const callGet = sourceFunction(route, "async function callGet", "\nasync function callPost");
  assert.match(callGet, /cache\.delete\(ck\)/, "만료 히트는 즉시 삭제해야 한다");
  assert.match(callGet, /if \(cache\.size > MAX_CACHE_SIZE\) pruneCache/, "저장 후 상한 초과 시 정리해야 한다");
});

test("/api/confirm — 업스트림 상태 전파 + 정상 JSON 목록만 캐시", () => {
  const route = read("app/api/confirm/route.ts");
  const callGas = sourceFunction(route, "async function callGas", "\n// GAS가 200 상태로");
  assert.match(callGas, /status: r\.status/, "callGas가 업스트림 상태를 전파해야 한다");
  assert.match(route, /res\.ok && isCacheableListBody\(body\)/, "성공 + 정상 JSON일 때만 목록을 캐시해야 한다");
});
