const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const authGate = read("apps/today-dashboard/components/AuthGate.tsx");
const route = read("apps/today-dashboard/app/api/guides/route.ts");
const server = read("apps/today-dashboard/lib/server/youtubeGuides.ts");
const library = read("apps/today-dashboard/components/guides/GuideVideoLibrary.tsx");
const myPageClient = read("apps/today-dashboard/app/my/MyPageClient.tsx");

assert(authGate.includes('"/guides"'), "장비 사용법 페이지는 직원 로그인 없이 열려야 한다");
assert(route.includes("rateLimited") && route.includes("getYouTubeGuideVideos"), "공개 영상 API는 호출 제한과 서버 조회 경로를 사용해야 한다");
assert(server.includes("YOUTUBE_DATA_API_KEY") && server.includes("YOUTUBE_GUIDES_PLAYLIST_ID"), "YouTube 키와 재생목록 ID는 서버 환경변수여야 한다");
assert(server.includes('import "server-only"'), "YouTube API 키를 쓰는 모듈은 서버 전용이어야 한다");
assert(!library.includes("YOUTUBE_DATA_API_KEY"), "YouTube API 키를 고객 브라우저 코드에 노출하면 안 된다");
assert(library.includes("youtube-nocookie.com") || read("apps/today-dashboard/lib/guides/core.mjs").includes("youtube-nocookie.com"), "영상은 개인정보 보호 강화 임베드를 사용해야 한다");
assert(myPageClient.includes("GuideVideoLibrary") && myPageClient.includes('mode="reservation"'), "내 예약 페이지는 예약 장비와 맞는 사용법 영상을 표시해야 한다");
assert(!route.includes("export async function POST"), "고객용 영상 API는 읽기 전용이어야 한다");
assert(!route.includes("error.message"), "외부 API 오류 원문을 고객에게 노출하면 안 된다");

console.log("equipment-video-guides static tests passed");
