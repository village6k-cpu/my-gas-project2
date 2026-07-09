# VILLAGE. FM — Higgsfield 영상 프롬프트

빌리지 FM 로파이 영상을 Higgsfield로 뽑기 위한 프롬프트. 각 씬을 **image-to-video**(아래 스틸을 넣고 움직임만 지시)로 뽑는 걸 추천 — 룩 유지가 쉬움. text-to-video로 처음부터 뽑아도 됨.

핵심 원칙: **정적 카메라 · 아주 느리고 최소한의 움직임 · 심리스 루프 · 새벽(dawn) 무드 · 2D 픽셀아트.**

---

## 0) 공통 스타일 (모든 프롬프트 앞에 붙이기)

```
2D pixel art, lo-fi aesthetic like Lofi Girl / claude.fm, muted dawn color palette
(soft lavender, dusty rose, pale gold), warm early-morning light, cozy and wistful
faraway mood, subtle film grain, letterboxed 16:9, a tiny simple blocky clay-orange
character (Roblox-simple, no facial detail, seen from behind). Static locked-off
camera, no camera movement, no zoom. Very slow, minimal, calm ambient motion only.
Seamless loop.
```

**Negative / avoid:** `fast motion, camera movement, zoom, pan, 3D render, realistic human, extra characters, bright saturated colors, busy action, morphing, flicker, text artifacts`

**설정:** aspect 16:9 · motion strength 낮게(약 15~30%) · duration 5~8초 · 가능하면 loop/seamless 옵션.

---

## 1) 먼지 털기 (매장 · 철제 랙)
```
Inside a rental shop at dawn, the small character gently dusting a tall black metal
storage rack loaded with a few camera cases and lenses. A feather duster sweeps very
slowly along one shelf; a few dust motes drift in the soft morning light. Calm, quiet.
```

## 2) 시네카트 밀기
```
The small character slowly pushing a two-tier film equipment cart (loaded with camera
cases, a lens box and a folded tripod) across a wide, empty dawn landscape. The cart
wheels turn slowly; a low sun glows on the flat horizon. Unhurried, drifting left to right.
```

## 3) 쉼 · 바다 노을 (아득)
```
A tiny figure sitting still on the ground, seen from behind, gazing at a vast dawn sea.
The low sun rests on the horizon and shimmers faintly on the water. Almost motionless,
only the gentle glimmer of light on the sea and a slow breath. Wistful, faraway.
```

## 4) 렌즈 닦기 (데스크)
```
At a simple workbench in soft dawn light, the character slowly examining and wiping a
camera lens held up to the light. Tiny, calm hand movement; a soft puff of breath on
the glass. Quiet focus.
```

## 5) 커피 한잔
```
The character standing quietly in a dawn-lit room, holding a small steaming mug. Steam
rises slowly and curls. One slow, gentle sip, then stillness. Warm and calm.
```

## 6) 쉼 · 새벽 별 (아득)
```
A tiny figure sitting under a pre-dawn sky, seen from behind, a low dark horizon, a few
stars faintly twinkling as the deep blue-violet sky slowly warms toward the first light.
Meditative, still, quiet.
```

## 7) 장부 정리 (데스크)
```
At a desk in soft dawn light, the character slowly writing in an open ledger with a
pencil, small calm hand motion, head slightly bowed. Unhurried bookkeeping. Cozy, quiet.
```

## 8) 꾸벅 졸기 (데스크)
```
The character dozing at a desk, head slowly nodding forward then gently bobbing back up,
a soft "Z Z Z" drifting upward. A camera rests on the desk. Sleepy, warm, minimal.
```

---

## 루프 만드는 팁
- 각 씬 5~8초씩 뽑아 **crossfade(1~2초)** 로 이어붙이면 5분 로파이 루프 완성.
- 순서 예: 먼지 → 카트 → **쉼(바다)** → 렌즈 → 커피 → **쉼(별)** → 장부 → 졸기 → (반복).
- 우상단 `♫ 곡명 — VILLAGE FM`, 좌상단 `VILLAGE. FM ● LIVE`, 위아래 레터박스를 **편집 단계에서 오버레이**로 얹으면 claude.fm 결이 완성됨.
- 음악은 Suno 곡(`villagefm.md` 프롬프트)을 깔면 됨.

## 참고 스틸 (image-to-video 입력용)
- 원하면 각 씬의 **깔끔한 레퍼런스 스틸**(HUD/레터박스 없이, 고해상)을 뽑아줄 수 있음 — 그걸 Higgsfield에 넣고 위 움직임 프롬프트만 주면 룩이 유지됨.
