# 🧰 선생님 도구상자

교실에서 자주 쓰는 문구를 만들어 바로 복사하는 도구 모음입니다. 화면 위쪽 탭으로 도구를 바꿉니다.
(원래 「안전교육 문구 복사기」 한 화면이었고, 지금은 그 도구가 1번 탭입니다. 주소·워커 이름은 그대로입니다.
실제 자동배포는 `geulssugi-mirror/safety-edu/` 쪽에서 이뤄지고, 이 저장소는 같은 내용을 보관합니다.)

## 🛡️ 탭 1 — 안전교육 문구

주간학습안내를 만들 때 안전교육 문구를 매번 손으로 바꾸는 번거로움을 없애기 위한 도구입니다.
주차(1~42주)를 고르면 [구글시트](https://docs.google.com/spreadsheets/d/1sC7x0KuTgRVybVoCzeHoJr0lcEGc1RCwCQYoX8TcJgA)의 최신 안전교육 문구 6개 항목을 표로 보여주고, 복사 버튼으로 바로 복사해서 한글 표에 붙여넣을 수 있습니다.

## ✉️ 탭 2 — 출결 간단 안내 문자

날짜·이름·출결 종류만 적으면 학부모 안내 문자를 만들어 줍니다. 한 줄에 한 건씩 적으면 여러 건을 한 번에 만듭니다.

입력 예시

```
7/21 임송현 질병결석
이도현 7/22 병지각
9/1 김민지, 이수현 질병결석
```

만들어지는 문자

```
안녕하세요, 학부모님.

7월 21일 임송현 학생의 질병결석 처리를 위해 나이스 학부모서비스에 결석 신고 등록을 부탁드립니다.
```

- 날짜: `7/21` `7.21` `7-21` `7월 21일` 모두 인식하고, 날짜를 빼면 오늘 날짜로 넣습니다.
- 출결 종류: 질병결석·병결·병지각·병조퇴·병결과·미인정(무단)결석·인정결석·기타결석·결석·지각·조퇴·결과
- 지각/조퇴/결과는 안내 문구가 `결석(지각) 신고`처럼 바뀝니다.
- 이름을 여러 개 적으면 이름마다 문자를 따로 만듭니다.
- 인사말은 체크 한 번으로 뺄 수 있습니다.
- **이 탭은 서버를 쓰지 않습니다.** 입력한 학생 이름은 전송·저장되지 않고 브라우저 화면에서만 쓰입니다.

## 구조

- `safety-edu-app/app.html` — 화면 (프론트엔드)
- `safety-edu-worker.template.js` — Cloudflare Worker 소스 템플릿 (`__APP_HTML__` 자리에 app.html이 끼워짐)
- `safety-edu-worker.js` — 빌드된 실제 배포 파일 (Cloudflare Worker에 이 파일이 그대로 올라감)
- `build-safety-edu-worker.ps1` — app.html을 고친 뒤 위 두 파일을 합쳐 `safety-edu-worker.js`를 다시 만드는 스크립트 (Windows PowerShell 필요)
- `wrangler.toml` — Cloudflare Workers 배포 설정

## 배포 (Cloudflare Workers, GitHub 연동)

Cloudflare 대시보드 → Workers & Pages → Create → "Import a repository" 에서 이 저장소를 연결하면,
`main` 브랜치에 푸시할 때마다 `wrangler.toml` 설정대로 자동 배포됩니다. 별도 빌드 명령 없이 `safety-edu-worker.js`를 그대로 올립니다.

## 화면(app.html)을 고칠 때

1. `safety-edu-app/app.html` 수정
2. `powershell -ExecutionPolicy Bypass -File build-safety-edu-worker.ps1` 실행 → `safety-edu-worker.js` 갱신
3. 커밋 후 `main`에 푸시 → 자동 재배포
