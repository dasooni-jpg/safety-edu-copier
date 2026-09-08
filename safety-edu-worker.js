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

const APP_HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>선생님 도구상자</title>
<style>
  :root {
    --main: #3d7a5c;
    --main-light: #eaf5ee;
    --accent: #e08a3c;
    --text: #2b2b2b;
    --sub: #6b6b6b;
    --border: #dbe6df;
    --bg: #f7faf8;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Pretendard", "Malgun Gothic", "맑은 고딕", sans-serif;
    background: var(--bg);
    color: var(--text);
    padding: 24px;
  }
  .wrap {
    max-width: 720px;
    margin: 0 auto;
  }
  h1 {
    font-size: 22px;
    margin: 0 0 4px;
    color: var(--main);
  }
  .desc {
    color: var(--sub);
    font-size: 14px;
    margin-bottom: 16px;
  }
  /* ── 탭 ── */
  .tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }
  .tab {
    font-family: inherit;
    font-size: 15px;
    font-weight: 600;
    padding: 10px 16px;
    border-radius: 10px 10px 0 0;
    border: 1px solid var(--border);
    border-bottom: none;
    background: #fff;
    color: var(--sub);
    cursor: pointer;
  }
  .tab.on {
    background: var(--main);
    border-color: var(--main);
    color: #fff;
  }
  .panel[hidden] { display: none; }
  .card {
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 16px;
  }
  .controls {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }
  select {
    font-size: 15px;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: #fff;
  }
  .refresh-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 12px;
    font-size: 13px;
    color: var(--sub);
    cursor: pointer;
  }
  .refresh-btn:hover { background: var(--main-light); }
  .status {
    font-size: 12px;
    color: var(--sub);
    margin-left: auto;
  }
  label.toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--sub);
    margin-top: 14px;
    cursor: pointer;
  }
  .output-box {
    margin-top: 14px;
  }
  textarea {
    width: 100%;
    min-height: 160px;
    font-size: 15px;
    line-height: 1.7;
    padding: 14px;
    border-radius: 10px;
    border: 1px solid var(--border);
    resize: vertical;
    font-family: inherit;
    background: var(--main-light);
  }
  textarea.input {
    background: #fff;
    min-height: 92px;
  }
  .copy-btn {
    margin-top: 10px;
    width: 100%;
    background: var(--main);
    color: #fff;
    border: none;
    border-radius: 10px;
    padding: 13px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
  }
  .copy-btn:hover { background: #2f6249; }
  .copy-btn.copied { background: var(--accent); }
  .copy-btn.small {
    width: auto;
    margin: 0;
    padding: 7px 14px;
    font-size: 13px;
    border-radius: 8px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
    margin-top: 4px;
  }
  td {
    padding: 8px 6px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  td.label {
    color: var(--main);
    font-weight: 600;
    width: 130px;
    white-space: nowrap;
  }
  .error {
    color: #c0392b;
    font-size: 14px;
  }
  .hint {
    font-size: 12px;
    color: var(--sub);
    margin-top: 6px;
  }
  /* ── 출결 안내 문자 ── */
  .msg {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px;
    margin-top: 12px;
    background: var(--main-light);
  }
  .msg.bad {
    background: #fdf1ef;
    border-color: #f0cfc9;
  }
  .msg .body {
    font-size: 15px;
    line-height: 1.7;
    white-space: pre-wrap;
    word-break: keep-all;
  }
  .msg .foot {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 10px;
    flex-wrap: wrap;
  }
  .msg .src {
    font-size: 12px;
    color: var(--sub);
  }
  .badge {
    display: inline-block;
    font-size: 11px;
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 1px 6px;
    margin-left: 6px;
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>🧰 선생님 도구상자</h1>
  <div class="desc">교실에서 자주 쓰는 문구를 골라 만들고 바로 복사하는 도구 모음이에요.</div>

  <div class="tabs">
    <button class="tab on" data-tab="safety">🛡️ 안전교육 문구</button>
    <button class="tab" data-tab="attend">✉️ 출결 안내 문자</button>
  </div>

  <!-- ═══ 탭 1: 안전교육 문구 복사기 ═══ -->
  <section class="panel" id="panel-safety">
    <div class="desc">주차를 고르면 스프레드시트 최신 안전교육 문구를 불러와요. 복사해서 한글 주간학습안내 표에 붙여넣으세요.</div>
    <div class="card">
      <div class="controls">
        <select id="weekSelect"></select>
        <button class="refresh-btn" id="refreshBtn">↻ 최신 내용 다시 불러오기</button>
        <span class="status" id="statusText">불러오는 중...</span>
      </div>

      <div id="content"></div>

      <label class="toggle">
        <input type="checkbox" id="labelToggle" checked>
        항목 이름(성 안전, 교통 안전 등) 포함해서 복사하기
      </label>

      <div class="output-box">
        <textarea id="output" readonly></textarea>
        <button class="copy-btn" id="copyBtn">복사하기</button>
        <div class="hint">복사 후 한글 표의 안전교육 칸에 붙여넣기(Ctrl+V) 하세요.</div>
      </div>
    </div>
  </section>

  <!-- ═══ 탭 2: 출결 간단 안내 문자 ═══ -->
  <section class="panel" id="panel-attend" hidden>
    <div class="desc">날짜·이름·출결 종류만 적으면 학부모 안내 문자를 만들어요. 한 줄에 한 건씩 적으면 여러 건도 한 번에 만들어져요.</div>
    <div class="card">
      <textarea class="input" id="attendInput" placeholder="7/21 임송현 질병결석&#10;이도현 7/22 병지각&#10;7/23 김하늘 조퇴"></textarea>

      <label class="toggle">
        <input type="checkbox" id="greetToggle" checked>
        “안녕하세요, 학부모님.” 인사말 넣기
      </label>

      <div id="attendResult"></div>

      <button class="copy-btn" id="attendCopyAllBtn" hidden>만들어진 문자 모두 복사하기</button>
      <div class="hint">
        인식하는 말: 질병결석 · 병결 · 병지각 · 병조퇴 · 병결과 · 미인정(무단)결석 · 인정결석 · 기타결석 · 결석 · 지각 · 조퇴 · 결과<br>
        날짜를 빼면 오늘 날짜로 만들어요. 입력한 내용은 저장되지 않고 이 화면에서만 쓰여요.
      </div>
    </div>
  </section>
</div>

<script>
/* ═══════════ 탭 전환 ═══════════ */
document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(b => b.classList.toggle("on", b === btn));
    document.querySelectorAll(".panel").forEach(p => {
      p.hidden = (p.id !== "panel-" + btn.dataset.tab);
    });
  });
});

/* ═══════════ 공통: 복사 ═══════════ */
async function copyText(text, btn, doneLabel) {
  let ok = true;
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (e2) {
      ok = false;
    }
  }
  if (btn) {
    const original = btn.dataset.label || btn.textContent;
    btn.dataset.label = original;
    btn.textContent = ok ? (doneLabel || "복사됨!") : "복사 실패 - 직접 드래그해서 복사해주세요";
    btn.classList.toggle("copied", ok);
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove("copied");
    }, 1500);
  }
  return ok;
}

/* ═══════════ 탭 1: 안전교육 문구 ═══════════ */
const SEMESTERS = [
  { label: "1학기", start: 1, end: 22 },
  { label: "2학기", start: 23, end: 42 }
];
const CATEGORY_KEYS = ["성 안전", "신변 안전", "교통 안전", "학교생활 안전", "학교폭력·사이버 예방", "계절·행사 안전"];

let weekData = {};

function showError(msg) {
  document.getElementById("statusText").textContent = "오류";
  document.getElementById("content").innerHTML = '<div class="error">' + msg + '</div>';
}

async function loadAll(forceRefresh) {
  weekData = {};
  document.getElementById("statusText").textContent = "불러오는 중...";
  document.getElementById("content").innerHTML = "";
  try {
    const url = "/api/data" + (forceRefresh ? "?refresh=1" : "");
    const res = await fetch(url);
    const json = await res.json();
    if (json.error) {
      showError("스프레드시트를 불러오지 못했어요: " + json.error);
      return;
    }
    weekData = json;
    onAllLoaded();
  } catch (e) {
    showError("서버에서 데이터를 가져오지 못했어요. 서버가 켜져 있는지 확인해주세요.");
  }
}

function onAllLoaded() {
  const now = new Date();
  document.getElementById("statusText").textContent =
    "업데이트: " + now.getHours() + ":" + String(now.getMinutes()).padStart(2, "0");
  renderWeek();
}

function buildWeekOptions() {
  const sel = document.getElementById("weekSelect");
  sel.innerHTML = "";
  SEMESTERS.forEach(sem => {
    const group = document.createElement("optgroup");
    group.label = sem.label;
    for (let w = sem.start; w <= sem.end; w++) {
      const opt = document.createElement("option");
      opt.value = w;
      opt.textContent = w + "주";
      group.appendChild(opt);
    }
    sel.appendChild(group);
  });
}

function renderWeek() {
  const week = parseInt(document.getElementById("weekSelect").value, 10);
  const item = weekData[week];
  const contentEl = document.getElementById("content");
  if (!item) {
    contentEl.innerHTML = '<div class="error">해당 주차 데이터가 없어요.</div>';
    document.getElementById("output").value = "";
    return;
  }
  let html = "<table>";
  CATEGORY_KEYS.forEach(key => {
    html += "<tr><td class='label'>" + key + "</td><td>" + (item[key] || "") + "</td></tr>";
  });
  html += "</table>";
  contentEl.innerHTML = html;
  updateOutput();
}

function updateOutput() {
  const week = parseInt(document.getElementById("weekSelect").value, 10);
  const item = weekData[week];
  if (!item) return;
  const withLabel = document.getElementById("labelToggle").checked;
  const parts = CATEGORY_KEYS.map(key => {
    const val = item[key] || "";
    return "□ " + (withLabel ? (key + ": " + val) : val);
  });
  const lines = [];
  for (let i = 0; i < parts.length; i += 2) {
    lines.push(parts.slice(i, i + 2).join("  "));
  }
  document.getElementById("output").value = lines.join("\\n");
}

document.getElementById("weekSelect").addEventListener("change", renderWeek);
document.getElementById("labelToggle").addEventListener("change", updateOutput);
document.getElementById("refreshBtn").addEventListener("click", () => loadAll(true));
document.getElementById("copyBtn").addEventListener("click", function () {
  copyText(document.getElementById("output").value, this);
});

buildWeekOptions();
loadAll();

/* ═══════════ 탭 2: 출결 간단 안내 문자 ═══════════ */
// 출결 종류: 긴 말부터 찾아야 "인정결석"이 "결석"으로 잘못 잡히지 않음
const ATTEND_TYPES = [
  { keys: ["질병결석", "병결석", "병결"], label: "질병결석", kind: "결석" },
  { keys: ["질병지각", "병지각"], label: "질병지각", kind: "지각" },
  { keys: ["질병조퇴", "병조퇴"], label: "질병조퇴", kind: "조퇴" },
  { keys: ["질병결과", "병결과"], label: "질병결과", kind: "결과" },
  { keys: ["미인정결석", "무단결석"], label: "미인정결석", kind: "결석" },
  { keys: ["미인정지각", "무단지각"], label: "미인정지각", kind: "지각" },
  { keys: ["미인정조퇴", "무단조퇴"], label: "미인정조퇴", kind: "조퇴" },
  { keys: ["미인정결과", "무단결과"], label: "미인정결과", kind: "결과" },
  { keys: ["출석인정결석", "인정결석"], label: "인정결석", kind: "결석" },
  { keys: ["출석인정지각", "인정지각"], label: "인정지각", kind: "지각" },
  { keys: ["출석인정조퇴", "인정조퇴"], label: "인정조퇴", kind: "조퇴" },
  { keys: ["출석인정결과", "인정결과"], label: "인정결과", kind: "결과" },
  { keys: ["기타결석"], label: "기타결석", kind: "결석" },
  { keys: ["기타지각"], label: "기타지각", kind: "지각" },
  { keys: ["기타조퇴"], label: "기타조퇴", kind: "조퇴" },
  { keys: ["기타결과"], label: "기타결과", kind: "결과" },
  { keys: ["결석"], label: "결석", kind: "결석" },
  { keys: ["지각"], label: "지각", kind: "지각" },
  { keys: ["조퇴"], label: "조퇴", kind: "조퇴" },
  { keys: ["결과"], label: "결과", kind: "결과" }
];

// { key, type } 목록을 말 길이 내림차순으로 펼쳐 둠
const ATTEND_KEYS = ATTEND_TYPES
  .reduce((acc, t) => acc.concat(t.keys.map(k => ({ key: k, type: t }))), [])
  .sort((a, b) => b.key.length - a.key.length);

function findAttendType(line) {
  for (const item of ATTEND_KEYS) {
    const at = line.indexOf(item.key);
    if (at !== -1) return { type: item.type, at: at, key: item.key };
  }
  return null;
}

function findAttendDate(line) {
  // 7/21, 7.21, 7-21, 7월 21일 모두 인식
  const m = line.match(/(\\d{1,2})\\s*[월./\\-]\\s*(\\d{1,2})\\s*일?/);
  if (!m) return null;
  const month = parseInt(m[1], 10);
  const day = parseInt(m[2], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month: month, day: day, at: m.index, raw: m[0] };
}

function findAttendNames(rest) {
  return rest
    .split(/[\\s,、·/]+/)
    .map(s => s.replace(/^[(\\[{'"]+|[)\\]}'"?!.]+$/g, "").trim())
    .filter(s => /^[가-힣]{2,5}$/.test(s));
}

// 한 줄 → 메시지 여러 개(이름이 여럿이면 이름마다 하나씩)
function parseAttendLine(line) {
  const type = findAttendType(line);
  if (!type) {
    return [{ ok: false, src: line, reason: "출결 종류(질병결석·병지각 등)를 찾지 못했어요." }];
  }
  const date = findAttendDate(line);

  let rest = line;
  rest = rest.slice(0, type.at) + " " + rest.slice(type.at + type.key.length);
  if (date) rest = rest.replace(date.raw, " ");
  // 학생/님/때문에 같은 꼬리말은 이름 후보에서 빼 둠
  rest = rest.replace(/학생|어린이|학부모님|학부모|님/g, " ");

  const names = findAttendNames(rest);
  if (!names.length) {
    return [{ ok: false, src: line, reason: "학생 이름을 찾지 못했어요. (한글 이름 2~5자)" }];
  }

  let month, day, today = false;
  if (date) {
    month = date.month;
    day = date.day;
  } else {
    const now = new Date();
    month = now.getMonth() + 1;
    day = now.getDate();
    today = true;
  }

  return names.map(name => ({
    ok: true,
    src: line,
    name: name,
    month: month,
    day: day,
    today: today,
    type: type.type
  }));
}

function buildAttendMessage(item, withGreeting) {
  // 결석 신고 / 결석(지각) 신고 / 결석(조퇴) 신고 / 결석(결과) 신고
  const report = item.type.kind === "결석" ? "결석 신고" : "결석(" + item.type.kind + ") 신고";
  const sentence = item.month + "월 " + item.day + "일 " + item.name + " 학생의 " + item.type.label +
    " 처리를 위해 나이스 학부모서비스에 " + report + " 등록을 부탁드립니다.";
  return withGreeting ? "안녕하세요, 학부모님.\\n\\n" + sentence : sentence;
}

function renderAttend() {
  const raw = document.getElementById("attendInput").value;
  const withGreeting = document.getElementById("greetToggle").checked;
  const resultEl = document.getElementById("attendResult");
  const copyAllBtn = document.getElementById("attendCopyAllBtn");
  resultEl.innerHTML = "";

  const lines = raw.split("\\n").map(s => s.trim()).filter(s => s.length);
  if (!lines.length) {
    copyAllBtn.hidden = true;
    return;
  }

  const items = lines.reduce((acc, line) => acc.concat(parseAttendLine(line)), []);
  const messages = [];

  items.forEach(item => {
    const box = document.createElement("div");
    box.className = "msg" + (item.ok ? "" : " bad");

    const body = document.createElement("div");
    body.className = "body";

    if (item.ok) {
      const text = buildAttendMessage(item, withGreeting);
      messages.push(text);
      body.textContent = text;
      box.appendChild(body);

      const foot = document.createElement("div");
      foot.className = "foot";
      const btn = document.createElement("button");
      btn.className = "copy-btn small";
      btn.textContent = "복사하기";
      btn.addEventListener("click", function () { copyText(text, this); });
      foot.appendChild(btn);
      if (item.today) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = "날짜가 없어 오늘 날짜로 넣었어요";
        foot.appendChild(badge);
      }
      box.appendChild(foot);
    } else {
      body.innerHTML = '<span class="error">' + item.reason + "</span>";
      box.appendChild(body);
      const src = document.createElement("div");
      src.className = "src";
      src.textContent = "입력한 줄: " + item.src;
      box.appendChild(src);
    }

    resultEl.appendChild(box);
  });

  copyAllBtn.hidden = messages.length < 2;
  copyAllBtn.dataset.all = messages.join("\\n\\n");
}

document.getElementById("attendInput").addEventListener("input", renderAttend);
document.getElementById("greetToggle").addEventListener("change", renderAttend);
document.getElementById("attendCopyAllBtn").addEventListener("click", function () {
  copyText(this.dataset.all || "", this, "모두 복사됨!");
});
</script>
</body>
</html>
`;

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
