/*
 * 선생님 도구상자 — 온라인 서버 (Cloudflare Worker)
 * ──────────────────────────────────────────────────────────
 * 교실에서 자주 쓰는 문구를 만들어 복사하는 도구 모음. 화면은 탭으로 나뉨.
 *  1) 안전교육 문구 — 주차를 고르면 구글시트 최신 내용을 표로 보여주고 복사 → 한글 표에 붙여넣기
 *  2) 출결 안내 문자 — 날짜·이름·출결 종류를 적으면 나이스 신고 안내 문자를 만들어 복사
 *     (2번은 서버 없이 브라우저에서만 처리됨. 입력한 이름은 어디에도 저장되지 않음)
 *  - 주소: https://<워커주소>/
 *
 * ※ 이 파일은 build-safety-edu-worker.ps1 이 만든 자동 생성본입니다.
 *    화면(safety-edu-app/app.html)을 고친 뒤에는 빌드 스크립트를 다시 실행하세요.
 *
 * 설정 (Cloudflare 대시보드에서 1회만):
 *  1. Workers & Pages → Create → Worker 생성 (이름 예: safety-edu)
 *  2. 이 파일(safety-edu-worker.js) 내용을 그대로 붙여넣고 Deploy
 *  3. 별도 DB/시크릿 설정 필요 없음 — 구글시트가 "링크 있으면 누구나 보기"로 공개되어 있어야 함.
 */

const APP_HTML = __APP_HTML__;

const SHEET_ID = "1sC7x0KuTgRVybVoCzeHoJr0lcEGc1RCwCQYoX8TcJgA";
const SEMESTERS = [
  { gid: "808634812", label: "1학기" },
  { gid: "1239717373", label: "2학기" },
];
const CATEGORY_KEYS = ["성 안전", "신변 안전", "교통 안전", "학교생활 안전", "학교폭력·사이버 예방", "계절·행사 안전"];
const CACHE_SECONDS = 300;

// ── 아주 단순한 RFC4180 CSV 파서 (따옴표로 감싼 콤마 포함 필드 처리) ──
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

async function fetchSemester(sem, weeks) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${sem.gid}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${sem.label} 시트를 불러오지 못했어요 (HTTP ${res.status})`);
  let text = await res.text();
  text = text.replace(/^﻿/, "");
  const allRows = parseCsv(text);

  const headerIdx = allRows.findIndex(r => r[0] === "주차");
  if (headerIdx === -1) return;
  const header = allRows[headerIdx];
  const colIdx = {};
  header.forEach((h, i) => { colIdx[h] = i; });

  for (let i = headerIdx + 1; i < allRows.length; i++) {
    const r = allRows[i];
    const weekRaw = r[0];
    if (!weekRaw) continue;
    const m = weekRaw.match(/\d+/);
    if (!m) continue;
    const weekNum = parseInt(m[0], 10);
    const item = {};
    CATEGORY_KEYS.forEach(key => {
      const idx = colIdx[key];
      item[key] = (idx != null && r[idx] != null) ? r[idx].trim() : "";
    });
    weeks[weekNum] = item;
  }
}

async function getWeekData() {
  const weeks = {};
  for (const sem of SEMESTERS) {
    await fetchSemester(sem, weeks);
  }
  return weeks;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    const method = request.method;

    if ((method === "GET" || method === "HEAD") && (path === "/" || path === "/app.html" || path === "/index.html")) {
      return new Response(APP_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }

    if (path === "/api/data" && method === "GET") {
      const forceRefresh = url.searchParams.get("refresh") === "1";
      const cache = caches.default;
      const cacheKey = new Request(url.origin + "/api/data-cache-key");

      if (!forceRefresh) {
        const cached = await cache.match(cacheKey);
        if (cached) return cached;
      }

      try {
        const weeks = await getWeekData();
        const response = new Response(JSON.stringify(weeks), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
          },
        });
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      } catch (e) {
        return new Response(JSON.stringify({ error: e && e.message ? e.message : String(e) }), {
          status: 502,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
    }

    return new Response("404", { status: 404 });
  },
};
