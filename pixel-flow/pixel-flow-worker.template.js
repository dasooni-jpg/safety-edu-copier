/*
 * 픽셀 플로우 v2 — 색깔 가방 도트 퍼즐 (Cloudflare Worker)
 * ──────────────────────────────────────────────────────────
 * 화면 파일 하나(pixel-flow/index.html)를 그대로 실어 나르는 아주 단순한 워커.
 * 서버에 저장하는 값은 없음. 진행 기록·설정은 모두 학생 기기(브라우저)에만 남음.
 *
 * ※ 이 파일은 build-pixel-flow-worker.ps1 이 만든 자동 생성본입니다.
 *    화면(pixel-flow/index.html)을 고친 뒤에는 빌드 스크립트를 다시 실행하세요.
 *
 * 배포 (Cloudflare 대시보드):
 *  1. Workers & Pages → 기존 pixel 워커 열기 → Edit code
 *  2. 이 파일(pixel-flow-worker.js) 내용을 전부 붙여넣고 Deploy
 *  3. 별도 DB/시크릿 설정 없음
 */

const APP_HTML = __APP_HTML__;

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    // 어떤 경로로 들어와도 게임 화면을 돌려준다 (뒤로가기·즐겨찾기 대응)
    return new Response(APP_HTML, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
};
