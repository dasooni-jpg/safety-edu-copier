/*
 * 안전교육 문구 복사기 — 온라인 서버 (Cloudflare Worker)
 * ──────────────────────────────────────────────────────────
 * 주간학습안내를 만들 때 안전교육 문구를 매번 손으로 바꾸는 번거로움을 없애기 위한 도구.
 * 주차를 고르면 구글시트 최신 내용을 표로 보여주고 복사 버튼으로 복사 → 한글 표에 붙여넣기.
 *  - 주소: https://<워커주소>/
 *
 * 같은 워커에 "라운드 좋아요" 수업 도구도 함께 들어 있음.
 *  - 교사용: https://<워커주소>/vote/teacher
 *  - 학생용: https://<워커주소>/vote?code=1234
 *  - 방 상태는 Durable Object(VOTE_ROOM)에 저장되며 12시간 뒤 자동 삭제됨.
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
const VOTE_HTML = __VOTE_HTML__;

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


// ══════════════════════════════════════════════════════════
//  라운드 좋아요 (수업용 투표) — Durable Object + API
// ══════════════════════════════════════════════════════════

const VOTE_TTL_MS = 12 * 60 * 60 * 1000; // 방 유지 시간: 12시간
const VOTE_MAX_ROUNDS = 20;
const VOTE_MAX_DEVICES = 300;

function jsonRes(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** 방 하나 = Durable Object 하나. 좋아요 개수를 어긋남 없이 합산하기 위해 사용. */
export class VoteRoom {
  constructor(state, env) {
    this.state = state;
    this.room = null;
    this.loaded = false;
  }

  async load() {
    if (!this.loaded) {
      this.room = (await this.state.storage.get("room")) || null;
      this.loaded = true;
    }
    if (this.room && Date.now() - this.room.createdAt > VOTE_TTL_MS) {
      this.room = null;
      await this.state.storage.deleteAll();
    }
    return this.room;
  }

  async save() {
    await this.state.storage.put("room", this.room);
    await this.state.storage.setAlarm(Date.now() + VOTE_TTL_MS);
  }

  // 12시간 뒤 방 자동 정리
  async alarm() {
    await this.state.storage.deleteAll();
    this.room = null;
    this.loaded = true;
  }

  votesOf(n) {
    return this.room.votes[String(n)] || [];
  }

  hasVoted(device) {
    return this.votesOf(this.room.round).indexOf(device) !== -1;
  }

  /**
   * 공개한 라운드만 개수를 내보냄. 공개 전에는 null (교사도 미리 못 봄).
   * revealed[n]에는 "결과 보기를 누른 그 순간의 개수"를 저장해 둔다.
   * → 공개한 뒤 학생이 더 눌러도 화면 숫자가 저절로 바뀌지 않음(실시간 아님).
   */
  results() {
    const out = {};
    for (let i = 1; i <= this.room.rounds; i++) {
      const k = String(i);
      out[k] = (typeof this.room.revealed[k] === "number") ? this.room.revealed[k] : null;
    }
    return out;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;
    const method = request.method;
    let body = {};
    if (method === "POST") {
      try { body = await request.json(); } catch (e) { body = {}; }
    }

    // 방 만들기
    if (p === "/create" && method === "POST") {
      if (await this.load()) return jsonRes({ error: "이미 쓰고 있는 코드" }, 409);
      const rounds = parseInt(body.rounds, 10);
      if (!(rounds >= 1 && rounds <= VOTE_MAX_ROUNDS)) {
        return jsonRes({ error: "라운드 개수는 1~" + VOTE_MAX_ROUNDS + " 사이여야 합니다." }, 400);
      }
      this.room = {
        createdAt: Date.now(),
        rounds: rounds,
        round: 1,
        ended: false,
        token: String(body.token || ""),
        votes: {},
        revealed: {},
        devices: [],
      };
      this.loaded = true;
      await this.save();
      return jsonRes({ ok: true, rounds: rounds });
    }

    const room = await this.load();
    if (!room) {
      return jsonRes({ error: "그런 참여 코드가 없어요. 코드를 다시 확인해 주세요." }, 404);
    }

    // ── 학생용 (개수는 절대 내려보내지 않음) ──
    if (p === "/student" && method === "GET") {
      const device = url.searchParams.get("device") || "";
      if (!device) return jsonRes({ error: "기기 정보를 확인하지 못했어요." }, 400);
      if (room.devices.indexOf(device) === -1 && room.devices.length < VOTE_MAX_DEVICES) {
        room.devices.push(device);
        await this.save();
      }
      return jsonRes({
        round: room.round, rounds: room.rounds, ended: room.ended, voted: this.hasVoted(device),
      });
    }

    if (p === "/like" && method === "POST") {
      const device = String(body.device || "");
      if (!device) return jsonRes({ error: "기기 정보를 확인하지 못했어요." }, 400);
      if (room.ended) return jsonRes({ error: "오늘 활동이 끝났어요." }, 409);
      const key = String(room.round);
      if (!room.votes[key]) room.votes[key] = [];
      if (room.votes[key].indexOf(device) === -1) {
        room.votes[key].push(device);
        if (room.devices.indexOf(device) === -1 && room.devices.length < VOTE_MAX_DEVICES) {
          room.devices.push(device);
        }
        await this.save();
      }
      return jsonRes({ ok: true, round: room.round, rounds: room.rounds, ended: room.ended, voted: true });
    }

    // ── 여기서부터 교사 전용 (수업을 만든 기기의 토큰 필요) ──
    const token = method === "POST" ? String(body.token || "") : (url.searchParams.get("token") || "");
    if (!room.token || token !== room.token) {
      return jsonRes({ error: "선생님 권한이 아니에요. 이 기기에서 만든 수업이 아닙니다." }, 403);
    }

    if (p === "/teacher" && method === "GET") {
      return jsonRes({
        rounds: room.rounds, round: room.round, ended: room.ended,
        joined: room.devices.length, results: this.results(),
      });
    }

    if (p === "/reveal" && method === "POST") {
      let n = parseInt(body.round, 10);
      if (!(n >= 1 && n <= room.rounds)) n = room.round;
      room.revealed[String(n)] = this.votesOf(n).length; // 지금 이 순간의 개수를 고정
      await this.save();
      return jsonRes({
        ok: true, round: n, count: room.revealed[String(n)],
        joined: room.devices.length, results: this.results(),
      });
    }

    if (p === "/next" && method === "POST") {
      if (room.round < room.rounds) {
        room.round++;
        await this.save();
      }
      return jsonRes({ ok: true, round: room.round, rounds: room.rounds, joined: room.devices.length });
    }

    if (p === "/finish" && method === "POST") {
      room.ended = true;
      // 마무리할 때는 모든 라운드를 최종 개수로 확정
      for (let i = 1; i <= room.rounds; i++) room.revealed[String(i)] = this.votesOf(i).length;
      await this.save();
      return jsonRes({ ok: true, joined: room.devices.length, results: this.results() });
    }

    return jsonRes({ error: "알 수 없는 요청" }, 404);
  }
}

function voteStub(env, code) {
  return env.VOTE_ROOM.get(env.VOTE_ROOM.idFromName("room-" + code));
}

async function handleVoteApi(request, env, path, method, url) {
  if (!env.VOTE_ROOM) {
    return jsonRes({ error: "투표 저장소(VOTE_ROOM)가 아직 준비되지 않았습니다. wrangler.toml의 Durable Object 설정을 확인하세요." }, 500);
  }

  let body = {};
  if (method === "POST") {
    try { body = await request.json(); } catch (e) { body = {}; }
  }

  const sub = path.slice("/api/vote/".length);

  // 새 수업 만들기 — 비어 있는 4자리 코드를 찾을 때까지 시도
  if (sub === "create" && method === "POST") {
    const rounds = parseInt(body.rounds, 10);
    if (!(rounds >= 1 && rounds <= VOTE_MAX_ROUNDS)) {
      return jsonRes({ error: "라운드 개수는 1~" + VOTE_MAX_ROUNDS + " 사이여야 합니다." }, 400);
    }
    const token = crypto.randomUUID();
    for (let i = 0; i < 12; i++) {
      const code = String(1000 + Math.floor(Math.random() * 9000));
      const res = await voteStub(env, code).fetch("https://room/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rounds: rounds, token: token }),
      });
      if (res.status === 409) continue;
      if (!res.ok) return new Response(await res.text(), { status: res.status, headers: { "Content-Type": "application/json; charset=utf-8" } });
      return jsonRes({ code: code, token: token, rounds: rounds });
    }
    return jsonRes({ error: "참여 코드를 만들지 못했어요. 잠시 뒤 다시 해 주세요." }, 503);
  }

  const ROUTES = {
    student: "/student", like: "/like", teacher: "/teacher",
    reveal: "/reveal", next: "/next", finish: "/finish",
  };
  const target = ROUTES[sub];
  if (!target) return jsonRes({ error: "알 수 없는 요청" }, 404);

  const rawCode = method === "POST" ? String(body.code || "") : (url.searchParams.get("code") || "");
  const code = rawCode.replace(/[^0-9]/g, "");
  if (!/^[0-9]{4}$/.test(code)) return jsonRes({ error: "참여 코드는 숫자 4자리예요." }, 400);

  let res;
  if (method === "POST") {
    res = await voteStub(env, code).fetch("https://room" + target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } else {
    const qs = new URLSearchParams();
    const device = url.searchParams.get("device");
    const token = url.searchParams.get("token");
    if (device) qs.set("device", device);
    if (token) qs.set("token", token);
    res = await voteStub(env, code).fetch("https://room" + target + "?" + qs.toString());
  }
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
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

    // ── 라운드 좋아요 ──
    if ((method === "GET" || method === "HEAD") &&
        (path === "/vote" || path === "/vote/" || path === "/vote/teacher" || path === "/vote/teacher/")) {
      return new Response(VOTE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }

    if (path.startsWith("/api/vote/")) {
      return handleVoteApi(request, env, path, method, url);
    }

    return new Response("404", { status: 404 });
  },
};
