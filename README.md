# 안전교육 문구 복사기 (보관용)

> ## ⚠️ 이 저장소는 더 이상 배포에 쓰이지 않습니다
>
> 이 프로젝트는 **[dasooni-jpg/geulssugi-mirror](https://github.com/dasooni-jpg/geulssugi-mirror)** 저장소의
> **`safety-edu/` 폴더**로 통합되었습니다. Cloudflare Worker(`safety-edu-copier`)는 **그쪽에서만** 자동 배포됩니다.
>
> **여기에 코드를 올려도 실제 화면은 바뀌지 않습니다.**
>
> | | 위치 |
> |---|---|
> | 고쳐야 할 곳 | `geulssugi-mirror` 저장소의 `safety-edu/` 폴더 |
> | 배포 설정 문서 | 같은 폴더의 `README.md` (Root directory·Deploy command 표) |
> | 이 저장소 | 통합 이전 기록 보관용 |
>
> 이 저장소에만 들어 있고 아직 `geulssugi-mirror`로 옮기지 않은 코드가 있는지 먼저 확인하세요.

## 바로 가기 주소 (실제 서비스 주소)

| 도구 | 주소 |
|---|---|
| 안전교육 문구 복사기 | https://safety-edu-copier.dasooni.workers.dev/ |
| 라운드 좋아요 — 교사용 | https://safety-edu-copier.dasooni.workers.dev/vote/teacher |
| 라운드 좋아요 — 학생용 | https://safety-edu-copier.dasooni.workers.dev/vote |


주간학습안내를 만들 때 안전교육 문구를 매번 손으로 바꾸는 번거로움을 없애기 위한 도구입니다.
주차(1~42주)를 고르면 [구글시트](https://docs.google.com/spreadsheets/d/1sC7x0KuTgRVybVoCzeHoJr0lcEGc1RCwCQYoX8TcJgA)의 최신 안전교육 문구 6개 항목을 표로 보여주고, 복사 버튼으로 바로 복사해서 한글 표에 붙여넣을 수 있습니다.

## 라운드 좋아요 (수업용 투표)

같은 워커 안에 들어 있는 두 번째 도구입니다. 한 라운드에 학생 한 명이 좋아요를 한 번만 누를 수 있고,
**선생님이 "결과 보기"를 눌렀을 때만** 그 라운드의 좋아요 개수가 화면에 나옵니다(실시간 표시 아님).

- 교사용 주소: `https://safety-edu-copier.dasooni.workers.dev/vote/teacher`
- 학생용 주소: `https://safety-edu-copier.dasooni.workers.dev/vote` (또는 `?code=1234`를 붙이면 코드 입력 없이 바로 참여)

### 쓰는 순서

1. 선생님이 교사용 주소를 열고 **라운드 개수(1~20)** 를 정한 뒤 [수업 시작하기]를 누름
2. 화면에 뜬 **숫자 4자리 참여 코드**를 칠판·TV에 보여 줌
3. 학생은 QR을 카메라로 찍거나, 학생용 주소로 들어가 코드를 넣고 큰 하트 버튼을 한 번 누름
   - 교사 화면의 QR을 누르면 **전체화면 QR**로 커짐 (TV·빔 프로젝터로 띄우기 좋음). 화면을 다시 누르거나 ESC로 닫음
4. 선생님이 [이번 라운드 결과 보기]를 누르면 그 순간의 좋아요 개수가 크게 표시됨
5. [다음 라운드로] → 학생 화면의 하트가 자동으로 다시 켜짐 (3초 안에 갱신)
6. [수업 끝내기] → 라운드별 결과와 합계가 표로 정리됨

### 알아 둘 점

- **개인정보를 저장하지 않음.** 이름·번호·사진을 받지 않고, 중복 클릭을 막기 위한 임의의 기기 번호만 씁니다.
- 공개한 개수는 **누른 그 시점으로 고정**됩니다. 그 뒤에 학생이 더 눌러도 숫자가 저절로 오르지 않고,
  [지금 개수로 다시 세기]를 눌러야 갱신됩니다.
- 학생 화면에는 개수가 절대 내려가지 않습니다(서버 응답에도 포함하지 않음).
- 방(참여 코드)은 **12시간 뒤 자동으로 사라집니다.** 매 차시 새로 만들어 쓰면 됩니다.
- 교사용 버튼(결과 보기·다음 라운드·끝내기)은 수업을 만든 그 기기에서만 눌립니다. 선생님 브라우저에
  저장된 열쇠값을 쓰기 때문에, 브라우저 데이터를 지우면 진행 중인 수업을 조작할 수 없습니다.
- 기기 번호가 브라우저에 저장되므로, 학생이 시크릿 모드로 다시 들어오면 한 번 더 누를 수 있습니다.
  (학급에서 쓰는 수준에서는 문제되지 않는 정도)
- QR은 외부 라이브러리 없이 앱 안에서 직접 만듭니다. 학교망에서 CDN이 막혀 있어도 그려집니다.
- 학생 화면은 3초마다 서버에 상태를 물어봅니다. 30명이 40분 수업을 하면 대략 2만~3만 요청으로,
  Cloudflare 무료 플랜 한도(하루 10만 요청) 안에서 하루 서너 차시 정도 쓸 수 있습니다.

## 구조

- `safety-edu-app/app.html` — 안전교육 문구 복사기 화면
- `vote-app/app.html` — 라운드 좋아요 화면 (교사용·학생용이 한 파일에 들어 있음). 의존성 없는 QR 생성기(`qrMatrix`)도 이 파일 안에 있음
- `safety-edu-worker.template.js` — Cloudflare Worker 소스 템플릿 (`__APP_HTML__`, `__VOTE_HTML__` 자리에 위 두 화면이 끼워짐). 좋아요를 어긋남 없이 세기 위한 Durable Object(`VoteRoom`)도 여기 들어 있음
- `safety-edu-worker.js` — 빌드된 실제 배포 파일 (Cloudflare Worker에 이 파일이 그대로 올라감)
- `build-safety-edu-worker.ps1` — 화면을 고친 뒤 위 파일들을 합쳐 `safety-edu-worker.js`를 다시 만드는 스크립트 (Windows PowerShell)
- `build-safety-edu-worker.mjs` — 같은 일을 하는 Node 버전 (`node build-safety-edu-worker.mjs`)
- `wrangler.toml` — Cloudflare Workers 배포 설정 (Durable Object 바인딩 포함)

## 배포 (Cloudflare Workers, GitHub 연동)

> **이 절은 통합 이전 기준입니다.** 지금 배포는 `geulssugi-mirror` 저장소의 `safety-edu/` 폴더에서 이루어집니다.
> 실제 설정값(Root directory, Deploy command, Build watch paths)은 그쪽 README의 표를 보세요.

(예전 방식) Cloudflare 대시보드 → Workers & Pages → Create → "Import a repository" 에서 이 저장소를 연결하면,
`main` 브랜치에 푸시할 때마다 `wrangler.toml` 설정대로 자동 배포됩니다. 별도 빌드 명령 없이 `safety-edu-worker.js`를 그대로 올립니다.

## 화면(app.html)을 고칠 때

> **먼저 확인:** 고칠 파일이 `geulssugi-mirror`의 `safety-edu/` 폴더에도 있는지 보고, 있으면 **그쪽을 고치세요.**
> 아래 순서는 그 폴더에서도 그대로 통합니다.

1. `safety-edu-app/app.html`(안전교육) 또는 `vote-app/app.html`(라운드 좋아요) 수정
2. `powershell -ExecutionPolicy Bypass -File build-safety-edu-worker.ps1` 실행 → `safety-edu-worker.js` 갱신
   (Node가 있으면 `node build-safety-edu-worker.mjs` 로도 같은 결과)
3. 커밋 후 `main`에 푸시 → 자동 재배포
