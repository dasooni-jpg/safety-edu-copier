# 이 저장소에서 Claude가 지킬 규칙

## 1. 모든 앱은 Cloudflare 배포 파일까지 만들어야 완료임
- 화면이나 서버 코드를 고치면 반드시 빌드해서 배포 파일을 다시 만들고 함께 커밋함.
  - 빌드: `node build-safety-edu-worker.mjs`
  - 배포 파일: `safety-edu-worker.js` (Cloudflare Worker 편집기에 그대로 붙여넣는 파일)
- 새 앱(새 화면)을 추가하면 같은 방식의 Worker 빌드 파일을 만들고, README 에 비전공자용 올리는 순서
  (대시보드 어디를 누르고, 무엇이 보이면 성공인지)를 적음.
- DB·Durable Object 처럼 대시보드만으로 안 되는 설정은 `wrangler.toml` 과 명령어를 함께 제공함.
- 검증: 배포 파일 `node --check` 통과, 화면을 브라우저로 열어 오류 0건 확인.

## 2. 학생 개인정보 저장 금지
실명·사진·연락처를 저장하지 않음. 식별은 별명(또는 출석번호)만.

## 3. 비밀값은 커밋하지 않음
API 키·비밀번호는 Cloudflare 대시보드의 변수/비밀(Secrets)에 넣고, 코드에는 자리만 둠.
