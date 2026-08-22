# 캐릭터 베이스 재제작 프롬프트 (강아지 / 고양이 / 수달 / 토끼)

아이템(모자·옷·안경·소품)을 레이어로 덮어씌우는 구조에서, 기존 베이스가
비스듬한 3/4 뷰 + 이미 옷을 입은 상태 + 양손에 소품을 든 포즈여서 아이템이 어긋난다.
아래 규칙으로 베이스를 다시 만든다.

---

## 0. 베이스가 반드시 지켜야 할 규칙

| 항목 | 규칙 |
|---|---|
| 시점 | 정면(front view) 고정. 3/4·측면·부감·앙각 금지 |
| 대칭 | 완전 좌우대칭. 머리 기울기 0도, 어깨선 수평, 무게중심 중앙 |
| 포즈 | 두 발로 똑바로 서기. 팔은 A포즈(몸통에서 30도), 손바닥 정면, **빈손** |
| 의상 | **아무것도 안 입은 맨몸(맨털)**. 모자·안경·넥타이·가운 전부 제거 |
| 소품 | 책·지팡이·가방 전부 제거 (아이템 레이어로 분리) |
| 꼬리 | 몸 뒤로 숨기거나 다리 사이 중앙으로 곧게. 옆으로 뻗지 않기 |
| 귀 | 좌우 같은 각도·같은 길이 (토끼 귀는 양쪽 다 곧게 위로) |
| 수염 | 좌우 개수·각도 동일 |
| 배경 | 완전 투명(alpha). 배경·그림자·바닥 반사 굽지 않기 |
| 조명 | 정면에서 균일한 소프트 라이트. 방향성 있는 강한 그림자 금지 |
| 프레이밍 | 전신, 잘림 없음. 캔버스 1:1 정사각 1024×1024 |
| 스케일 | 4마리 모두 발바닥 = 캔버스 하단 5% 지점, 정수리 = 상단 8% 지점 |

### 앵커(아이템 정렬 기준선) — 4마리 공통
1024×1024 기준 대략값. 4종 모두 이 선에 맞추면 같은 아이템이 그대로 재사용된다.

- 세로 중심축: x = 512 (모든 캐릭터 정중선)
- 정수리: y ≈ 80
- 눈높이: y ≈ 300
- 턱 끝: y ≈ 430
- 어깨선: y ≈ 470  ← 상의/코트 아이템 상단 기준
- 허리: y ≈ 640
- 발바닥: y ≈ 975

---

## 1. 공통 스타일 블록 (모든 프롬프트 앞에 붙임)

```
Cute children's educational app mascot, soft 3D-ish storybook illustration,
clean cel shading with gentle gradients, thick soft outlines, pastel-friendly
palette, chibi proportions (about 3 heads tall), big round friendly eyes,
warm cheerful expression, smooth fluffy fur rendering, high detail on face,
flat even frontal lighting, no cast shadow, crisp edges suitable for
compositing, transparent background (PNG with alpha), 1024x1024 square canvas.
```

## 2. 공통 포즈 블록 (모든 프롬프트 앞에 붙임)

```
STRICT POSE: perfectly symmetrical straight-on front view, character stands
upright on both hind legs facing the camera directly, head level and centered,
eyes looking straight at the viewer, shoulders horizontal and even, both arms
lowered in a relaxed A-pose about 30 degrees away from the body, both hands
open and empty with palms facing forward, both feet flat on the same
horizontal line, weight evenly distributed, tail tucked straight down behind
the body and not visible from the side, body perfectly centered on the
vertical axis of the canvas, full body visible with no cropping,
head top near the top edge and feet near the bottom edge.
NO CLOTHING: completely bare fur, naked mascot base, no hat, no glasses,
no coat, no vest, no bow tie, no collar, no accessories, no held objects.
```

## 3. 공통 네거티브 프롬프트

```
three-quarter view, side view, turned body, twisted torso, tilted head,
asymmetrical pose, dynamic pose, walking, jumping, sitting, leaning,
one arm raised, crossed arms, hands behind back, holding book, holding wand,
holding any object, clothing, lab coat, trench coat, vest, bow tie, necktie,
scarf, hat, wizard hat, sunglasses, glasses, backpack, jewelry,
background scenery, beach, sky, rainbow, floor, ground shadow, drop shadow,
perspective distortion, foreshortening, cropped limbs, cut off head or feet,
multiple characters, text, watermark, signature, logo, frame, border,
photorealistic, creepy, uncanny, extra limbs, extra ears, deformed hands
```

---

## 4. 캐릭터별 프롬프트

각각 `[공통 스타일] + [공통 포즈] + [아래 개체 설명]` 순으로 이어 붙여 사용.

### 4-1. 강아지 (수탐이)

```
SUBJECT: an adorable fluffy puppy mascot, cream and apricot colored wavy fur
like a shih-tzu poodle mix, soft floppy ears hanging down evenly on both sides
at exactly the same angle and length, round shiny dark eyes, small black
button nose centered, tiny pink tongue slightly showing in a happy smile,
lighter cream fur on chest, belly and paw tips, four rounded paws,
fluffy tail tucked straight down behind the body.
```

### 4-2. 고양이

```
SUBJECT: an adorable kitten mascot, soft light grey and white tabby fur,
two upright triangular ears standing symmetrically at identical angles with
pale pink inner ears, large round bright eyes, small pink triangular nose
centered, three short whiskers on each cheek mirrored exactly left and right,
white fur on chest, belly and paw tips, four rounded paws with soft pink pads,
striped tail tucked straight down behind the body.
```

### 4-3. 수달

```
SUBJECT: an adorable baby otter mascot, warm chocolate brown sleek fur,
cream colored muzzle, cheeks and throat, two tiny round ears set symmetrically
on the sides of the head, big round dark glossy eyes, small dark rounded nose
centered, chubby cheeks and a gentle smile, short round arms with small
five-fingered paws, thick flat tail tucked straight down behind the body
and hidden from the front.
```

### 4-4. 토끼

```
SUBJECT: an adorable bunny mascot, soft white and cream fluffy fur,
two long ears standing perfectly straight upward, identical length and angle,
mirrored left and right, with pale pink inner ears, big round sparkling eyes,
tiny pink Y-shaped nose centered, small buck teeth in a sweet smile,
fluffy white chest and cheeks, four small rounded paws,
small round cotton tail hidden behind the body.
```

---

## 5. 4종 일관성 유지 요령

1. **강아지 1장을 먼저 완성**해서 "마스터 베이스"로 확정한다.
2. 나머지 3종은 그 이미지를 레퍼런스로 넣고 프롬프트에 다음을 추가:
   ```
   Match the reference image exactly in art style, line weight, shading,
   body proportions, camera framing, character height and pose.
   Only change the species and its markings.
   ```
3. 또는 한 번에 4마리를 한 이미지에 나란히(character line-up sheet) 뽑아
   스타일·키·포즈를 통일한 뒤 개별로 잘라낸다. 라인업용 추가 문구:
   ```
   Character line-up sheet, four mascots standing side by side in a single row,
   identical front-facing symmetrical pose, identical height and art style,
   even spacing, plain transparent background.
   ```
4. 최종적으로 4장 모두 같은 1024×1024 캔버스에 **위 앵커 표에 맞춰 수동 정렬**
   (여기서 픽셀 단위로 맞춰야 아이템이 완전히 들어맞는다. AI는 픽셀 좌표를 못 지킨다.)

---

## 6. 아이템 레이어 만드는 법

아이템을 따로 그리지 말고, **완성된 베이스 위에 입힌 상태로 생성한 뒤 베이스를 지운다.**
이렇게 하면 소매 위치·어깨 폭이 자동으로 맞는다.

아이템 생성 프롬프트 템플릿:
```
Using the attached mascot base image, dress the character in <ITEM>.
Keep the character's pose, proportions, position, scale and art style
100% identical to the reference. Do not move, rotate or redraw the body.
Same front view, same symmetry, same lighting, transparent background.
```
생성 후 캐릭터 몸통을 지우고 아이템만 남겨 PNG로 저장 → 같은 앵커 좌표에 얹으면 끝.

- 모자류: 정수리 y≈80 기준, 좌우 중심 x=512
- 상의/코트: 어깨선 y≈470 기준, A포즈 소매 각도 30도에 맞춰 제작
- 안경: 눈높이 y≈300 기준
- 소품(책·지팡이): 손 위치 기준, 좌/우 슬롯을 따로 둘 것

> 종별로 어깨 폭·머리 크기가 다르면 상의 아이템은 종별 변형이 필요하다.
> 4종의 **머리 크기와 어깨 폭을 최대한 동일하게** 뽑는 것이 아이템 재사용의 핵심.

---

## 7. 납품 전 체크리스트

- [ ] 좌우 반전해서 겹쳐봤을 때 실루엣이 거의 일치하는가 (대칭 검증)
- [ ] 머리 기울기 0도, 어깨선 수평인가
- [ ] 손이 완전히 비어 있는가
- [ ] 옷·모자·안경·넥타이가 하나도 없는가
- [ ] 배경이 완전 투명이고 바닥 그림자가 없는가
- [ ] 4종의 정수리·눈높이·어깨선·발바닥 y좌표가 서로 일치하는가
- [ ] 같은 코트 아이템을 4종 모두에 얹었을 때 어색함이 없는가
