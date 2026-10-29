// 2026-10-28 세트마스터 A/B/C/F 실조회. 가격·재고와 분리된 동봉품 선택 목록.
// 동일 실물은 아래 명시적 별칭만 공유한다. 일반 D탭을 단자/전압 추측으로 합치지 않는다.
export const PACKING_TEMPLATES: Record<string, {name: string; qty: number}[]> = {
  "레드 코모도 풀세트": [{"name":"레드 코모도 6K 바디(케이지)","qty":1},{"name":"100볼 트라이","qty":1},{"name":"베이비","qty":1},{"name":"하이햇","qty":1},{"name":"7인치 모니터","qty":1},{"name":"AV PRO CF 512","qty":2},{"name":"AV PRO CF 256","qty":1},{"name":"AV PRO CF 리더기","qty":1},{"name":"V마운트 배터리","qty":4},{"name":"V마운트 배터리 충전기","qty":1},{"name":"LVM-170A","qty":1}],
  "소니 FX3 바디세트": [{"name":"소니 FX3 바디(케이지)","qty":1},{"name":"소니 CF-A 160","qty":2},{"name":"소니 CF-A 리더기","qty":1},{"name":"NP-FZ100","qty":3},{"name":"NP-FZ100 충전기","qty":1}],
  "소니 A7S3 풀세트": [{"name":"소니 A7S3 바디(케이지)","qty":1},{"name":"75볼 트라이","qty":1},{"name":"베이비","qty":1},{"name":"하이햇","qty":1},{"name":"5인치 모니터","qty":1},{"name":"매트박스","qty":1},{"name":"소니 CF-A 160","qty":2},{"name":"소니 CF-A 리더기","qty":1},{"name":"V마운트 배터리","qty":2},{"name":"V마운트 배터리 충전기","qty":1},{"name":"NP-FZ100","qty":3},{"name":"NP-FZ100 충전기","qty":1},{"name":"매직암","qty":1},{"name":"소니 A7S3 풀세트용 HDMI 라인","qty":1},{"name":"소니 A7S3 풀세트용 970더미","qty":1},{"name":"소니 A7S3 풀세트용 C to C","qty":1}],
  "소니 FX3 풀세트": [{"name":"소니 FX3 바디(케이지)","qty":1},{"name":"75볼 트라이","qty":1},{"name":"베이비","qty":1},{"name":"하이햇","qty":1},{"name":"5인치 모니터","qty":1},{"name":"매트박스","qty":1},{"name":"소니 CF-A 160","qty":2},{"name":"소니 CF-A 리더기","qty":1},{"name":"V마운트 배터리","qty":2},{"name":"V마운트 배터리 충전기","qty":1},{"name":"NP-FZ100","qty":3},{"name":"NP-FZ100 충전기","qty":1},{"name":"매직암","qty":1},{"name":"소니 FX3 풀세트용 HDMI 라인","qty":1},{"name":"소니 FX3 풀세트용 970더미","qty":1},{"name":"소니 FX3 풀세트용 C to C","qty":1}],
  "소니 FX6 풀세트": [{"name":"소니 FX6 바디(케이지)","qty":1},{"name":"100볼 트라이","qty":1},{"name":"베이비","qty":1},{"name":"하이햇","qty":1},{"name":"7인치 모니터","qty":1},{"name":"매트박스","qty":1},{"name":"소니 CF-A 160","qty":2},{"name":"소니 CF-A 리더기","qty":1},{"name":"V마운트 배터리","qty":4},{"name":"V마운트 배터리 충전기","qty":1},{"name":"LVM-170A","qty":1},{"name":"소니 FX6 풀세트용 SDI 롱라인","qty":1},{"name":"소니 FX6 풀세트용 SDI 라인","qty":1},{"name":"노가암","qty":1}],
  "소니 FX9 풀세트": [{"name":"소니 FX9 바디(케이지)","qty":1},{"name":"100볼 트라이","qty":1},{"name":"베이비","qty":1},{"name":"하이햇","qty":1},{"name":"7인치 모니터","qty":1},{"name":"매트박스","qty":1},{"name":"소니 XQD 256","qty":1},{"name":"소니 XQD 128","qty":2},{"name":"V마운트 배터리","qty":4},{"name":"V마운트 배터리 충전기","qty":1},{"name":"LVM-170A","qty":1},{"name":"소니 FX9 풀세트용 SDI 롱라인","qty":1},{"name":"소니 FX9 풀세트용 SDI 라인","qty":1},{"name":"노가암","qty":1}],
  "포켓 6K 풀세트": [{"name":"BMPCC 6K 바디(케이지)","qty":1},{"name":"75볼 트라이","qty":1},{"name":"베이비","qty":1},{"name":"하이햇","qty":1},{"name":"5인치 모니터","qty":1},{"name":"삼성 T5 1TB SSD","qty":2},{"name":"V마운트 배터리","qty":2},{"name":"포켓 6K 풀세트용 970 더미","qty":1},{"name":"포켓 6K 풀세트용 HDMI 라인","qty":1},{"name":"포켓 6K 풀세트용 멀티 D탭","qty":1}],
  "포켓 6K 프로 풀세트": [{"name":"BMPCC 6K PRO 바디(케이지)","qty":1},{"name":"75볼 트라이","qty":1},{"name":"베이비","qty":1},{"name":"하이햇","qty":1},{"name":"5인치 모니터","qty":1},{"name":"삼성 T5 1TB SSD","qty":2},{"name":"V마운트 배터리","qty":2},{"name":"포켓 6K 프로 풀세트용 970 더미","qty":1},{"name":"포켓 6K 프로 풀세트용 HDMI 라인","qty":1},{"name":"포켓 6K 프로 풀세트용 멀티 D탭","qty":1}],
  "소니 BURANO 풀세트": [{"name":"소니 BURANO 바디(풀케이지)","qty":1},{"name":"셔틀러 비디오 20","qty":1},{"name":"베이비","qty":1},{"name":"하이햇","qty":1},{"name":"7인치 모니터","qty":1},{"name":"소니 CF-B 1920","qty":1},{"name":"소니 CF-B 960","qty":2},{"name":"소니 CF-B 리더기","qty":1},{"name":"V마운트 배터리(SWIT)","qty":4},{"name":"V마운트 배터리 충전기(SWIT)","qty":1},{"name":"LVM-180A","qty":1},{"name":"매트박스","qty":1},{"name":"뉴클-M","qty":1},{"name":"테라덱 볼트 1000 XT (1:1)","qty":1},{"name":"노가암","qty":1},{"name":"숏암","qty":1},{"name":"숏암+클램프","qty":1},{"name":"스몰HD용 SDI 연선","qty":1},{"name":"테라덱용 SDI 연선","qty":2},{"name":"여분 SDI 연선","qty":2},{"name":"BURANO 바디용 멀티 D탭","qty":2}],
  "소니 캠 AX-700": [{"name":"소니 캠 AX-700용 메모리","qty":1},{"name":"소니 캠 AX-700용 배터리","qty":2},{"name":"소니 캠 AX-700용 앞캡","qty":1},{"name":"소니 캠 AX-700용 후드","qty":1}],
  "소니 BURANO 베이직세트": [{"name":"소니 BURANO 바디(풀케이지)","qty":1},{"name":"셔틀러 비디오 20","qty":1},{"name":"베이비","qty":1},{"name":"하이햇","qty":1},{"name":"7인치 모니터","qty":1},{"name":"소니 CF-B 1920","qty":1},{"name":"소니 CF-B 960","qty":2},{"name":"소니 CF-B 리더기","qty":1},{"name":"V마운트 배터리(SWIT)","qty":4},{"name":"V마운트 배터리 충전기(SWIT)","qty":1},{"name":"LVM-180A","qty":1},{"name":"노가암","qty":1},{"name":"SDI 연선","qty":1},{"name":"소니 BURANO 베이직세트용 멀티 D탭","qty":1},{"name":"매트박스","qty":1}],
  "소니 A7S3 바디세트": [{"name":"소니 A7S3 바디(케이지)","qty":1},{"name":"소니 CF-A 160","qty":2},{"name":"소니 CF-A 리더기","qty":1},{"name":"NP-FZ100","qty":3},{"name":"NP-FZ100 충전기","qty":1}],
  "소니 FX6 바디세트": [{"name":"소니 FX6 바디(케이지)","qty":1},{"name":"소니 CF-A 160","qty":2},{"name":"소니 CF-A 리더기","qty":1},{"name":"V마운트 배터리","qty":2}],
  "소니 캠 AX-43A": [{"name":"소니 캠 AX-43A용 메모리","qty":1},{"name":"소니 캠 AX-43A용 배터리","qty":2}],
  "캐논 오막포": [{"name":"캐논 오막포용 메모리","qty":1},{"name":"캐논 오막포용 배터리","qty":2},{"name":"캐논 오막포용 바디캡","qty":1}],
  "소니 FX9 바디세트": [{"name":"소니 FX9 바디(케이지)","qty":1},{"name":"소니 XQD 240","qty":1},{"name":"소니 XQD 120","qty":2},{"name":"V마운트 배터리","qty":2}],
  "고프로 히어로10": [{"name":"고프로 히어로10용 마이크로SD","qty":1},{"name":"고프로 히어로10용 배터리","qty":3},{"name":"고프로 히어로10용 충전기","qty":1}],
  "캐논 오막포+백사투": [{"name":"캐논 오막포 바디","qty":1},{"name":"캐논 백사투 렌즈","qty":1},{"name":"캐논 오막포+백사투용 메모리","qty":1},{"name":"캐논 오막포+백사투용 배터리","qty":2},{"name":"캐논 오막포+백사투용 앞캡","qty":1},{"name":"캐논 오막포+백사투용 뒷캡","qty":1},{"name":"캐논 오막포+백사투용 후드","qty":1}],
  "고프로 히어로11": [{"name":"고프로 히어로11용 마이크로SD","qty":1},{"name":"고프로 히어로11용 배터리","qty":3},{"name":"고프로 히어로11용 충전기","qty":1}],
  "캐논 R6 Mark 2 + 100-500": [{"name":"캐논 R6 Mark 2 바디","qty":1},{"name":"캐논 100-500 렌즈","qty":1},{"name":"캐논 R6 Mark 2 + 100-500용 메모리","qty":1},{"name":"캐논 R6 Mark 2 + 100-500용 배터리","qty":2},{"name":"캐논 R6 Mark 2 + 100-500용 앞캡","qty":1},{"name":"캐논 R6 Mark 2 + 100-500용 뒷캡","qty":1},{"name":"캐논 R6 Mark 2 + 100-500용 후드","qty":1}],
  "레드 코모도 바디세트": [{"name":"레드 코모도 6K 바디(케이지)","qty":1},{"name":"AV PRO CF 512","qty":2},{"name":"AV PRO CF 256","qty":1},{"name":"V마운트 배터리","qty":2}],
  "고프로 히어로12": [{"name":"고프로 히어로12용 마이크로SD","qty":1},{"name":"고프로 히어로12용 배터리","qty":3},{"name":"고프로 히어로12용 충전기","qty":1}],
  "캐논 R6 Mark 2": [{"name":"캐논 R6 Mark 2용 메모리","qty":1},{"name":"캐논 R6 Mark 2용 배터리","qty":2},{"name":"캐논 R6 Mark 2용 바디캡","qty":1}],
  "DJI 오즈모 포켓3": [{"name":"DJI 오즈모 포켓3용 본체","qty":1},{"name":"DJI 오즈모 포켓3용 마이크로SD","qty":1},{"name":"DJI 오즈모 포켓3용 여분 배터리","qty":1}],
  "소니 Z90": [{"name":"소니 Z90용 메모리","qty":1},{"name":"소니 Z90용 배터리","qty":2},{"name":"소니 Z90용 앞캡","qty":1},{"name":"소니 Z90용 렌즈 후드","qty":1}],
  "인스타 360 X5": [{"name":"인스타 360 X5용 셀피 스틱","qty":1}],
  "줌 F6": [{"name":"줌 F6용 32기가 메모리","qty":1},{"name":"줌 F6용 전용 가방","qty":1}],
  "소니 ECM-673": [{"name":"소니 ECM-673용 블림프","qty":1},{"name":"소니 ECM-673용 붐폴","qty":1},{"name":"소니 ECM-673용 XLR","qty":1},{"name":"소니 ECM-673용 데드캣","qty":1}],
  "홀리랜드 솔리드컴 4S": [{"name":"홀리랜드 솔리드컴 4S용 배터리","qty":8},{"name":"홀리랜드 솔리드컴 4S용 충전기","qty":1}],
  "하만카돈": [{"name":"하만카돈용 충전기","qty":1}],
  "줌 H8": [{"name":"줌 H8용 32기가 메모리","qty":1}],
  "홀리랜드 솔리드컴 6S": [{"name":"홀리랜드 솔리드컴 6S용 배터리","qty":12},{"name":"홀리랜드 솔리드컴 6S용 충전기","qty":1}],
  "JBL 파티박스": [{"name":"JBL 파티박스용 마이크","qty":2},{"name":"JBL 파티박스용 마이크 송신기","qty":1}],
  "소니 UWP-D21": [{"name":"소니 UWP-D21용 핀마이크(솜, 클립)","qty":1},{"name":"소니 UWP-D21용 3.5 라인","qty":1},{"name":"소니 UWP-D21용 XLR 라인","qty":1}],
  "FT-2400i 인터컴": [{"name":"FT-2400i 인터컴용 이어셋","qty":5}],
  "DJI 마이크 미니2": [{"name":"DJI 마이크 미니2용 TX","qty":1},{"name":"DJI 마이크 미니2용 RX","qty":2},{"name":"DJI 마이크 미니2용 3.5 라인","qty":1}],
  "모토로라 무전기": [{"name":"모토로라 무전기 본체","qty":2},{"name":"모토로라 무전기용 이어폰","qty":2},{"name":"모토로라 무전기용 충전기","qty":2}],
  "젠하이저 MKH-416P": [{"name":"젠하이저 MKH-416P용 블림프","qty":1},{"name":"젠하이저 MKH-416P용 붐폴","qty":1},{"name":"젠하이저 MKH-416P용 XLR","qty":1},{"name":"젠하이저 MKH-416P용 데드캣","qty":1}],
  "로닌 RS4 프로": [{"name":"로닌 RS4 프로용 배터리그립","qty":1},{"name":"로닌 RS4 프로용 플레이트","qty":2}],
  "핫도그 슬라이더": [{"name":"핫도그 슬라이더용 비디오 헤드","qty":1},{"name":"75볼 트라이","qty":2},{"name":"핫도그 슬라이더용 970배터리","qty":2}],
  "로닌 RS3 프로": [{"name":"로닌 RS3 프로용 배터리그립","qty":1},{"name":"로닌 RS3 프로용 플레이트","qty":2}],
  "틸타 시네 슬라이더": [{"name":"베이비 콤보 스탠드","qty":2}],
  "맨프로토 143A": [{"name":"맨프로토 143A용 매직캠","qty":1},{"name":"슈퍼클램프","qty":1}],
  "로닌 RS2 프로": [{"name":"로닌 RS2 프로용 배터리그립","qty":1},{"name":"로닌 RS2 프로용 플레이트","qty":2}],
  "KSH17 프롬프터": [{"name":"KSH17 프롬프터용 C to HDMI","qty":1},{"name":"100볼 트라이","qty":1}],
  "지윤 크레인 3S": [{"name":"지윤 크레인 3S용 파워박스","qty":1},{"name":"지윤 크레인 3S용 듀얼그립 or 링그립","qty":1}],
  "MOVMAX RAZOR ARM": [{"name":"MOVMAX RAZOR ARM용 아이솔레이터","qty":1},{"name":"MOVMAX RAZOR ARM용 브라켓","qty":1},{"name":"MOVMAX RAZOR ARM용 도브테일","qty":1},{"name":"MOVMAX RAZOR ARM용 나토레일","qty":1},{"name":"MOVMAX RAZOR ARM용 석션컵 브라켓(롱숏)","qty":1},{"name":"MOVMAX RAZOR ARM용 파워서플라이 플레이트","qty":1},{"name":"MOVMAX RAZOR ARM용 2핀 LEMO","qty":1},{"name":"MOVMAX RAZOR ARM용 V프레이트","qty":1},{"name":"MOVMAX RAZOR ARM용 공기주입기","qty":1}],
  "에코플로우 델타2 맥스": [{"name":"에코플로우 델타2 맥스용 AC라인","qty":1}],
  "에코플로우 델타2": [{"name":"에코플로우 델타2용 AC라인","qty":1}],
  "무선세트(17인치)": [{"name":"17인치 모니터","qty":1},{"name":"무선 송수신기","qty":1},{"name":"뉴클-M","qty":1}],
  "무선세트(7인치)": [{"name":"7인치 모니터","qty":1},{"name":"무선 송수신기","qty":1},{"name":"뉴클-M","qty":1}],
  "뉴클-M": [{"name":"뉴클-M용 모터","qty":1},{"name":"뉴클-M용 컨트롤러","qty":1},{"name":"뉴클-M용 D탭","qty":1},{"name":"뉴클-M용 배터리","qty":4},{"name":"뉴클-M용 충전기","qty":1}],
  "마스 400S 프로": [{"name":"마스 400S 프로용 D탭","qty":2},{"name":"마스 400S 프로용 SDI or HDMI","qty":2},{"name":"마스 400S 프로용 숏암","qty":2}],
  "테라덱 볼트 500LT (1:1)": [{"name":"테라덱 볼트 500LT용 D탭","qty":2},{"name":"테라덱 볼트 500LT용 SDI","qty":2},{"name":"테라덱 볼트 500LT용 안테나","qty":2},{"name":"테라덱 볼트 500LT용 숏암","qty":2}],
  "뉴클-N2": [{"name":"뉴클-N2용 모터","qty":1},{"name":"뉴클-N2용 컨트롤러","qty":1},{"name":"뉴클-N2용 C to D탭","qty":1},{"name":"뉴클-N2용 로드","qty":1},{"name":"뉴클-N2용 클램프","qty":1},{"name":"뉴클-N2용 기어링","qty":1}],
  "마스 400S 프로(1:2)": [{"name":"마스 400S 프로용 D탭","qty":3},{"name":"마스 400S 프로용 SDI or HDMI","qty":3},{"name":"마스 400S 프로용 안테나","qty":6},{"name":"마스 400S 프로용 숏암","qty":3}],
  "테라덱 볼트 1000XT (1:1)": [{"name":"테라덱 볼트 1000XT용 D탭","qty":2},{"name":"테라덱 볼트 1000XT용 안테나","qty":7},{"name":"테라덱 볼트 1000XT용 SDI","qty":2},{"name":"테라덱 볼트 1000XT용 숏암","qty":2}],
  "PD 무비 LIVE AIR3": [{"name":"PD 무비 LIVE AIR3용 모터","qty":1},{"name":"PD 무비 LIVE AIR3용 컨트롤러","qty":1},{"name":"PD 무비 LIVE AIR3용 그립","qty":1},{"name":"PD 무비 LIVE AIR3용 미니로드","qty":2},{"name":"PD 무비 LIVE AIR3용 어댑터","qty":1},{"name":"PD 무비 LIVE AIR3용 모터 배터리","qty":2},{"name":"PD 무비 LIVE AIR3용 컨트롤러 배터리","qty":2}],
  "마스 400S": [{"name":"마스 400S용 D탭","qty":2},{"name":"마스 400S용 SDI or HDMI","qty":2},{"name":"마스 400S용 숏암","qty":2}],
  "테라덱 볼트 1000XT (1:2)": [{"name":"테라덱 볼트 1000XT용 D탭","qty":3},{"name":"테라덱 볼트 1000XT용 안테나","qty":12},{"name":"테라덱 볼트 1000XT용 SDI","qty":3},{"name":"테라덱 볼트 1000XT용 숏암","qty":3}],
  "마스 4K": [{"name":"마스 4K용 D탭","qty":2},{"name":"마스 4K용 SDI or HDMI","qty":2},{"name":"마스 4K용 숏암","qty":2}],
  "바식스 아톰 500": [{"name":"바식스 아톰 500용 970더미","qty":2},{"name":"바식스 아톰 500용 SDI or HDMI","qty":2},{"name":"바식스 아톰 500용 숏암","qty":2}],
  "DJI SDR 트랜스미션": [{"name":"DJI SDR 트랜스미션용 970더미","qty":2},{"name":"DJI SDR 트랜스미션용 SDI or HDMI","qty":2},{"name":"DJI SDR 트랜스미션용 숏암","qty":2}],
  "DJI SDR 트랜스미션(1:2)": [{"name":"DJI SDR 트랜스미션용 970더미","qty":3},{"name":"DJI SDR 트랜스미션용 SDI or HDMI","qty":3},{"name":"DJI SDR 트랜스미션용 숏암","qty":3}],
  "마스 M1": [{"name":"마스 M1용 970더미","qty":1},{"name":"마스 M1용 SDI or HDMI","qty":1},{"name":"마스 M1용 숏암","qty":1}],
  "파이로 S": [{"name":"파이로 S용 D탭","qty":2},{"name":"파이로 S용 SDI or HDMI","qty":2},{"name":"파이로 S용 안테나","qty":6}],
  "파이로 7": [{"name":"파이로 7용 D탭","qty":1},{"name":"파이로 7용 SDI or HDMI","qty":1},{"name":"파이로 7용 안테나","qty":2}],
  "LVM-172W": [{"name":"LVM-172W용 롱 SDI or HDMI","qty":1}],
  "VFM-055A": [{"name":"VFM-055A용 티비로직 D탭","qty":1},{"name":"VFM-055A용 SDI or HDMI","qty":1}],
  "스몰HD 인디7": [{"name":"스몰HD 인디7용 D탭","qty":1},{"name":"스몰HD 인디7용 SDI or HDMI","qty":1}],
  "LVM-170A": [{"name":"LVM-170A용 롱 SDI or HDMI","qty":1}],
  "포트키 BM5": [{"name":"포트키 BM5용 D탭","qty":1},{"name":"포트키 BM5용 SDI or HDMI","qty":1}],
  "티비로직 F-7HS": [{"name":"티비로직 F-7HS용 티비로직 D탭","qty":1},{"name":"티비로직 F-7HS용 SDI or HDMI","qty":1}],
  "LVM-180A": [{"name":"LVM-180A용 롱 SDI or HDMI","qty":1}],
  "포트키 BM7": [{"name":"포트키 BM7용 D탭","qty":1},{"name":"포트키 BM7용 SDI or HDMI","qty":1}],
  "티비로직 LVM-074W": [{"name":"티비로직 LVM-074W용 티비로직 D탭","qty":1},{"name":"티비로직 LVM-074W용 SDI or HDMI","qty":1}],
  "아템 미니 익스트림": [{"name":"아템 미니 익스트림용 AC라인","qty":1}],
  "소니 GM 렌즈 세트(16-35, 24-70, 70-200)": [{"name":"소니 GM 16-35mm","qty":1},{"name":"소니 GM 24-70mm","qty":1},{"name":"소니 GM 70-200mm","qty":1}],
  "시그마 아트 줌렌즈 세트": [{"name":"시그마 아트 18-35mm","qty":1},{"name":"시그마 아트 50-100mm","qty":1}],
  "미니 매트박스": [{"name":"미니 매트박스용 67mm 업링","qty":1},{"name":"미니 매트박스용 72mm 업링","qty":1},{"name":"미니 매트박스용 77mm 업링","qty":1},{"name":"미니 매트박스용 82mm 업링","qty":1}],
  "미라지 매트박스(틸타 MB-T16)": [{"name":"미라지 매트박스(틸타 MB-T16)용 67mm 업링","qty":1},{"name":"미라지 매트박스(틸타 MB-T16)용 72mm 업링","qty":1},{"name":"미라지 매트박스(틸타 MB-T16)용 77mm 업링","qty":1},{"name":"미라지 매트박스(틸타 MB-T16)용 82mm 업링","qty":1}],
  "라오와 24mm Probe": [{"name":"라오와 24mm Probe용 전용케이스","qty":1},{"name":"라오와 24mm Probe용 USB 케이블","qty":1}],
  "어퓨쳐 600X": [{"name":"어퓨쳐 600X용 헤드","qty":1},{"name":"어퓨쳐 600X용 발라스터","qty":1},{"name":"어퓨쳐 600X용 클램프","qty":1},{"name":"어퓨쳐 600X용 라인","qty":2},{"name":"소프트박스","qty":1},{"name":"C스탠드","qty":1}],
  "아마란 300C": [{"name":"아마란 300C용 AC라인","qty":1},{"name":"A스탠드","qty":1}],
  "시네로이드 CFL-800": [{"name":"시네로이드 CFL-800용 패널","qty":1},{"name":"시네로이드 CFL-800용 발라스터","qty":1},{"name":"시네로이드 CFL-800용 연장라인","qty":1},{"name":"시네로이드 CFL-800용 AC라인","qty":1},{"name":"시네로이드 CFL-800용 루버","qty":1},{"name":"시네로이드 CFL-800용 실크","qty":1},{"name":"A스탠드","qty":1}],
  "아마란 F22C": [{"name":"아마란 F22C용 패널","qty":1},{"name":"아마란 F22C용 발라스터","qty":1},{"name":"아마란 F22C용 연장라인","qty":1},{"name":"아마란 F22C용 AC라인","qty":1},{"name":"아마란 F22C용 프레임대","qty":1},{"name":"아마란 F22C용 루버","qty":1},{"name":"아마란 F22C용 실크1","qty":1},{"name":"아마란 F22C용 실크2","qty":1},{"name":"C스탠드","qty":1}],
  "어퓨쳐 600C": [{"name":"어퓨쳐 600C용 헤드","qty":1},{"name":"어퓨쳐 600C용 발라스터","qty":1},{"name":"어퓨쳐 600C용 클램프","qty":1},{"name":"어퓨쳐 600C용 라인","qty":2},{"name":"소프트박스","qty":1},{"name":"C스탠드","qty":1}],
  "어퓨쳐 MC4 KIT": [{"name":"어퓨쳐 MC4 KIT용 실리콘 디퓨전","qty":2},{"name":"어퓨쳐 MC4 KIT용 볼헤드","qty":2},{"name":"어퓨쳐 MC4 KIT용 충전케이스","qty":1},{"name":"어퓨쳐 MC4 KIT용 케이블","qty":1}],
  "파보튜브 6C": [{"name":"파보튜브 6C용 조명기","qty":1},{"name":"파보튜브 6C용 파우치","qty":1}],
  "아마란 F21C": [{"name":"아마란 F21C용 패널","qty":1},{"name":"아마란 F21C용 발라스터","qty":1},{"name":"아마란 F21C용 연장라인","qty":1},{"name":"아마란 F21C용 AC라인","qty":1},{"name":"아마란 F21C용 프레임대","qty":1},{"name":"아마란 F21C용 루버","qty":1},{"name":"아마란 F21C용 실크1","qty":1},{"name":"아마란 F21C용 실크2","qty":1},{"name":"C스탠드","qty":1}],
  "스크림세트": [{"name":"스크림세트용 고보","qty":1},{"name":"스크림세트용 실크","qty":1},{"name":"스크림세트용 싱글","qty":1},{"name":"스크림세트용 더블","qty":1},{"name":"스크림세트용 우드락","qty":1}],
  "어퓨쳐 B7C 8KIT": [{"name":"어퓨쳐 B7C 8KIT용 충전 케이스","qty":1},{"name":"어퓨쳐 B7C 8KIT용 케이블","qty":1}],
  "어퓨쳐 600D": [{"name":"어퓨쳐 600D용 헤드","qty":1},{"name":"어퓨쳐 600D용 발라스터","qty":1},{"name":"어퓨쳐 600D용 클램프","qty":1},{"name":"어퓨쳐 600D용 라인","qty":2},{"name":"소프트박스","qty":1},{"name":"C스탠드","qty":1}],
  "어퓨처 스팟마운트": [{"name":"어퓨처 스팟마운트용 아이리스","qty":1},{"name":"어퓨처 스팟마운트용 고보","qty":3}],
  "난룩스 이보크 1200B": [{"name":"난룩스 이보크 1200B용 헤드","qty":1},{"name":"난룩스 이보크 1200B용 발라스터","qty":1},{"name":"난룩스 이보크 1200B용 라인","qty":2},{"name":"콤보스탠드","qty":1}],
  "아마란 PT4C 2KIT": [{"name":"아마란 PT4C 2KIT용 플로어 스탠드","qty":2},{"name":"아마란 PT4C 2KIT용 아크릴 그립","qty":4},{"name":"아마란 PT4C 2KIT용 오링","qty":2},{"name":"아마란 PT4C 2KIT용 충전기","qty":2}],
  "어퓨쳐 노바 P300C": [{"name":"어퓨쳐 노바 P300C용 헤드","qty":1},{"name":"어퓨쳐 노바 P300C용 발라스터","qty":1},{"name":"어퓨쳐 노바 P300C용 라인","qty":2},{"name":"노바용 소프트박스","qty":1},{"name":"C스탠드","qty":1}],
  "C스탠드": [{"name":"그립헤드","qty":1},{"name":"그립암","qty":1}],
  "아마란 PT4C 4KIT": [{"name":"아마란 PT4C 4KIT용 플로어 스탠드","qty":4},{"name":"아마란 PT4C 4KIT용 아크릴 그립","qty":8},{"name":"아마란 PT4C 4KIT용 오링","qty":4},{"name":"아마란 PT4C 4KIT용 충전기","qty":4}],
  "어퓨쳐 파워스테이션": [{"name":"어퓨쳐 파워스테이션용 본체","qty":1},{"name":"어퓨쳐 파워스테이션용 케이블","qty":3}],
  "어퓨쳐 300X": [{"name":"어퓨쳐 300X용 헤드","qty":1},{"name":"어퓨쳐 300X용 발라스터","qty":1},{"name":"어퓨쳐 300X용 클램프","qty":1},{"name":"어퓨쳐 300X용 라인","qty":2},{"name":"소프트박스","qty":1},{"name":"A스탠드","qty":1}],
  "어퓨쳐 스톰 80C": [{"name":"어퓨쳐 스톰 80C용 헤드","qty":1},{"name":"어퓨쳐 스톰 80C용 리플렉터","qty":1},{"name":"어퓨쳐 스톰 80C용 디퓨져","qty":1},{"name":"어퓨쳐 스톰 80C용 AC 라인","qty":1},{"name":"A스탠드","qty":1}],
  "어퓨쳐 LS 60X": [{"name":"어퓨쳐 LS 60X용 헤드","qty":1},{"name":"어퓨쳐 LS 60X용 반도어","qty":1},{"name":"어퓨쳐 LS 60X용 보웬스 어댑터","qty":1},{"name":"어퓨쳐 LS 60X용 D탭","qty":1},{"name":"어퓨쳐 LS 60X용 AC 라인","qty":1},{"name":"A스탠드","qty":1}],
  "CooKe SP3(25/32/50/75/100)": [{"name":"CooKe SP3용 58mm 업링","qty":3},{"name":"CooKe SP3용 77mm 업링","qty":1}],
  "소니 A7M5 바디세트": [{"name":"소니 A7M5 바디(케이지)","qty":1},{"name":"소니 CF-A 160","qty":2},{"name":"소니 CF-A 리더기","qty":1},{"name":"NP-FZ100","qty":3},{"name":"NP-FZ100 충전기","qty":1}],
  "PYXIS 6K 시네마 풀세트(EF or PL / BRAW·풀프레임)": [{"name":"픽시스 6K 바디(케이지)","qty":1},{"name":"100볼 트라이","qty":1},{"name":"베이비","qty":1},{"name":"하이햇","qty":1},{"name":"TVLogic F-7HS","qty":1},{"name":"틸타 MB-T12","qty":1},{"name":"소니 CF-B 512","qty":2},{"name":"V마운트 배터리","qty":2},{"name":"V마운트 배터리 충전기","qty":1},{"name":"TVLogic 17인치","qty":1},{"name":"픽시스용 SDI 롱라인","qty":1},{"name":"픽시스용 SDI 라인","qty":1},{"name":"노가암","qty":1}],
  "스톰 700X": [{"name":"스톰 700X용 헤드","qty":1},{"name":"스톰 700X용 발라스터","qty":1},{"name":"스톰 700X용 클램프","qty":1},{"name":"스톰 700X용 라인","qty":2},{"name":"소프트박스","qty":1},{"name":"C스탠드","qty":1}],
  "타스캠 레코더": [{"name":"마이크로SD 32기가","qty":1}],
};

export const partKey = (s: string) => s.normalize("NFC").trim().toLowerCase().replace(/\s+/g, "");
const aliases: Record<string, string> = {
  "스몰HD용 D탭": "smallhd-9v", "스몰HD 인디7용 D탭": "smallhd-9v",
  "스몰HD용 D탭 라인 (9V)": "smallhd-9v",
  "뉴클-M용 D탭": "nucleus-m-7pin", "뉴클-M 모터용 D탭 라인 (7핀)": "nucleus-m-7pin",
  "테라덱용 D탭 라인 (2핀)": "teradek-2pin",
  "테라덱 볼트 500LT용 D탭": "teradek-2pin", "테라덱 볼트 1000XT용 D탭": "teradek-2pin",
  "SDI 연선": "CBL-003", "스몰HD용 SDI 연선": "CBL-003", "테라덱용 SDI 연선": "CBL-003", "여분 SDI 연선": "CBL-003",
};
const names: Record<string, string> = {
  "smallhd-9v": "스몰HD용 D탭 라인 (9V)", "smallhd-dummy": "스몰HD용 D탭 더미",
  "teradek-2pin": "테라덱용 D탭 라인 (2핀)", "nucleus-m-7pin": "뉴클-M 모터용 D탭 라인 (7핀)", "CBL-003": "SDI 연선",
};
export const CHOICE = /(?:\bor\b|또는|택\s*1|SDI\s*\/\s*HDMI|HDMI\s*\/\s*SDI)/i;
export const ACCESSORY = /라인|케이블|[dDＤｄ][\s-]*탭|디탭|SDI|HDMI|노가암|숏암|클램프|더미|기어링|플레이트|그립|안테나/i;
const ids = new Map(Object.entries(aliases).map(([n,id]) => [partKey(n), id]));
// UTF-16 문자열 전체를 ID로 인코딩해 해시 충돌/등록 순서 변화에 의존하지 않는다.
function catalogId(name: string) { return "part:" + Array.from(partKey(name)).map(c => c.codePointAt(0)!.toString(16)).join("-"); }
export function canonicalPart(name: string) {
  const id = ids.get(partKey(name)) ?? catalogId(name);
  return { id, name: names[id] ?? name };
}
const catalog = new Map<string, {id: string; name: string}>();
for (const [id,name] of Object.entries(names)) catalog.set(id,{id,name});
for (const rows of Object.values(PACKING_TEMPLATES)) for (const row of rows) {
  if (!ACCESSORY.test(row.name) && !row.name.includes("용 ")) continue;
  if (CHOICE.test(row.name)) {
    // 선택은 한 품목이 아니다. 원래 장비별 명칭을 유지한 두 개의 등록 선택지로 만든다.
    for (const choice of ["SDI", "HDMI"]) {
      const name = row.name.replace(/SDI\s*(?:or|\/)\s*HDMI/i, choice);
      if (!CHOICE.test(name)) { const p=canonicalPart(name); catalog.set(p.id,p); }
    }
  } else { const p=canonicalPart(row.name); catalog.set(p.id,p); }
}
// 현장에서 선택할 수 있는 추가 구성품. 기본 반출 수량에는 자동으로 넣지 않는다.
for (const name of ["소니 캠 AX-700용 배터리 충전기"]) {
  const part = canonicalPart(name); catalog.set(part.id, part);
}
export const PACKING_PARTS = [...catalog.values()];
export function registeredPart(name: string) {
  const p=canonicalPart(name); return catalog.get(p.id);
}
export function templateFor(name: string) {
  // 운영 예약에서 사용하는 동일 모델의 영문 표기. 다른 모니터를 추정하지 않는다.
  const model = partKey(name) === partKey("스몰HD INDIE7") ? "스몰HD 인디7" : name;
  const key = Object.keys(PACKING_TEMPLATES).find(n => partKey(n) === partKey(model));
  return key ? PACKING_TEMPLATES[key] : [];
}
export const MONITOR_MODELS = ["스몰HD 인디7", "포트키 BM7", "티비로직 F-7HS", "티비로직 LVM-074W", "파이로 7"];
