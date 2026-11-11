# Build the Inno Setup installer for AegisAI.
# Prerequisites: Inno Setup 6 (iscc.exe on PATH), Node.js, npm.
# Usage: .\installer\build.ps1 [-BundleNode] [-BundleOllama]
param([switch]$BundleNode, [switch]$BundleOllama)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

# 1. Read version from package.json
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
$ver = $pkg.version
Write-Host "Building AegisAI installer v$ver"

# 2. Optionally bundle Node.js runtime
if ($BundleNode) {
  $nodeDir = Join-Path $root 'installer\node-runtime'
  if (-not (Test-Path $nodeDir)) {
    Write-Host 'Downloading Node.js portable...'
    $nodeVer = 'v20.18.0'
    $zip = Join-Path $env:TEMP "node-$nodeVer-win-x64.zip"
    $url = "https://nodejs.org/dist/$nodeVer/node-$nodeVer-win-x64.zip"
    Invoke-WebRequest -Uri $url -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $nodeDir -Force
    # Flatten: move contents up one level
    $inner = Join-Path $nodeDir "node-$nodeVer-win-x64"
    if (Test-Path $inner) {
      Get-ChildItem $inner | Move-Item -Destination $nodeDir -Force
      Remove-Item $inner -Recurse -Force
    }
    Remove-Item $zip -Force
    Write-Host 'Node.js bundled.'
  }
}

# 3. Optionally bundle Ollama
if ($BundleOllama) {
  $ollamaDir = Join-Path $root 'installer\ollama-runtime'
  New-Item -ItemType Directory -Force -Path $ollamaDir | Out-Null
  $ollamaExe = Join-Path $ollamaDir 'ollama.exe'
  if (-not (Test-Path $ollamaExe)) {
    $cand = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
    if (Test-Path $cand) { Copy-Item $cand $ollamaExe }
    else { Write-Warning 'Ollama not found locally; skipping bundle.' }
  }
}

# 4. Build with Inno Setup
$iscc = Get-Command iscc.exe -ErrorAction SilentlyContinue
if (-not $iscc) {
  Write-Error 'Inno Setup (iscc.exe) not found on PATH. Install from https://jrsoftware.org/isinfo.php'
  exit 1
}
& iscc.exe "installer\aegisai.iss"
if ($LASTEXITCODE -ne 0) { throw "Inno Setup build failed (exit $LASTEXITCODE)" }

Write-Host "Build complete: installer\output\AegisAI-Setup-$ver.exe"
Pop-Location