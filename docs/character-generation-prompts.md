# 탐수학 캐릭터 스프라이트 재제작 프롬프트 (강아지 / 고양이 / 수달 / 토끼)

근거: `tamsu-app/app.html` (Google Drive) 의 `CHAR_TYPES`, `STAGE_DEFS`,
`SPRITE_GRID`, `SHOP`, `.heroWear` CSS.

---

## 1. 실제 구조 (앱 코드 기준)

- 캐릭터 4종: `otter`(수달) / `rabbit`(토끼) / `dog`(강아지) / `cat`(고양이)
  (그 외 tamsu1~3 시트도 있음)
- 종별 그림 **2장**: `xxx-levels.png`(레벨 1~60), `xxx-levels-2.png`(레벨 70~140)
- 한 장에 **8단계가 4×2 격자**(`SPRITE_GRID = {cols:4, rows:2}`).
  칸 번호는 왼쪽 위부터 `0 1 2 3 / 4 5 6 7`
- 총 16단계: 알·새싹·학생·박사·마스터·우주·천사·전설 / 기사·궁수·마법사·발명가·요정·닌자·대천사·은하
- 앱은 CSS `background-position` 으로 격자에서 한 칸만 잘라 보여준다
- 아이템은 그림 위에 **절대위치 레이어**로 얹힌다 (`.heroWear`):

| 슬롯 | CSS 위치 | 크기(칸 대비 %) |
|---|---|---|
| hat | `top: --anchorHead`, `left: --anchorFaceX` | 야구모자 26×22 / 파티모자 24×28 / 마법사모자 34×30 |
| glasses | `top: --anchorEye`, `left: --anchorFaceX` | 눈 폭(`eyeW`)×1.35 로 자동 스케일 |
| cloth | `top: --anchorNeck`, `left: --anchorFaceX` | 목도리 34×11 / **코트 48×47 (ty −20%)** |
| bag | `top: --anchorNeck`, `right: 12%` | 책가방 22×29 / 별가방 20×25 |
| shoes | `top: 90%`, `left: --anchorFaceX` | 운동화 30×20 / 장화 26×24 |
| bg | 캐릭터 **뒤** 배경 이미지 (숲/바다/우주/오로라…) | cover |
| aura | 캐릭터 뒤, `top:38%` 중앙, 100%×48% | contain |
| pet | 오른쪽 아래 모서리 | 30cqw |
| emo | 왼쪽 위 모서리 | 23cqw |

- 앵커는 **칸마다 따로** 잰 값(`cells`)을 쓰고, 없으면 시트 공통값(`anchor`)을 쓴다.

---

## 2. 지금 그림의 문제 (코드가 증명함)

1. **칸마다 캐릭터 위치가 제각각.**
   `faceX` 실측값이 강아지 시트0 에서 `48.1 / 52.4 / 46.1 / 58.4 / 46.2 / 43.0…`,
   토끼 시트0 은 `46.5 / 36.4 / 35.7 / 40.0`, `head` 는 `34.8 ~ 49.8`.
   → 그래서 칸마다 앵커를 손으로 재서 박아 넣는 유지보수가 생겼다.
   앱 주석에도 이렇게 적혀 있음:
   > "박사 강아지는 왼손에 책을 들어 얼굴이 오른쪽으로 밀려 있고(faceX 62.5),
   > 토끼는 윗줄과 아랫줄의 키 높이가 다르다. …
   > (예전에는 그림장당 하나뿐이라 박사 강아지의 모자가 귀 위에 얹혔다)"

2. **몸이 비스듬하고 팔이 소품을 들고 있음.**
   코트 아이템은 `faceX` 중심의 좌우대칭 48×47 사각형이다. 몸이 틀어져 있으면
   절대 맞지 않는다. 스크린샷의 트렌치코트가 어색한 직접적 원인.

3. **베이스가 이미 아이템 슬롯을 점유.**
   박사 단계 그림에 흰 가운 + 조끼 + 나비넥타이가 그려져 있는데,
   그 위에 `cloth_coat` 를 얹으니 옷이 두 겹이 된다.

4. **배경이 그림에 구워져 있음.**
   `bg` 슬롯(숲·바다·우주·오로라 배경)이 캐릭터 **뒤에** 깔리는 구조인데,
   스프라이트에 해변/무지개가 박혀 있어서 배경 아이템이 무의미해진다.
   → 스프라이트는 **반드시 알파 투명 PNG**.

---

## 3. 새 규격

### 3-1. 파일 규격
- 셀 1024×1024 → 시트 **4096×2048** (4×2), PNG, 알파 투명
- 종별 2장: `dog-levels.png`(단계 0~7), `dog-levels-2.png`(단계 8~15)
- 셀 경계에 캐릭터가 절대 걸치지 않게 (칸 안쪽 여백 유지)

### 3-2. 모든 칸이 지켜야 하는 목표 앵커 (칸 크기 대비 %)

| 항목 | 목표값 | 의미 |
|---|---|---|
| `faceX` | **50.0** | 얼굴 좌우 중심 = 칸 정중앙 |
| `head` | **22.0** | 모자 중심 (정수리 살짝 위) |
| `eye` | **38.0** | 두 눈 중심선 |
| `eyeW` | **24.0** | 두 눈 바깥쪽 폭 |
| `neck` | **55.0** | 목 중심 (목도리·코트 기준선) |
| 어깨 폭 | 34~38 | 코트(48폭)가 어깨를 덮되 남지 않게 |
| 발목 | 88 | `shoes` 가 `top:90%` 고정 |
| 발바닥 | 94 | |
| 상단 여백 | ≥4 | 토끼 귀 끝이 잘리지 않게 |

**16칸 전부 이 값이면 `cells` 실측 테이블을 통째로 지우고
`anchor` 한 줄만 남길 수 있다.** 이게 이번 재제작의 실질적 목표.

---

## 4. 공통 프롬프트 블록

### A. 스타일
```
Cute children's math-education app mascot, soft storybook illustration with
gentle 3D shading, clean thick outlines, bright friendly pastel palette,
chibi proportions about 3 heads tall, large round sparkling eyes,
warm happy expression, smooth fluffy fur, flat even frontal lighting,
no cast shadow, crisp edges suitable for compositing,
fully transparent background (PNG alpha), single 1024x1024 square canvas.
```

### B. 포즈 · 프레이밍 (제일 중요 — 절대 빼지 말 것)
```
STRICT FRAMING AND POSE:
perfectly symmetrical straight-on front view, character stands upright on both
hind legs facing the camera directly, head level and centered, eyes looking
straight at the viewer, shoulders horizontal and even, both arms lowered in a
relaxed A-pose about 30 degrees from the body, both hands open and EMPTY with
palms forward, both feet flat side by side on the same horizontal line, weight
even, tail tucked straight down behind the body.
The face is exactly centered on the vertical middle of the canvas.
The eye line sits at 38% of the canvas height from the top.
The top of the head is at about 26% height, the neck at 55%, the soles of the
feet at 94%, with a small clear margin above the head.
Full body visible, nothing cropped, nothing touching the canvas edges.
```

### C. 슬롯 비침범 규칙 (이번에 새로 넣는 핵심)
```
KEEP ITEM SLOTS CLEAR — the app layers accessories on top of this artwork:
no hat, cap, crown, helmet or headband (the top of the head must be bare),
no glasses, goggles, mask or eye covering (the eye line must be bare),
no scarf, necktie, bow tie, collar, cape clasp, coat, jacket, lab coat or robe
(the neck and chest must be bare fur),
no shoes, boots or socks (the feet must be bare paws),
no backpack, satchel or shoulder strap,
no held objects of any kind in either hand,
no background scenery, no ground, no floor, no shadow under the feet.
```

### D. 네거티브
```
three-quarter view, side view, turned body, twisted torso, tilted head,
asymmetrical pose, dynamic pose, walking, running, jumping, sitting, leaning,
one arm raised, arms crossed, holding a book, holding a wand, holding a sword,
holding any object, hat, cap, crown, helmet, glasses, goggles, mask,
scarf, bow tie, necktie, collar, coat, lab coat, vest, robe, shoes, boots,
backpack, background scenery, beach, sky, rainbow background, ground, floor,
drop shadow, perspective distortion, foreshortening, cropped ears,
cut off feet, multiple characters, text, numbers, watermark, logo, frame,
photorealistic, extra limbs, extra ears, deformed hands
```

---

## 5. 종별 블록

### 강아지 (dog)
```
SUBJECT: an adorable fluffy puppy mascot, cream and apricot wavy fur like a
shih-tzu poodle mix, soft floppy ears hanging down evenly on both sides at
exactly the same angle and length, round shiny dark eyes, small black button
nose centered, tiny pink tongue in a happy smile, lighter cream chest, belly
and paw tips, four rounded paws.
```

### 고양이 (cat)
```
SUBJECT: an adorable kitten mascot, soft light grey and white tabby fur,
two upright triangular ears standing at identical angles with pale pink inner
ears, large round bright eyes, small pink triangular nose centered, three short
whiskers per cheek mirrored exactly left and right, white chest, belly and paw
tips, four rounded paws with soft pink pads.
```

### 수달 (otter)
```
SUBJECT: an adorable baby otter mascot, warm chocolate brown sleek fur, cream
muzzle, cheeks and throat, two tiny round ears set symmetrically on the sides
of the head, big round dark glossy eyes, small dark rounded nose centered,
chubby cheeks and a gentle smile, short round arms with small five-fingered
paws, thick flat tail tucked straight down behind the body.
```

### 토끼 (rabbit)
```
SUBJECT: an adorable bunny mascot, soft white and cream fluffy fur, two long
ears standing perfectly straight upward, identical length and angle, mirrored
left and right, pale pink inner ears, big round sparkling eyes, tiny pink
Y-shaped nose centered, small buck teeth in a sweet smile, four small rounded
paws, small round cotton tail hidden behind the body.
IMPORTANT: the ears extend upward into the top margin, but the FACE still sits
at the same height as the other species — eye line at 38% of canvas height.
Shrink the body if needed so the ear tips are not cropped.
```

> 토끼의 기존 `head` 값이 48.7 까지 내려간 원인이 바로 "귀 때문에 얼굴이 아래로
> 밀린 것". 위 문장으로 **얼굴 높이를 4종 통일**해야 앵커가 하나로 합쳐진다.

---

## 6. 16단계 스테이지 블록

`STAGE_DEFS` 순서 그대로. **모든 단계가 §4-C 슬롯 비침범 규칙을 지켜야 하므로,
단계 개성은 "털 색·발광·등 뒤 대칭 요소·주변에 떠 있는 오브젝트"로만 표현한다.**
(모자·안경·옷·신발·가방으로 표현하면 아이템과 충돌한다)

### 시트 0 — `xxx-levels.png` (레벨 1~60)

| 칸 | 단계 | 프롬프트 조각 |
|---|---|---|
| 0 | 알 | `newborn baby version, smallest and roundest body, two halves of a cracked pastel eggshell resting symmetrically on the ground behind the feet, soft white sparkle` |
| 1 | 새싹 | `slightly bigger, fresh light-green glow around the body, two small sprout leaves floating symmetrically on the left and right of the body, spring pastel tone` |
| 2 | 학생 | `cheerful school-age version, two open books floating symmetrically behind the shoulders, soft yellow-green sparkles, bright eager eyes` |
| 3 | 박사 | `wise scholarly version, calm confident smile, faint gold aura, small floating math symbols (＋ − × ÷) arranged symmetrically around the body, NO lab coat, NO graduation cap` |
| 4 | 마스터 | `noble master version, radiant golden glow, two golden ribbon streamers flowing symmetrically behind the shoulders, subtle gold fur highlights, NO crown` |
| 5 | 우주 | `cosmic explorer version, silvery star-dusted fur, a thin glowing planet ring floating symmetrically behind the body, small stars around, NO space helmet` |
| 6 | 천사 | `angelic version, pure white feathered wings spread symmetrically behind the back, soft warm white glow, NO halo above the head` |
| 7 | 전설 | `legendary version, iridescent rainbow shimmer across the fur, a large circular starburst halo glowing BEHIND the whole body, floating golden sparks` |

### 시트 1 — `xxx-levels-2.png` (레벨 70~140)

| 칸 | 단계 | 프롬프트 조각 |
|---|---|---|
| 0 | 기사 | `brave knight version, small silver armor bracers on both forearms and greaves on both shins only, two swords crossed symmetrically BEHIND the body, blue and silver tone, NO helmet, NO breastplate` |
| 1 | 궁수 | `sharp-eyed archer version, forest-green fur highlights, a bow and a quiver floating symmetrically behind the body, small leaf motifs, NO hood, NO strap across the chest` |
| 2 | 마법사 | `wise mage version, deep violet glow, glowing magic runes floating in a symmetric circle around the body, sparkles at the fingertips, NO wizard hat, NO robe, NO staff in hand` |
| 3 | 발명가 | `clever inventor version, warm copper-orange glow, brass gears and springs floating symmetrically behind the body, tiny bolts sparkling, NO goggles, NO tool belt` |
| 4 | 요정 | `fairy version, translucent iridescent butterfly wings spread symmetrically behind the back, pink and mint sparkle dust, tiny glowing motes` |
| 5 | 닌자 | `swift ninja version, deep navy and charcoal fur, two shuriken floating symmetrically behind the body, faint speed-blur wisps, NO face mask, NO headband, NO scarf` |
| 6 | 대천사 | `archangel version, two pairs of huge white glowing wings spread symmetrically behind the back, radiant golden-white light, majestic calm expression, NO halo above the head` |
| 7 | 은하 | `galaxy version, deep purple and blue nebula pattern flowing through the fur, tiny stars twinkling in the coat, a large spiral galaxy glowing BEHIND the whole body` |

---

## 7. 조립 순서 (권장 워크플로)

1. **강아지 · 박사 칸(시트0 idx3) 1장을 먼저 확정** → 마스터 레퍼런스.
   (박사가 지금 가장 문제가 큰 칸이라 여기서 검증하는 게 빠르다)
2. 나머지 칸·나머지 종은 그 이미지를 레퍼런스로 넣고 아래를 덧붙인다:
   ```
   Match the attached reference image exactly in art style, line weight,
   shading, head size, body proportions, canvas framing, character height,
   eye line position and horizontal centering.
   Only change what the stage description below specifies.
   ```
3. **한 장에 4×2 를 통째로 생성하지 말 것.** 격자로 뽑으면 칸마다 크기·위치가
   또 어긋난다 (지금 문제의 재발). 16칸을 개별 1024×1024 로 뽑는다.
4. 각 칸을 1024×1024 안에서 앵커에 맞춰 **수동/스크립트 정렬** 후 격자로 합친다:
   ```bash
   # 셀 0~7 을 4×2 로 합치기
   magick montage cell0.png cell1.png cell2.png cell3.png \
                  cell4.png cell5.png cell6.png cell7.png \
     -tile 4x2 -geometry 1024x1024+0+0 -background none dog-levels.png
   ```
5. 정렬이 끝나면 `app.html` 의 `CHAR_TYPES` 에서 해당 시트의 `cells: {...}` 를
   지우고 `anchor` 만 아래로 통일:
   ```js
   anchor: { head: 22, eye: 38, neck: 55, faceX: 50, eyeW: 24 },
   ```

---

## 8. 검수 체크리스트 (칸마다)

- [ ] 좌우 반전해 겹쳤을 때 실루엣이 거의 일치 (대칭)
- [ ] 얼굴 중심이 칸 가로 정중앙(50%)
- [ ] 눈 중심선이 칸 높이 38% 근처, 16칸 편차 ±1.5% 이내
- [ ] 정수리 22%, 목 55%, 발바닥 94% 근처
- [ ] 머리 위·눈높이·목·발·오른쪽 어깨에 그려진 물건이 없음
- [ ] 양손이 비어 있음
- [ ] 배경 완전 투명, 바닥 그림자 없음
- [ ] 셀 경계에 캐릭터가 걸치지 않음
- [ ] `cloth_coat`(48×47, neck 기준 ty −20%) 를 얹었을 때 어깨가 자연스럽게 덮임
- [ ] `hat_wizard`(34×30, head 기준 ty −70%) 가 귀 위가 아니라 정수리에 얹힘
- [ ] `glasses_round` 가 눈동자 정중앙에 옴 (eyeW 실측이 24 근처)
