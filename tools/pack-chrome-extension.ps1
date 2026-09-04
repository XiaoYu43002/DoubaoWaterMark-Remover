# Pack Chrome Web Store ZIP (manifest.json at zip root).
# Usage: powershell -ExecutionPolicy Bypass -File tools/pack-chrome-extension.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$src = Join-Path $root "extension"
$manifestPath = Join-Path $src "manifest.json"
if (-not (Test-Path $manifestPath)) {
  $src = Join-Path $root "doubaoparser"
  $manifestPath = Join-Path $src "manifest.json"
}
if (-not (Test-Path $manifestPath)) {
  throw "Extension folder not found (extension / doubaoparser)."
}

$manifestText = [System.IO.File]::ReadAllText($manifestPath)
if ($manifestText -notmatch '"version"\s*:\s*"([^"]+)"') {
  throw "Cannot parse version from manifest.json"
}
$version = $Matches[1]
$name = "doubao-original-media-helper-$version"
$outDir = Join-Path $root "release"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$zipPath = Join-Path $outDir ($name + ".zip")
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

$staging = Join-Path $outDir "_chrome_pack_staging"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Force -Path $staging | Out-Null

$include = @(
  "manifest.json",
  "background.js",
  "content.js",
  "injected.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "db.js",
  "video.js",
  "opaque-material.js",
  "contact-icon.png",
  "icons",
  "opaque"
)

foreach ($item in $include) {
  $from = Join-Path $src $item
  if (-not (Test-Path $from)) { throw ("Missing: " + $item) }
  $to = Join-Path $staging $item
  if ((Get-Item $from).PSIsContainer) {
    Copy-Item $from $to -Recurse -Force
  } else {
    Copy-Item $from $to -Force
  }
}

Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zipPath -CompressionLevel Optimal
Remove-Item $staging -Recurse -Force

$sizeKb = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
Write-Host ("OK: " + $zipPath + " (" + $sizeKb + " KB)")
Write-Host "Upload this ZIP to Chrome Web Store (manifest.json at zip root)."
