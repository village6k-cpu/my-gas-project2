# VILLAGE. FM — 빌리지 로파이 라이브

`docs/villagefm.html` · 여명 톤 픽셀 로파이 무한루프 화면.
매장 일상(먼지 털기 · 시네카트 밀기 · 렌즈 닦기 · 장부 정리 · 커피 · 꾸벅 졸기)이 흐르다가,
가끔 먼 곳을 바라보며 쉬는(바다 노을 · 새벽 별) 씬으로 넘어가며 무한 반복된다.

- 화면: `https://village6k-cpu.github.io/my-gas-project2/villagefm.html`
- 외부 리소스 0개 · 자체완결 · GitHub Pages 그대로 서빙
- 매장 화면에 틀거나, 화면녹화해서 인스타/유튜브에 올리기 좋음

## 음악 넣는 법 (딱 3단계)

1. **Suno**(https://suno.com)에서 아래 프롬프트로 곡 생성 (Instrumental 켜기, 4~6분 권장)
2. 받은 mp3를 이 폴더에 **`villagefm.mp3`** 이름으로 저장
3. 끝. 화면에서 **▶** 누르면 무한반복 재생. (파일이 없어도 화면은 그대로 돌아감 — 소리만 없음)

> 브라우저 정책상 소리는 사용자가 ▶(또는 스페이스/엔터)를 눌러야 시작된다. 볼륨/음소거는 하단 컨트롤.

## Suno 프롬프트 (아득한 · Ben Seretan 결)

**Style (기본 — 여명):**
```
dreamy ambient lo-fi, wistful and faraway, slow and spacious, warm analog tape,
soft fingerpicked electric guitar drenched in reverb, gentle drones, distant piano,
tape hiss and soft vinyl crackle, no drums (or very soft brushed percussion),
melancholic yet peaceful, early-morning haze, cinematic, hypnotic, seamless loop
```

**변주 A (노을·바다):** 위에 `sunset over the sea, gentle tremolo, warmer, a little nostalgic` 추가
**변주 B (새벽·별):** 위에 `pre-dawn stillness, sparse, colder reverb, almost silent, meditative` 추가

- Title/Lyrics 칸은 비우고 **Instrumental** 체크
- 여러 곡 뽑아서 마음에 드는 걸 `villagefm.mp3`로 저장. 길이가 짧으면 `<audio loop>`가 알아서 무한반복.

## 저작권 메모 (중요)

- **Ben Seretan 등 기존 아티스트 음원을 그대로 쓰는 건 안 됨** (수익화 여부와 무관하게 저작권 침해, 매장 홍보물은 상업적 이용).
- Suno 생성곡은 **본인 플랜의 상업 이용 약관**을 확인할 것 (유료 플랜은 보통 상업 사용 허용).
- 그 감성을 합법적으로 얻는 다른 길: 로열티프리 구독(Epidemic/Artlist), CC-BY 음원(크레딧 표기), 또는 아티스트에게 직접 sync 라이선스 문의.

## 구성 메모 (수정 시 참고)

- 씬은 `scenes[]` 배열에 `{dur, cap, trk, bake, anim}` 로 정의. 순서·시간·문구 여기서 조절.
- 캐릭터: 단색 블록 스프라이트 `FRONT/SIDE/BACK` (`spr()` 로 blit). 색은 `CH`.
- 톤: `sky()`(dawn/dusk/night) · `interior()` · 팔레트는 muted 여명 계열.
- 시네카트: `cineCart()` (2단 선반·튜브 기둥·핸들·바퀴).
- 씬 전환: 느린 크로스페이드(`FADE`). 그레인·비네트는 `overlay()`.
- 접근성: `prefers-reduced-motion` 시 정지 프레임.
