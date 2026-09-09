/*
 * safety-edu-worker.js 빌드 스크립트 (Node 버전, 윈도우/맥/리눅스 공통)
 *   safety-edu-app/app.html + vote-app/app.html + safety-edu-worker.template.js
 *   → safety-edu-worker.js
 *
 * 실행:  node build-safety-edu-worker.mjs
 * (윈도우에서 PowerShell만 쓴다면 build-safety-edu-worker.ps1 을 실행해도 결과가 같음)
 */
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

// JS 템플릿 리터럴(백틱 문자열) 안에 안전하게 넣기 위한 이스케이프
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

const read = (p) => readFileSync(join(root, p), "utf8");

let out = read("safety-edu-worker.template.js");
const parts = {
  __APP_HTML__: "safety-edu-app/app.html",
  __VOTE_HTML__: "vote-app/app.html",
};

for (const [token, file] of Object.entries(parts)) {
  if (!out.includes(token)) throw new Error(`템플릿에 ${token} 자리가 없습니다.`);
  out = out.replace(token, "`" + esc(read(file)) + "`");
}

const dest = join(root, "safety-edu-worker.js");
writeFileSync(dest, out, "utf8");
console.log(`OK: ${dest} (${Math.round(statSync(dest).size / 1024)} KB)`);
