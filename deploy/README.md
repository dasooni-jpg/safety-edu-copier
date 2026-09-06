# 폴더째 올리는 배포 묶음

| 폴더 | 어디에 올리나 | 주소 | 난이도 |
|------|----------------|------|--------|
| **`pixel-upload/`** | Workers → pixel 워커 → **고정 파일 업로드** | **지금 주소 그대로** | **가장 쉬움 (권장)** |
| `pixel-worker/` | wrangler 배포 / GitHub 연동 | **지금 주소 그대로** | 보통 |
| `pixel-pages/` | Cloudflare **Pages** (Upload assets) | 새 주소 `○○○.pages.dev` | 쉬움 |

> **대시보드의 [고정 파일을 업로드하여 Worker 업데이트] 화면에는 `pixel-upload/` 폴더만 올릴 것.**
> 그 업로더는 HTML·CSS·JS 같은 고정 자산만 받으므로, `wrangler.toml` 이나 워커 스크립트(`.js`)를
> 함께 올리면 "빌드 프로세스가 필요한 프로젝트는 지원하지 않습니다" 경고가 뜸.

각 폴더 안의 **`읽어보세요.txt`** 에 클릭 순서가 적혀 있음.
`deploy/pixel-worker.zip`, `deploy/pixel-pages.zip` 은 드래그해서 그대로 올릴 수 있는 압축본임
(저장소에는 넣지 않고, 빌드 스크립트가 다시 만들어 줌).

## 어느 쪽을 고를까

- **대시보드에서 클릭만으로 끝내고 싶다** → `pixel-upload/` (파일 2개: `index.html`, `404.html`)
- **명령줄(wrangler)이나 GitHub 자동배포를 쓰고 싶다** → `pixel-worker/`
  - 방법 A(GitHub 연동)로 한 번만 설정해 두면, 앞으로는 저장소에 푸시만 해도 자동 배포됨.
    이때 Cloudflare 설정에서 **Root directory 를 `deploy/pixel-worker` 로 지정**하는 것이 핵심임.
- **가장 쉽게, 주소가 바뀌어도 괜찮다** → `pixel-pages/`
  - 폴더(또는 zip)를 드래그해서 올리면 끝. 학생 안내용 주소를 새로 알려 주면 됨.

## 폴더 안에 무엇이 들어 있나

**pixel-upload/** (대시보드 고정 파일 업로드 전용 — 이 두 개 말고는 넣지 말 것)
- `index.html` — 게임 본체
- `404.html` — 없는 주소로 들어와도 게임이 열리게 하는 파일
- 안내문은 폴더 밖 `pixel-upload-읽어보세요.txt` 에 둠 (폴더에 넣으면 그 파일까지 배포되기 때문)

**pixel-worker/**
- `wrangler.toml` — 워커 이름(`pixel`)과 진입 파일을 알려 주는 설정
- `pixel-flow-worker.js` — 게임 전체가 들어 있는 워커 파일 하나

**pixel-pages/**
- `index.html` — 게임 본체
- `404.html` — 없는 주소로 들어와도 게임이 열리게 하는 파일
- `_headers` — 캐시·보안 헤더
- `_redirects` — 모든 주소를 게임으로 보내는 규칙

## 화면을 고친 뒤

```powershell
powershell -ExecutionPolicy Bypass -File build-pixel-flow-worker.ps1
```

이 스크립트가 `pixel-flow/index.html` 을 기준으로
워커 파일 → 두 배포 폴더 → zip 까지 한 번에 다시 만들어 줌.
