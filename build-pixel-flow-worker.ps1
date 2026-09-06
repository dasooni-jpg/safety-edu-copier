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
Write-Host "-> Cloudflare 워커 편집기에 이 파일 전체를 붙여넣고 Deploy 하세요."
