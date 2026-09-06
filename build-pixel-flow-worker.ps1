# ─────────────────────────────────────────────────────────────
#  픽셀 플로우 — Cloudflare Worker builder
#  pixel-flow/index.html + pixel-flow/pixel-flow-worker.template.js
#    → pixel-flow/pixel-flow-worker.js
#  Run:  powershell -ExecutionPolicy Bypass -File build-pixel-flow-worker.ps1
# ─────────────────────────────────────────────────────────────
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

$app = Escape-ForTemplateLiteral (Read-Utf8 (Join-Path $root "pixel-flow\index.html"))
$tpl = Read-Utf8 (Join-Path $root "pixel-flow\pixel-flow-worker.template.js")

$out = $tpl.Replace('__APP_HTML__', ('`' + $app + '`'))

$dest = Join-Path $root "pixel-flow\pixel-flow-worker.js"
[IO.File]::WriteAllText($dest, $out, (New-Object Text.UTF8Encoding $false))

Write-Host "OK: $dest ($([Math]::Round((Get-Item $dest).Length/1KB)) KB)"

# ── 폴더째 올리는 배포 폴더도 같이 갱신 ──
$wDir = Join-Path $root "deploy\pixel-worker"
$pDir = Join-Path $root "deploy\pixel-pages"
Copy-Item $dest (Join-Path $wDir "pixel-flow-worker.js") -Force
Copy-Item (Join-Path $root "pixel-flow\index.html") (Join-Path $pDir "index.html") -Force
Copy-Item (Join-Path $root "pixel-flow\index.html") (Join-Path $pDir "404.html") -Force
Write-Host "OK: deploy\pixel-worker, deploy\pixel-pages 갱신"

# ── 업로드용 zip 다시 만들기 ──
$zw = Join-Path $root "deploy\pixel-worker.zip"
$zp = Join-Path $root "deploy\pixel-pages.zip"
if (Test-Path $zw) { Remove-Item $zw }
if (Test-Path $zp) { Remove-Item $zp }
Compress-Archive -Path $wDir -DestinationPath $zw
Compress-Archive -Path $pDir -DestinationPath $zp
Write-Host "OK: deploy\pixel-worker.zip, deploy\pixel-pages.zip"
Write-Host "-> 폴더로 올리려면 deploy 폴더의 읽어보세요.txt 를 보세요."
