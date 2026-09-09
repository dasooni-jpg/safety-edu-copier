# ───────────────────────────────────────────────────────────
#  Cloudflare Worker builder
#  safety-edu-app/app.html + vote-app/app.html + safety-edu-worker.template.js
#  → safety-edu-worker.js
#  Run:  powershell -ExecutionPolicy Bypass -File build-safety-edu-worker.ps1
# ───────────────────────────────────────────────────────────
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

function Read-Utf8($path) { [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) }

# escape for JS template literal
function Escape-ForTemplateLiteral($s) {
  $s = $s.Replace('\', '\\')
  $s = $s.Replace('`', '\`')
  $s = $s.Replace('${', '\${')
  return $s
}

$app  = Escape-ForTemplateLiteral (Read-Utf8 (Join-Path $root "safety-edu-app\app.html"))
$vote = Escape-ForTemplateLiteral (Read-Utf8 (Join-Path $root "vote-app\app.html"))
$tpl  = Read-Utf8 (Join-Path $root "safety-edu-worker.template.js")

$out = $tpl.Replace('__APP_HTML__',  ('`' + $app  + '`'))
$out = $out.Replace('__VOTE_HTML__', ('`' + $vote + '`'))

$dest = Join-Path $root "safety-edu-worker.js"
[IO.File]::WriteAllText($dest, $out, (New-Object Text.UTF8Encoding $false))

Write-Host "OK: $dest ($([Math]::Round((Get-Item $dest).Length/1KB)) KB)"
Write-Host "-> 기본: git commit 후 main 브랜치에 push 하면 Cloudflare가 자동 배포합니다."
Write-Host "-> 안전교육 문구: https://<워커주소>/"
Write-Host "-> 라운드 좋아요(교사): https://<워커주소>/vote/teacher"
