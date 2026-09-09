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

const APP_HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>안전교육 문구 복사기</title>
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
    margin-bottom: 20px;
  }
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
  }
  .copy-btn:hover { background: #2f6249; }
  .copy-btn.copied { background: var(--accent); }
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
</style>
</head>
<body>
<div class="wrap">
  <h1>🛡️ 안전교육 문구 복사기</h1>
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
</div>

<script>
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
document.getElementById("copyBtn").addEventListener("click", async function () {
  const output = document.getElementById("output");
  output.select();
  let ok = true;
  try {
    await navigator.clipboard.writeText(output.value);
  } catch (e) {
    try {
      ok = document.execCommand("copy");
    } catch (e2) {
      ok = false;
    }
  }
  const btn = document.getElementById("copyBtn");
  const original = btn.textContent;
  btn.textContent = ok ? "복사됨!" : "복사 실패 - 직접 드래그해서 복사해주세요";
  btn.classList.toggle("copied", ok);
  setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove("copied");
  }, 1500);
});

buildWeekOptions();
loadAll();
</script>
</body>
</html>
`;
const VOTE_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="robots" content="noindex">
<title>라운드 좋아요</title>
<style>
  :root{
    --bg:#f4f6fb; --card:#ffffff; --ink:#1d2330; --muted:#6b7280;
    --line:#e5e8f0; --accent:#ff4d6d; --accent-dark:#e03354;
    --blue:#3b6cf5; --blue-dark:#2b55cc; --green:#12a150; --gray:#9aa2b1;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{
    background:var(--bg); color:var(--ink);
    font-family:system-ui,-apple-system,"Segoe UI","Malgun Gothic","맑은 고딕","Apple SD Gothic Neo",sans-serif;
    -webkit-text-size-adjust:100%;
    min-height:100vh;
  }
  .wrap{max-width:760px;margin:0 auto;padding:20px 16px 48px}
  .screen{display:none}
  .screen.on{display:block}
  h1{font-size:26px;margin:8px 0 4px;letter-spacing:-.5px}
  .sub{color:var(--muted);font-size:15px;margin:0 0 20px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:20px;margin-bottom:14px}
  .btn{
    display:block;width:100%;border:0;border-radius:14px;padding:16px 18px;
    font-size:18px;font-weight:700;cursor:pointer;font-family:inherit;
    background:var(--blue);color:#fff;margin-top:10px;
  }
  .btn:active{transform:translateY(1px)}
  .btn.sub-btn{background:#eceffa;color:var(--blue-dark)}
  .btn.ghost{background:#fff;color:var(--muted);border:1px solid var(--line);font-weight:600;font-size:16px}
  .btn.pink{background:var(--accent)}
  .btn:disabled{background:#dfe3ec;color:#9aa2b1;cursor:default}
  label{display:block;font-weight:700;font-size:15px;margin-bottom:8px}
  input[type=number],input[type=text]{
    width:100%;padding:14px 16px;font-size:22px;font-family:inherit;text-align:center;
    border:2px solid var(--line);border-radius:14px;background:#fbfcfe;color:var(--ink);
  }
  input:focus{outline:none;border-color:var(--blue)}
  .stepper{display:flex;gap:10px;align-items:center}
  .stepper button{
    width:58px;height:58px;flex:none;border:2px solid var(--line);background:#fff;
    border-radius:14px;font-size:26px;font-weight:700;color:var(--blue-dark);cursor:pointer;font-family:inherit;
  }
  .codebox{text-align:center;padding:18px 12px}
  .codebox .lab{font-size:14px;color:var(--muted);font-weight:700}
  .code{font-size:56px;font-weight:800;letter-spacing:10px;margin:6px 0 2px;color:var(--blue-dark)}
  .urlline{font-size:15px;color:var(--muted);word-break:break-all;margin-top:6px}
  .urlline b{color:var(--ink)}
  .rowline{display:flex;justify-content:space-between;align-items:center;gap:12px}
  .roundtag{font-size:20px;font-weight:800}
  .roundtag small{font-size:14px;color:var(--muted);font-weight:700}
  .pill{background:#eef1fa;color:var(--blue-dark);border-radius:999px;padding:6px 14px;font-size:14px;font-weight:700}
  .resultbox{text-align:center;padding:26px 12px 22px}
  .resultbox .hint{color:var(--muted);font-size:16px;font-weight:600}
  .bignum{font-size:88px;font-weight:800;line-height:1.05;color:var(--accent)}
  .bignum .heart{font-size:52px;vertical-align:14px}
  table{width:100%;border-collapse:collapse;font-size:16px}
  th,td{padding:11px 8px;border-bottom:1px solid var(--line);text-align:center}
  th{font-size:13px;color:var(--muted);font-weight:700}
  td.cnt{font-weight:800;font-size:19px}
  td .peek{border:1px solid var(--line);background:#fff;border-radius:10px;padding:6px 12px;font-size:14px;font-weight:700;color:var(--blue-dark);cursor:pointer;font-family:inherit}
  .heartbtn{
    display:block;width:100%;max-width:340px;margin:14px auto;aspect-ratio:1/1;
    border:0;border-radius:50%;background:var(--accent);color:#fff;
    font-size:104px;line-height:1;cursor:pointer;font-family:inherit;
    box-shadow:0 10px 0 var(--accent-dark);
  }
  .heartbtn:active{transform:translateY(6px);box-shadow:0 4px 0 var(--accent-dark)}
  .heartbtn:disabled{background:#dfe3ec;color:#fff;box-shadow:0 10px 0 #c6ccd8;cursor:default}
  .heartbtn.done{background:var(--green);box-shadow:0 10px 0 #0b7a3c}
  .bigmsg{text-align:center;font-size:22px;font-weight:800;margin:10px 0 0}
  .bigmsg.mute{color:var(--muted);font-weight:700;font-size:18px}
  .center{text-align:center}
  .err{background:#fff1f2;border:1px solid #ffd7dc;color:#b4232f;border-radius:12px;padding:12px 14px;font-size:15px;font-weight:600;margin-bottom:12px;display:none}
  .err.on{display:block}
  .foot{color:var(--gray);font-size:13px;text-align:center;margin-top:22px;line-height:1.7}
  .foot a{color:var(--gray)}
  .qrwrap{margin:14px auto 4px;display:inline-block;padding:10px;background:#fff;border:1px solid var(--line);border-radius:14px;cursor:pointer;line-height:0}
  .qrwrap svg{display:block}
  .qrhint{font-size:13px;color:var(--muted);font-weight:600}
  .overlay{position:fixed;inset:0;background:#fff;z-index:100;display:none;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:16px;cursor:pointer}
  .overlay.on{display:flex}
  .overlay .ovcode{font-size:clamp(40px,9vw,96px);font-weight:800;letter-spacing:.12em;color:var(--blue-dark);line-height:1}
  .overlay .ovqr{line-height:0}
  .overlay .ovqr svg{width:min(62vw,62vh);height:min(62vw,62vh)}
  .overlay .ovurl{font-size:clamp(13px,2.2vw,20px);color:var(--muted);font-weight:700;word-break:break-all;text-align:center}
  .overlay .ovclose{font-size:14px;color:var(--gray);font-weight:600}
  @keyframes pop{0%{transform:scale(.6);opacity:0}60%{transform:scale(1.12)}100%{transform:scale(1);opacity:1}}
  .pop{animation:pop .45s ease-out}
</style>
</head>
<body>
<div class="wrap">

  <!-- 0. 첫 화면 : 역할 고르기 -->
  <section id="s-pick" class="screen">
    <h1>라운드 좋아요 ❤️</h1>
    <p class="sub">한 라운드에 한 번씩 좋아요를 누르는 수업 도구</p>
    <div class="card">
      <button class="btn" onclick="go('teacher')">교사용 — 새 수업 시작</button>
      <button class="btn sub-btn" onclick="go('student')">학생용 — 코드 넣고 참여</button>
    </div>
    <div class="card" id="resume-card" style="display:none">
      <div class="rowline">
        <div><b>진행 중이던 수업</b><br><span class="urlline">코드 <b id="resume-code"></b></span></div>
        <button class="btn" style="width:auto;margin:0;padding:12px 18px;font-size:16px" onclick="resumeTeacher()">이어서 열기</button>
      </div>
    </div>
  </section>

  <!-- 1. 교사 : 라운드 개수 설정 -->
  <section id="s-setup" class="screen">
    <h1>수업 준비</h1>
    <p class="sub">오늘 좋아요를 받을 라운드가 몇 번인가요?</p>
    <div class="err" id="setup-err"></div>
    <div class="card">
      <label for="rounds">라운드 개수 (1 ~ 20)</label>
      <div class="stepper">
        <button type="button" onclick="bump(-1)">−</button>
        <input id="rounds" type="number" min="1" max="20" step="1" value="5" inputmode="numeric">
        <button type="button" onclick="bump(1)">＋</button>
      </div>
      <button class="btn" id="btn-create" onclick="createRoom()">수업 시작하기</button>
      <button class="btn ghost" onclick="go('pick')">뒤로</button>
    </div>
  </section>

  <!-- 2. 교사 : 진행 화면 -->
  <section id="s-run" class="screen">
    <div class="err" id="run-err"></div>

    <div class="card codebox">
      <div class="lab">학생 참여 코드</div>
      <div class="code" id="t-code">----</div>
      <div class="qrwrap" id="t-qr" onclick="bigQr()"></div>
      <div class="qrhint">휴대폰 카메라로 찍으면 바로 들어와요 · 누르면 크게 보기</div>
      <div class="urlline" style="margin-top:10px">학생은 <b id="t-url">주소</b> 로 접속</div>
      <div class="urlline" style="margin-top:10px">
        <span class="pill">접속한 기기 <b id="t-joined">0</b></span>
      </div>
    </div>

    <div class="card">
      <div class="rowline">
        <div class="roundtag">라운드 <span id="t-round">1</span> <small>/ <span id="t-rounds">5</span></small></div>
        <div class="pill" id="t-state">받는 중</div>
      </div>

      <div class="resultbox" id="t-resultbox">
        <div class="hint" id="t-hint">결과 보기를 누르면 이번 라운드 좋아요 개수가 나옵니다.</div>
        <div class="bignum" id="t-count" style="display:none"><span class="heart">❤️</span> <span id="t-countnum">0</span></div>
      </div>

      <button class="btn pink" id="btn-reveal" onclick="reveal()">이번 라운드 결과 보기</button>
      <button class="btn" id="btn-next" onclick="nextRound()">다음 라운드로</button>
      <button class="btn ghost" id="btn-finish" onclick="finishClass()">수업 끝내기</button>
    </div>

    <div class="card">
      <table>
        <thead><tr><th style="width:34%">라운드</th><th>좋아요</th></tr></thead>
        <tbody id="t-table"></tbody>
        <tfoot id="t-foot"></tfoot>
      </table>
    </div>

    <button class="btn ghost" id="btn-leave" onclick="leaveRoom()">이 수업 닫기 (새 수업 만들기)</button>
  </section>

  <!-- 3. 학생 : 코드 입력 -->
  <section id="s-join" class="screen">
    <h1>참여하기</h1>
    <p class="sub">선생님 화면에 있는 숫자 4자리를 넣어요.</p>
    <div class="err" id="join-err"></div>
    <div class="card">
      <label for="joincode">참여 코드</label>
      <input id="joincode" type="text" inputmode="numeric" maxlength="4" placeholder="0000"
             style="font-size:40px;letter-spacing:12px;font-weight:800">
      <button class="btn" id="btn-join" onclick="joinRoom()">들어가기</button>
      <button class="btn ghost" onclick="go('pick')">뒤로</button>
    </div>
  </section>

  <!-- 4. 학생 : 좋아요 화면 -->
  <section id="s-like" class="screen">
    <div class="err" id="like-err"></div>
    <div class="card">
      <div class="rowline">
        <div class="roundtag">라운드 <span id="s-round">1</span> <small>/ <span id="s-rounds">5</span></small></div>
        <div class="pill">코드 <span id="s-code">----</span></div>
      </div>
      <button class="heartbtn" id="btn-like" onclick="sendLike()">❤️</button>
      <p class="bigmsg" id="s-msg">좋아요를 한 번 누를 수 있어요!</p>
      <p class="bigmsg mute" id="s-sub">라운드마다 딱 한 번이에요.</p>
    </div>
    <button class="btn ghost" onclick="leaveStudent()">나가기</button>
  </section>

  <div class="overlay" id="qr-overlay" onclick="closeQr()">
    <div class="ovcode" id="ov-code">----</div>
    <div class="ovqr" id="ov-qr"></div>
    <div class="ovurl" id="ov-url"></div>
    <div class="ovclose">아무 곳이나 누르면 닫혀요</div>
  </div>

  <p class="foot">
    이름·사진 같은 개인정보는 저장하지 않습니다. 기기 구분용 임의 번호만 사용합니다.
  </p>
</div>

<script>
(function(){
  "use strict";

  // ── 아주 작은 QR 코드 생성기 (바이트 모드, 오류정정 L, 버전 1~10) ──
  // 외부 라이브러리 없이 동작하도록 앱 안에 직접 넣음.
  function qrMatrix(text) {
    // 오류정정 L 기준 [EC코드워드수, 그룹1블록수, 그룹1데이터수, 그룹2블록수, 그룹2데이터수]
    var EC = {
      1:[7,1,19,0,0], 2:[10,1,34,0,0], 3:[15,1,55,0,0], 4:[20,1,80,0,0], 5:[26,1,108,0,0],
      6:[18,2,68,0,0], 7:[20,2,78,0,0], 8:[24,2,97,0,0], 9:[30,2,116,0,0], 10:[18,2,68,2,69]
    };
    var ALIGN = {1:[],2:[6,18],3:[6,22],4:[6,26],5:[6,30],6:[6,34],7:[6,22,38],8:[6,24,42],9:[6,26,46],10:[6,28,50]};
    var REMAIN = {1:0,2:7,3:7,4:7,5:7,6:7,7:0,8:0,9:0,10:0};
    var FORMAT_L = [0x77C4,0x72F3,0x7DAA,0x789D,0x662F,0x6318,0x6C41,0x6976];
    var VERINFO = {7:0x07C94,8:0x085BC,9:0x09A99,10:0x0A4D3};

    // GF(256) 표
    var EXP = new Array(512), LOG = new Array(256), x = 1;
    for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; }
    for (i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
    function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

    function genPoly(n) {
      var g = [1];
      for (var i = 0; i < n; i++) {
        var res = [];
        for (var k = 0; k <= g.length; k++) res.push(0);
        for (var j = 0; j < g.length; j++) { res[j] ^= g[j]; res[j + 1] ^= gmul(g[j], EXP[i]); }
        g = res;
      }
      return g;
    }
    function ecBytes(block, ecLen) {
      var g = genPoly(ecLen), rem = block.slice();
      for (var i = 0; i < ecLen; i++) rem.push(0);
      for (i = 0; i < block.length; i++) {
        var coef = rem[i];
        if (coef !== 0) for (var j = 1; j < g.length; j++) rem[i + j] ^= gmul(g[j], coef);
      }
      return rem.slice(block.length);
    }

    // UTF-8 바이트로
    var data = [];
    for (i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 0x80) data.push(c);
      else if (c < 0x800) data.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0xD800 || c >= 0xE000) data.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else { i++; var cp = 0x10000 + (((c & 0x3FF) << 10) | (text.charCodeAt(i) & 0x3FF));
             data.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)); }
    }

    // 들어갈 수 있는 가장 작은 버전 고르기
    var ver = 0;
    for (var v = 1; v <= 10; v++) {
      var t0 = EC[v], capBytes = t0[1] * t0[2] + t0[3] * t0[4];
      if (4 + (v < 10 ? 8 : 16) + data.length * 8 <= capBytes * 8) { ver = v; break; }
    }
    if (!ver) return null; // 너무 긴 주소 — QR 생략

    var t = EC[ver], ecLen = t[0];
    var totalData = t[1] * t[2] + t[3] * t[4];

    // 비트열 만들기
    var bits = [];
    function push(val, len) { for (var b = len - 1; b >= 0; b--) bits.push((val >> b) & 1); }
    push(4, 4);
    push(data.length, ver < 10 ? 8 : 16);
    for (i = 0; i < data.length; i++) push(data[i], 8);
    push(0, Math.min(4, totalData * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    var bytes = [];
    for (i = 0; i < bits.length; i += 8) {
      var byte = 0;
      for (var j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      bytes.push(byte);
    }
    var pad = [0xEC, 0x11], p = 0;
    while (bytes.length < totalData) bytes.push(pad[(p++) & 1]);

    // 블록 나누고 오류정정 붙이고 섞기
    var dBlocks = [], eBlocks = [], off = 0;
    function take(n, count) {
      for (var k = 0; k < count; k++) {
        var blk = bytes.slice(off, off + n); off += n;
        dBlocks.push(blk); eBlocks.push(ecBytes(blk, ecLen));
      }
    }
    take(t[2], t[1]);
    if (t[3]) take(t[4], t[3]);
    var maxLen = Math.max(t[2], t[4]), stream = [];
    for (i = 0; i < maxLen; i++) for (var b2 = 0; b2 < dBlocks.length; b2++) if (i < dBlocks[b2].length) stream.push(dBlocks[b2][i]);
    for (i = 0; i < ecLen; i++) for (b2 = 0; b2 < eBlocks.length; b2++) stream.push(eBlocks[b2][i]);

    var allBits = [];
    for (i = 0; i < stream.length; i++) for (j = 7; j >= 0; j--) allBits.push((stream[i] >> j) & 1);
    for (i = 0; i < REMAIN[ver]; i++) allBits.push(0);

    // 판 만들기
    var size = 17 + 4 * ver, m = [], fixed = [];
    for (var r = 0; r < size; r++) {
      m.push([]); fixed.push([]);
      for (var c = 0; c < size; c++) { m[r].push(0); fixed[r].push(0); }
    }
    function set(row, col, val) { if (row >= 0 && row < size && col >= 0 && col < size) { m[row][col] = val ? 1 : 0; fixed[row][col] = 1; } }

    function finder(r0, c0) {
      for (var r = -1; r <= 7; r++) for (var c = -1; c <= 7; c++) {
        var on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6)) || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        set(r0 + r, c0 + c, on);
      }
    }
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    for (i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }

    var ap = ALIGN[ver], last = ap.length - 1;
    for (var ai = 0; ai <= last; ai++) for (var bi = 0; bi <= last; bi++) {
      if ((ai === 0 && bi === 0) || (ai === 0 && bi === last) || (ai === last && bi === 0)) continue;
      for (r = -2; r <= 2; r++) for (c = -2; c <= 2; c++) {
        set(ap[ai] + r, ap[bi] + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
      }
    }

    set(size - 8, 8, 1); // 항상 검은 칸

    // 형식/버전 정보 자리 미리 잡아두기
    for (i = 0; i <= 8; i++) { fixed[8][i] = 1; fixed[i][8] = 1; }
    for (i = 0; i < 8; i++) { fixed[8][size - 1 - i] = 1; fixed[size - 1 - i][8] = 1; }
    if (ver >= 7) for (i = 0; i < 18; i++) { fixed[i / 3 | 0][size - 11 + i % 3] = 1; fixed[size - 11 + i % 3][i / 3 | 0] = 1; }

    // 데이터 채우기 (오른쪽 아래에서 지그재그)
    var idx = 0, col2 = size - 1, up = true;
    while (col2 > 0) {
      if (col2 === 6) col2--;
      for (var k2 = 0; k2 < size; k2++) {
        var row2 = up ? size - 1 - k2 : k2;
        for (var d = 0; d < 2; d++) {
          var cc = col2 - d;
          if (fixed[row2][cc]) continue;
          m[row2][cc] = idx < allBits.length ? allBits[idx] : 0;
          idx++;
        }
      }
      col2 -= 2; up = !up;
    }

    function maskAt(k, r, c) {
      if (k === 0) return (r + c) % 2 === 0;
      if (k === 1) return r % 2 === 0;
      if (k === 2) return c % 3 === 0;
      if (k === 3) return (r + c) % 3 === 0;
      if (k === 4) return ((r / 2 | 0) + (c / 3 | 0)) % 2 === 0;
      if (k === 5) return (r * c) % 2 + (r * c) % 3 === 0;
      if (k === 6) return ((r * c) % 2 + (r * c) % 3) % 2 === 0;
      return ((r + c) % 2 + (r * c) % 3) % 2 === 0;
    }

    function penalty(g) {
      var n = g.length, score = 0, i, j, run, prev;
      // 규칙1: 같은 색 5칸 이상 연속
      for (i = 0; i < n; i++) {
        run = 1; prev = g[i][0];
        for (j = 1; j < n; j++) { if (g[i][j] === prev) run++; else { if (run >= 5) score += run - 2; run = 1; prev = g[i][j]; } }
        if (run >= 5) score += run - 2;
        run = 1; prev = g[0][i];
        for (j = 1; j < n; j++) { if (g[j][i] === prev) run++; else { if (run >= 5) score += run - 2; run = 1; prev = g[j][i]; } }
        if (run >= 5) score += run - 2;
      }
      // 규칙2: 2x2 같은 색 덩어리
      for (i = 0; i < n - 1; i++) for (j = 0; j < n - 1; j++) {
        var q = g[i][j];
        if (q === g[i][j + 1] && q === g[i + 1][j] && q === g[i + 1][j + 1]) score += 3;
      }
      // 규칙3: 1011101 앞뒤로 흰칸 4개인 무늬
      var P1 = [1,0,1,1,1,0,1,0,0,0,0], P2 = [0,0,0,0,1,0,1,1,1,0,1];
      function match(arr, s, pat) {
        for (var z = 0; z < 11; z++) if (arr[s + z] !== pat[z]) return false;
        return true;
      }
      for (i = 0; i < n; i++) {
        var rowArr = g[i], colArr = [];
        for (j = 0; j < n; j++) colArr.push(g[j][i]);
        for (j = 0; j + 11 <= n; j++) {
          if (match(rowArr, j, P1) || match(rowArr, j, P2)) score += 40;
          if (match(colArr, j, P1) || match(colArr, j, P2)) score += 40;
        }
      }
      // 규칙4: 검은 칸 비율이 50%에서 멀수록 감점
      var dark = 0;
      for (i = 0; i < n; i++) for (j = 0; j < n; j++) dark += g[i][j];
      var pct = dark * 100 / (n * n);
      score += Math.floor(Math.abs(pct - 50) / 5) * 10;
      return score;
    }

    // 마스크 8개 중 가장 점수 낮은 것 고르기
    var best = null, bestScore = Infinity, bestMask = 0;
    for (var mk = 0; mk < 8; mk++) {
      var g2 = [];
      for (r = 0; r < size; r++) {
        g2.push([]);
        for (c = 0; c < size; c++) g2[r].push(fixed[r][c] ? m[r][c] : (m[r][c] ^ (maskAt(mk, r, c) ? 1 : 0)));
      }
      // 형식 정보 써넣기
      var fmt = FORMAT_L[mk];
      function fbit(z) { return (fmt >> z) & 1; }
      for (i = 0; i <= 5; i++) g2[i][8] = fbit(i);
      g2[7][8] = fbit(6); g2[8][8] = fbit(7); g2[8][7] = fbit(8);
      for (i = 9; i < 15; i++) g2[8][14 - i] = fbit(i);
      for (i = 0; i < 8; i++) g2[8][size - 1 - i] = fbit(i);
      for (i = 8; i < 15; i++) g2[size - 15 + i][8] = fbit(i);
      g2[size - 8][8] = 1;
      if (ver >= 7) {
        var vi = VERINFO[ver];
        for (i = 0; i < 18; i++) {
          var vb = (vi >> i) & 1, a1 = size - 11 + i % 3, b1 = i / 3 | 0;
          g2[b1][a1] = vb; g2[a1][b1] = vb;
        }
      }
      var sc = penalty(g2);
      if (sc < bestScore) { bestScore = sc; best = g2; bestMask = mk; }
    }
    return best;
  }

  /** QR 판을 SVG 문자열로 (테두리 여백 4칸 포함) */
  function qrSvg(text) {
    var g = qrMatrix(text);
    if (!g) return "";
    var n = g.length, quiet = 4, side = n + quiet * 2, d = "";
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) {
      if (g[r][c]) d += "M" + (c + quiet) + " " + (r + quiet) + "h1v1h-1z";
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + side + ' ' + side + '"' +
      ' width="160" height="160" shape-rendering="crispEdges" role="img" aria-label="학생 참여 QR코드">' +
      '<rect width="' + side + '" height="' + side + '" fill="#ffffff"/>' +
      '<path d="' + d + '" fill="#000000"/></svg>';
  }

  // ── 공통 상태 ─────────────────────────────────────────────
  var T = { code:null, token:null, url:null, rounds:0, round:1, ended:false, results:{}, joined:0 };
  var S = { code:null, round:0, rounds:0, voted:false, ended:false };
  var pollTimer = null;

  // 기기 구분용 임의 ID (개인정보 아님)
  function deviceId(){
    var k = "likevote_device";
    var v = null;
    try { v = localStorage.getItem(k); } catch(e){}
    if(!v){
      v = "d" + Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4);
      try { localStorage.setItem(k, v); } catch(e){}
    }
    return v;
  }
  function save(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }
  function load(k){ try{ return JSON.parse(localStorage.getItem(k)||"null"); }catch(e){ return null; } }
  function drop(k){ try{ localStorage.removeItem(k); }catch(e){} }

  function $(id){ return document.getElementById(id); }
  function show(id){
    var all = document.querySelectorAll(".screen");
    for(var i=0;i<all.length;i++) all[i].className = "screen";
    $(id).className = "screen on";
    window.scrollTo(0,0);
  }
  function err(id, msg){
    var el = $(id);
    if(!msg){ el.className="err"; el.textContent=""; return; }
    el.className="err on"; el.textContent = msg;
  }

  function api(path, body){
    var opt = { method: body ? "POST" : "GET", headers:{"Content-Type":"application/json"} };
    if(body) opt.body = JSON.stringify(body);
    return fetch(path, opt).then(function(r){
      return r.json().catch(function(){ return {error:"서버 응답을 읽지 못했어요."}; })
        .then(function(j){
          if(!r.ok || j.error) throw new Error(j.error || ("서버 오류 (" + r.status + ")"));
          return j;
        });
    });
  }

  function stopPoll(){ if(pollTimer){ clearInterval(pollTimer); pollTimer = null; } }

  // ── 화면 이동 ─────────────────────────────────────────────
  function go(where){
    stopPoll();
    err("setup-err",""); err("run-err",""); err("join-err",""); err("like-err","");
    if(where==="pick"){
      var t = load("likevote_teacher");
      if(t && t.code){ $("resume-card").style.display="block"; $("resume-code").textContent = t.code; }
      else $("resume-card").style.display="none";
      show("s-pick");
    }
    else if(where==="teacher") show("s-setup");
    else if(where==="student") { show("s-join"); setTimeout(function(){ $("joincode").focus(); },100); }
  }

  // ── 교사: 라운드 개수 ─────────────────────────────────────
  function bump(d){
    var el = $("rounds");
    var v = parseInt(el.value,10); if(isNaN(v)) v = 5;
    v += d; if(v<1) v=1; if(v>20) v=20;
    el.value = v;
  }

  function createRoom(){
    var v = parseInt($("rounds").value,10);
    if(isNaN(v) || v<1 || v>20){ err("setup-err","라운드 개수는 1에서 20 사이로 넣어 주세요."); return; }
    err("setup-err","");
    $("btn-create").disabled = true; $("btn-create").textContent = "만드는 중…";
    api("/api/vote/create", { rounds: v }).then(function(j){
      T.code = j.code; T.token = j.token; T.rounds = j.rounds;
      T.round = 1; T.ended = false; T.results = {}; T.joined = 0;
      save("likevote_teacher", { code:T.code, token:T.token });
      openRun();
    }).catch(function(e){
      err("setup-err", e.message);
    }).then(function(){
      $("btn-create").disabled = false; $("btn-create").textContent = "수업 시작하기";
    });
  }

  function resumeTeacher(){
    var t = load("likevote_teacher");
    if(!t || !t.code) { go("pick"); return; }
    T.code = t.code; T.token = t.token;
    openRun();
  }

  function openRun(){
    show("s-run");
    $("t-code").textContent = T.code;
    T.url = location.origin + location.pathname.replace(/\\/teacher$/,"") + "?code=" + T.code;
    $("t-url").textContent = T.url;
    $("t-qr").innerHTML = qrSvg(T.url);
    refreshTeacher();
    stopPoll();
    pollTimer = setInterval(function(){
      if(document.hidden) return;
      refreshTeacher();
    }, 5000);
  }

  function leaveRoom(){
    stopPoll(); drop("likevote_teacher"); T.code=null; T.token=null; go("pick");
  }

  function refreshTeacher(){
    if(!T.code) return;
    api("/api/vote/teacher?code=" + encodeURIComponent(T.code) + "&token=" + encodeURIComponent(T.token||""))
      .then(function(j){
        T.rounds = j.rounds; T.round = j.round; T.ended = j.ended;
        T.results = j.results || {}; T.joined = j.joined;
        err("run-err","");
        paintTeacher();
      })
      .catch(function(e){
        err("run-err", e.message + " — 수업이 만료되었으면 새 수업을 만들어 주세요.");
      });
  }

  function paintTeacher(){
    $("t-rounds").textContent = T.rounds;
    $("t-round").textContent = Math.min(T.round, T.rounds);
    $("t-joined").textContent = T.joined;

    var key = String(T.round);
    var revealedNow = Object.prototype.hasOwnProperty.call(T.results, key) && T.results[key] !== null;

    $("t-state").textContent = T.ended ? "수업 끝" : (revealedNow ? "결과 공개됨" : "받는 중");

    if(T.ended){
      $("t-hint").textContent = "수업이 끝났습니다. 아래 표에서 라운드별 결과를 볼 수 있어요.";
      $("t-hint").style.display = "block";
      $("t-count").style.display = "none";
      $("btn-reveal").style.display = "none";
      $("btn-next").style.display = "none";
      $("btn-finish").textContent = "새 수업 만들기";
      $("btn-finish").onclick = leaveRoom;
      $("btn-leave").style.display = "none";
    } else {
      $("btn-reveal").style.display = "block";
      $("btn-next").style.display = "block";
      $("btn-finish").textContent = "수업 끝내기";
      $("btn-finish").onclick = finishClass;
      $("btn-leave").style.display = "block";
      $("btn-next").textContent = (T.round >= T.rounds) ? "마지막 라운드입니다" : "다음 라운드로";
      $("btn-next").disabled = (T.round >= T.rounds);
      if(revealedNow){
        $("t-hint").style.display = "none";
        $("t-count").style.display = "block";
        $("t-countnum").textContent = T.results[key];
        $("btn-reveal").textContent = "지금 개수로 다시 세기";
      } else {
        $("t-hint").style.display = "block";
        $("t-hint").textContent = "결과 보기를 누르면 이번 라운드 좋아요 개수가 나옵니다.";
        $("t-count").style.display = "none";
        $("btn-reveal").textContent = "이번 라운드 결과 보기";
      }
    }
    paintTable();
  }

  function paintTable(){
    var tb = $("t-table"); tb.innerHTML = "";
    var sum = 0, known = true;
    for(var i=1;i<=T.rounds;i++){
      var tr = document.createElement("tr");
      var td1 = document.createElement("td");
      td1.textContent = i + "라운드" + (i===T.round && !T.ended ? " (지금)" : "");
      var td2 = document.createElement("td");
      var val = T.results[String(i)];
      if(val === null || val === undefined){
        known = false;
        var b = document.createElement("button");
        b.className = "peek"; b.textContent = "결과 보기";
        b.onclick = (function(n){ return function(){ reveal(n); }; })(i);
        td2.appendChild(b);
      } else {
        td2.className = "cnt";
        td2.textContent = "❤️ " + val;
        sum += val;
      }
      tr.appendChild(td1); tr.appendChild(td2); tb.appendChild(tr);
    }
    var tf = $("t-foot");
    tf.innerHTML = "";
    var ftr = document.createElement("tr");
    var f1 = document.createElement("td"); f1.style.fontWeight="800"; f1.textContent = "합계";
    var f2 = document.createElement("td"); f2.className="cnt";
    f2.textContent = known ? ("❤️ " + sum) : ("❤️ " + sum + " (공개된 것만)");
    ftr.appendChild(f1); ftr.appendChild(f2); tf.appendChild(ftr);
  }

  function reveal(roundNo){
    err("run-err","");
    api("/api/vote/reveal", { code:T.code, token:T.token, round: roundNo || T.round })
      .then(function(j){
        T.results = j.results || T.results;
        if (typeof j.joined === "number") T.joined = j.joined;
        paintTeacher();
        var box = $("t-count");
        if(box.style.display !== "none"){ box.classList.remove("pop"); void box.offsetWidth; box.classList.add("pop"); }
      })
      .catch(function(e){ err("run-err", e.message); });
  }

  function nextRound(){
    err("run-err","");
    api("/api/vote/next", { code:T.code, token:T.token })
      .then(function(j){ T.round = j.round; refreshTeacher(); })
      .catch(function(e){ err("run-err", e.message); });
  }

  function finishClass(){
    err("run-err","");
    api("/api/vote/finish", { code:T.code, token:T.token })
      .then(function(){ refreshTeacher(); })
      .catch(function(e){ err("run-err", e.message); });
  }

  function bigQr(){
    if(!T.url) return;
    $("ov-code").textContent = T.code;
    $("ov-qr").innerHTML = qrSvg(T.url);
    $("ov-url").textContent = T.url;
    $("qr-overlay").className = "overlay on";
  }
  function closeQr(){ $("qr-overlay").className = "overlay"; }

  // ── 학생 ─────────────────────────────────────────────────
  function joinRoom(){
    var c = ($("joincode").value || "").replace(/\\D/g,"");
    if(c.length !== 4){ err("join-err","숫자 4자리를 넣어 주세요."); return; }
    err("join-err","");
    $("btn-join").disabled = true;
    S.code = c;
    pollStudent(true).then(function(ok){
      if(ok){ save("likevote_student", { code:c }); openLike(); }
      $("btn-join").disabled = false;
    });
  }

  function openLike(){
    show("s-like");
    $("s-code").textContent = S.code;
    paintStudent();
    stopPoll();
    pollTimer = setInterval(function(){
      if(document.hidden) return;
      if(S.ended){ stopPoll(); return; }
      pollStudent(false);
    }, 3000);
  }

  function leaveStudent(){
    stopPoll(); drop("likevote_student"); S.code = null;
    if(history.replaceState) history.replaceState(null,"",location.pathname);
    go("pick");
  }

  function pollStudent(first){
    return api("/api/vote/student?code=" + encodeURIComponent(S.code) + "&device=" + encodeURIComponent(deviceId()))
      .then(function(j){
        var changed = (S.round !== j.round) || (S.voted !== j.voted) || (S.ended !== j.ended);
        S.round = j.round; S.rounds = j.rounds; S.voted = j.voted; S.ended = j.ended;
        err("like-err","");
        if(changed || first) paintStudent();
        return true;
      })
      .catch(function(e){
        if(first) err("join-err", e.message);
        else err("like-err", e.message);
        return false;
      });
  }

  function paintStudent(){
    $("s-round").textContent = Math.min(S.round, S.rounds);
    $("s-rounds").textContent = S.rounds;
    var b = $("btn-like");
    if(S.ended){
      b.disabled = true; b.className = "heartbtn"; b.textContent = "🎉";
      $("s-msg").textContent = "오늘 활동이 끝났어요!";
      $("s-sub").textContent = "참여해 줘서 고마워요.";
    } else if(S.voted){
      b.disabled = true; b.className = "heartbtn done"; b.textContent = "✔";
      $("s-msg").textContent = "좋아요를 눌렀어요!";
      $("s-sub").textContent = "다음 라운드를 기다려 주세요.";
    } else {
      b.disabled = false; b.className = "heartbtn"; b.textContent = "❤️";
      $("s-msg").textContent = "좋아요를 한 번 누를 수 있어요!";
      $("s-sub").textContent = "라운드마다 딱 한 번이에요.";
    }
  }

  function sendLike(){
    var b = $("btn-like");
    b.disabled = true;
    api("/api/vote/like", { code:S.code, device:deviceId() })
      .then(function(j){
        S.round = j.round; S.rounds = j.rounds; S.voted = true; S.ended = j.ended;
        paintStudent();
        var el = $("btn-like");
        el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop");
      })
      .catch(function(e){ err("like-err", e.message); pollStudent(false); });
  }

  // ── 시작 ─────────────────────────────────────────────────
  function boot(){
    var qs = new URLSearchParams(location.search);
    var codeParam = (qs.get("code")||"").replace(/\\D/g,"");
    var teacherMode = /\\/teacher\\/?$/.test(location.pathname) || qs.get("mode")==="teacher";

    if(codeParam.length === 4){
      S.code = codeParam;
      show("s-like");
      $("s-code").textContent = S.code;
      pollStudent(true).then(function(ok){
        if(ok){ save("likevote_student", {code:S.code}); openLike(); }
        else { go("student"); $("joincode").value = codeParam; }
      });
      return;
    }
    if(teacherMode){
      var t = load("likevote_teacher");
      if(t && t.code){ T.code=t.code; T.token=t.token; openRun(); }
      else show("s-setup");
      return;
    }
    var st = load("likevote_student");
    if(st && st.code){
      S.code = st.code;
      show("s-like");
      $("s-code").textContent = S.code;
      pollStudent(true).then(function(ok){
        if(ok) openLike(); else { drop("likevote_student"); go("pick"); }
      });
      return;
    }
    go("pick");
  }

  $("joincode").addEventListener("keydown", function(e){ if(e.key==="Enter") joinRoom(); });
  document.addEventListener("visibilitychange", function(){
    if(document.hidden) return;
    if(T.code && $("s-run").className.indexOf("on")>=0) refreshTeacher();
    if(S.code && $("s-like").className.indexOf("on")>=0) pollStudent(false);
  });

  // 전역 노출 (onclick 용)
  window.go = go; window.bump = bump; window.createRoom = createRoom; window.resumeTeacher = resumeTeacher;
  window.reveal = reveal; window.nextRound = nextRound; window.finishClass = finishClass;
  window.leaveRoom = leaveRoom; window.joinRoom = joinRoom; window.sendLike = sendLike;
  window.leaveStudent = leaveStudent; window.bigQr = bigQr; window.closeQr = closeQr;
  document.addEventListener("keydown", function(e){ if(e.key === "Escape") closeQr(); });

  boot();
})();
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
