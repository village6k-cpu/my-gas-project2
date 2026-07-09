# VILLAGE. FM — Higgsfield 영상 프롬프트 (claude.fm 모션 따라잡기)

목표: **claude.fm(로파이걸) 정도의 "살아있지만 잔잔한" 움직임**을 2D 픽셀아트로 그대로 재현.
레퍼런스 영상: https://www.youtube.com/live/tRsQsTMvPNg

## 이 문서의 핵심 (꼭 지킬 것)
1. **모션 레벨 = claude.fm/로파이걸.** 카메라는 완전 고정. 캐릭터는 "숨 쉬고, 딱 하나의 작은 동작을 천천히 반복"하는 정도. 먼지·김·별·빛만 은은하게 계속 흐름. 빠르거나 과장된 동작 절대 금지. **정지도 아니고 역동도 아닌, 그 중간의 잔잔한 생동감.**
2. **2D 픽셀아트.** 3D 렌더 아님.
3. **시네카트와 철제 랙은 반드시 화면에 나와야 함** (아래 상세 묘사 그대로).
4. **심리스 루프.** 끝과 처음이 이어지게.

권장: 각 씬을 **image-to-video**로 뽑기 — 내가 뽑아줄 레퍼런스 스틸(캐릭터·카트·랙·새벽톤 그대로)을 넣고 아래 "움직임 프롬프트"만 주면 룩이 안 깨짐. text-to-video로 처음부터 뽑아도 됨.

---

## 0) 공통 스타일 블록 (모든 씬 프롬프트 맨 앞에 붙이기)

```
2D pixel art, lo-fi aesthetic exactly like Lofi Girl / claude.fm. Muted early-dawn
color palette: soft lavender and periwinkle at the top warming down to dusty rose and
pale gold, warm morning light, cozy and wistful faraway mood, subtle film grain,
letterboxed 16:9. The character is a tiny simple blocky chibi figure: big square head,
small body, short stubby limbs, a single flat clay-orange color (like a minimal Roblox
block character), no detailed face. Static locked-off camera — no camera movement, no
zoom, no pan, no parallax. Motion level is that of a living lo-fi illustration: a slow
breath, ONE small repeated gesture, and gently drifting ambient particles/light — alive
but very calm, never fast, never dramatic. Seamless loop.
```

**네거티브 / avoid:**
```
fast motion, sudden movement, camera movement, zoom, pan, parallax, 3D render, realistic
human, detailed face, extra characters, bright saturated colors, busy/dramatic action,
morphing, warping limbs, elongated limbs, flicker, jitter, text artifacts, watermark
```

**설정:** aspect 16:9 · **motion strength 낮게(15~25%)** · duration 5~8초 · loop/seamless 옵션 ON.

---

## 씬별 움직임 프롬프트 (8컷)

> 각 프롬프트의 동작은 "딱 이 하나만, 아주 천천히, 계속 반복". claude.fm처럼 배경 입자/빛은 은은하게 항상 흐른다.

### 1) 먼지 털기 — 철제 랙 (★랙 필수)
```
Inside a small camera-rental shop at dawn. On the right stands a TALL BLACK METAL
STORAGE RACK — a boltless 4-tier warehouse shelving rack — loaded with a few camera
hard-cases, lens cases and boxes on each shelf. The chibi character stands in front of
it and slowly, gently sweeps a small feather duster back and forth along one shelf —
just a soft, unhurried wrist motion. A few tiny dust motes drift up and float in the
warm side light. Everything else is still. The character breathes softly. Seamless loop.
```

### 2) 시네카트 밀기 (★시네카트 필수)
```
The chibi character slowly pushes a FILM-EQUIPMENT CINE CART across the frame from left
to right. The cart is a two-tier production hand-cart: tubular metal side posts, two flat
shelves, four small casters, and a curved push-handle on the left — loaded with camera
hard-cases, a lens box, a light stand and a folded tripod. The character walks in place
with a tiny gentle bounce while the cart drifts slowly across; the wheels turn slowly. A
low dawn sun glows on the flat horizon behind. Unhurried, calm, continuous. Seamless loop.
```

### 3) 쉼 · 바다 노을 (아득)
```
The chibi character sits still on the ground, seen from behind, gazing at a vast dawn
sea. A low sun rests on the horizon and shimmers faintly on the water — the shimmer is
the only real motion, a slow glimmer creeping over the ripples. The character is almost
motionless, just a slow breath. Wistful, faraway, meditative. Seamless loop.
```

### 4) 렌즈 닦기 — 데스크
```
At a simple workbench in soft dawn light, the chibi character holds a camera lens up and
slowly wipes it — a small, calm side-to-side hand motion — then a soft puff of breath
fogs the glass and a tiny cloud drifts off. Just that one gentle repeated motion. Quiet
focus, warm light. Seamless loop.
```

### 5) 커피 한잔 — 컵 위아래 (★사용자가 콕 집은 동작)
```
The chibi character stands quietly in a dawn-lit room holding a small mug. It slowly
raises the mug up to take one gentle sip, holds a beat, then slowly lowers it back down —
up and down, up and down, very slowly and continuously. Thin steam rises and curls the
whole time. Warm, calm, sleepy. Seamless loop.
```

### 6) 쉼 · 새벽 별 (아득)
```
The chibi character sits under a pre-dawn sky, seen from behind, on a low dark horizon.
A few stars twinkle faintly and slowly as the deep blue-violet sky warms almost
imperceptibly toward the first light. The character is still, only a slow breath. Quiet,
meditative, faraway. Seamless loop.
```

### 7) 장부 정리 — 데스크
```
At a desk in soft dawn light, the chibi character slowly writes in an open ledger with a
pencil — a small, calm scribbling hand motion, head slightly bowed. Just that gentle
repeated motion, nothing else moves except soft drifting light. Cozy, quiet bookkeeping.
Seamless loop.
```

### 8) 꾸벅 졸기 — 데스크
```
The chibi character dozes at a desk. Its head slowly nods forward, then gently bobs back
up, over and over, very slowly. A soft "Z Z Z" drifts upward and fades. A camera rests on
the desk. Sleepy, warm, minimal — the calmest scene. Seamless loop.
```

---

## 시네카트 · 철제 랙 상세 (프롬프트에 그대로 반영되게)

- **시네카트(2번 씬):** 촬영현장 프로덕션 핸드카트 형태 = **2단 선반 + 얇은 튜브형 금속 기둥 + 작은 캐스터 바퀴 4개 + 왼쪽 위로 굽은 손잡이.** 위·아래 선반에 **카메라 하드케이스 · 렌즈 박스 · 라이트 스탠드 · 접힌 삼각대**가 실려 있음. 옆모습, 오른쪽으로 진행.
- **철제 랙(1번 씬):** **키 큰 검정 4단 무볼트(boltless) 창고형 선반.** 각 단에 **카메라 하드케이스·렌즈 케이스·박스**가 최소한으로 올라가 있음. 캐릭터가 그 앞에서 한 선반을 먼지떨이로 스윽스윽 텀.

(이 두 소품이 안 나오면 다시 뽑을 것. i2v로 스틸을 넣으면 확실히 유지됨.)

---

## 루프·오버레이·음악
- 각 씬 5~8초 → **crossfade 1~2초**로 이어붙이면 5분 로파이 루프 완성.
- 순서: 먼지(랙) → 시네카트 → **쉼·바다** → 렌즈 → 커피 → **쉼·별** → 장부 → 졸기 → (반복).
- 편집 단계 오버레이: 좌상단 `VILLAGE. FM ● LIVE`, 우상단 `♫ 곡명`, 실시간 시계, 위아래 레터박스 → claude.fm 결 완성.
- 음악: Suno 곡(`villagefm.md` 프롬프트, Instrumental) 깔기.

## image-to-video 입력 스틸
- 원하면 각 씬의 **깔끔한 레퍼런스 스틸**(HUD·레터박스 없이, 캐릭터·시네카트·철제 랙·새벽톤 그대로, 고해상)을 바로 뽑아드림 → Higgsfield에 넣고 위 "움직임 프롬프트"만 주면 룩·소품이 그대로 유지됨. **이게 가장 확실한 방법.**
