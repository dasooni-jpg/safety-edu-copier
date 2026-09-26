# ─────────────────────────────────────────────────────────────
#  하늘편대 100 — 온라인 Worker builder
#  skysquad-app/index.html + skysquad-app/sim.js + skysquad-worker.template.js
#      → skysquad-worker.js
#  Run:     powershell -ExecutionPolicy Bypass -File build-skysquad-worker.ps1
#  Deploy:  cd skysquad-online ; npx wrangler deploy
# ─────────────────────────────────────────────────────────────
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

function Read-Utf8($path) { [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) }

function Escape-ForTemplateLiteral($s) {
  $s = $s.Replace('\', '\\')
  $s = $s.Replace('`', '\`')
  $s = $s.Replace('${', '\${')
  return $s
}

$appPath = Join-Path $root "skysquad-app\index.html"
$simPath = Join-Path $root "skysquad-app\sim.js"
$tplPath = Join-Path $root "skysquad-worker.template.js"
foreach ($p in @($appPath, $simPath, $tplPath)) {
  if (-not (Test-Path $p)) { throw "파일이 없습니다: $p" }
}

$appRaw = Read-Utf8 $appPath
$simRaw = Read-Utf8 $simPath
$tpl    = Read-Utf8 $tplPath

# sim.js 는 두 가지로 들어갑니다.
#   1) __SIM_JS__   … 워커 안에서 실제로 돌릴 코드 (그대로)
#   2) __SIM_TEXT__ … 브라우저에 /sim.js 로 내려줄 문자열 (템플릿 리터럴로 감쌈)
$out = $tpl.Replace('__SIM_JS__', $simRaw)
$out = $out.Replace('__SIM_TEXT__', ('`' + (Escape-ForTemplateLiteral $simRaw) + '`'))
$out = $out.Replace('__APP_HTML__', ('`' + (Escape-ForTemplateLiteral $appRaw) + '`'))

foreach ($ph in @('__SIM_JS__', '__SIM_TEXT__', '__APP_HTML__')) {
  if ($out.Contains($ph)) { throw "자리표시자가 남아 있습니다: $ph" }
}

$dest = Join-Path $root "skysquad-worker.js"
[IO.File]::WriteAllText($dest, $out, (New-Object Text.UTF8Encoding $false))

$kb = [Math]::Round((Get-Item $dest).Length / 1KB)
Write-Host "OK: $dest ($($kb) KB)" -ForegroundColor Green
Write-Host ""
Write-Host "이 파일(skysquad-worker.js)을 배포하세요. template 파일이 아닙니다." -ForegroundColor Yellow
Write-Host "Durable Objects 는 대시보드 붙여넣기로 배포되지 않습니다." -ForegroundColor Yellow
Write-Host ""
Write-Host "  cd skysquad-online"
Write-Host "  npx wrangler deploy"
