function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

// 공개 GET 하나로 내부 조회·쓰기 권한을 함께 열어 두던 구형 범용 프록시다.
// 인증된 Today Dashboard가 운영 경로를 대체했으므로 전달 로직을 남기지 않는다.
export default async function handler(_req, res) {
  return json(res, 410, {
    error: 'retired',
    replacement: 'https://today-dashboard-ten.vercel.app/',
  });
}
