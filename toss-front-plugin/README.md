# VILLAGE 셀프 카드결제 — 토스 프론트 플러그인

직원이 자리를 비웠을 때, 손님이 매장 토스 단말기에서 **직접** 결제하는 화면.
예약 조회 결제뿐 아니라 현장에서 금액만 입력하는 카드결제도 지원한다.

```
손님: 대기화면 → [전화번호/예약번호] 입력 → 내 예약·금액 표시 → 선택 → 카드결제
                         │                          │                        │
                   우리 서버 /api/lookup        Supabase village.trades   토스 단말 카드승인
                                                                              │
                                              우리 서버 /api/lookup/confirm → 시트 '입금완료'

현장: 대기화면 → [금액 직접 결제] → 금액 입력 → 카드결제
                                              │
                                         토스 단말 카드승인

영수증: 대기화면 → [영수증 재출력] → 예약/직접결제 내역 선택 → 토스 공식 영수증 출력
```

화면은 토스 프론트 공식 Template API로만 렌더링한다. 토스 SDK가 관리하는 `#app` DOM을
직접 비우거나 자체 HTML/CSS 대기화면을 삽입하지 않는다.

## 파일

| 파일 | 역할 |
|------|------|
| `village-front/index.html` | 진입점 — 토스 SDK + config.js + app.js 로드 |
| `village-front/app.js` | 전체 흐름(조회→선택→결제→완료반영·공식 영수증 재출력) |
| `village-front/config.js` | 서버주소·토큰 (git 제외, **직접 생성**) |
| `village-front/config.example.js` | config.js 템플릿 |
| `build-zip.sh` | 업로드용 ZIP 생성 |

서버측(이미 구현됨, 같은 레포):
- `apps/today-dashboard/app/api/lookup/route.ts` — 미결제 예약 조회
- `apps/today-dashboard/app/api/lookup/receipts/route.ts` — 결제완료 예약 조회
- `apps/today-dashboard/app/api/lookup/confirm/route.ts` — 카드결제 후 '입금완료' 반영

---

## 내가 해야 할 일 (체크리스트)

### 1. 서버 토큰 맞추기
`config.js`의 `LOOKUP_TOKEN` 과 **똑같은 값**을 서버 환경변수에 설정.
- Vercel → **today-dashboard** 프로젝트 → Settings → Environment Variables
- `LOOKUP_TOKEN` = (config.js와 동일)
- `SUPABASE_SERVICE_ROLE_KEY` 도 설정돼 있어야 함(RLS 우회 조회).
- 저장 후 **재배포**해야 적용됨.

### 2. 토스 개발자센터 ACL 등록
프론트 플러그인 앱 설정 → **등록 서버 URL(ACL)** 에 추가:
```
https://today-dashboard-ten.vercel.app
```
(이게 있어야 단말기가 우리 서버를 호출할 수 있음)

### 3. ZIP 만들어 업로드
```bash
cd toss-front-plugin
./build-zip.sh           # village-front.zip 생성
```
토스 개발자센터 → 프론트 플러그인 → ZIP 업로드 → **개발용 테스트 단말기(최대 5대)** 에 배포.

### 4. 단말기에서 테스트
- 단말기를 **개발자 모드**로 두고 플러그인 실행.
- 실제 예약 전화번호로 조회 → 금액 확인 → (테스트 카드로) 결제 → 잠시 후 시트가 '입금완료'로 바뀌는지 확인.
- 운영 전환 시 `config.js`의 `TEST_MODE: false`.

---

## ZIP 구조 주의
`build-zip.sh`는 `index.html`, `settings.html`, `app.js`, `config.js`를 ZIP 최상위에 둡니다.
`config.js`에는 시크릿이 있으므로 Git에 추가하지 말고 업로드 ZIP만 안전하게 보관하세요.

## 아직 토스 승인/제공 대기 중일 수 있음
토스가 계정에 **프론트 플러그인 업로드 기능**을 열어줘야 3번이 가능합니다.
("프론트 배송 대기" 안내를 받았다면, 단말기 하드웨어가 아니라 이 기능 활성화를 기다리는 것일 수 있음.)
코드는 지금 완성돼 있으니, 열리면 1~4번만 하면 바로 동작합니다.

## 운영 전환 시 보안 (나중에)
현재 인증은 `x-lookup-token`(공유 시크릿)입니다. 단말기 전용·ACL 제한이라 테스트엔 충분하지만,
정식 운영 땐 토스가 정하는 서명/HMAC 방식으로 `checkToken`을 교체하세요(설계문서 참고).
