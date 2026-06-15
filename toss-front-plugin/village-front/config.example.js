// VILLAGE 프론트 플러그인 설정 (예시)
// ── 이 파일을 같은 폴더에 config.js 로 복사한 뒤 값을 채우세요. ──
//    config.js 는 git에 올리지 않습니다(.gitignore). ZIP 빌드 때만 포함됩니다.
window.CONFIG = {
  // 우리 조회/확정 서버(today-dashboard).
  // ⚠️ 토스 개발자센터 ACL '등록 서버 URL' 에도 이 도메인을 넣어야 단말기가 호출 가능.
  LOOKUP_BASE: 'https://today-dashboard-ten.vercel.app',

  // 서버 환경변수 LOOKUP_TOKEN 과 '똑같은' 값.
  // (Vercel → today-dashboard 프로젝트 → Settings → Environment Variables)
  LOOKUP_TOKEN: 'PUT-THE-SAME-TOKEN-AS-SERVER',

  // 개발/미리보기용. 실제 단말기에 올릴 땐 false 권장(단말기 자체 시리얼·매장 사용).
  TEST_MODE: true,
  TEST_SERIAL: '000000000000000',
  TEST_MERCHANT: { id: 0, name: 'VILLAGE(테스트)', businessNumber: '0000000000' },
};
