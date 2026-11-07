# Local AI Desktop GUI launcher + system tray
$ErrorActionPreference = 'SilentlyContinue'
$base = $PSScriptRoot
if (-not $base) { $base = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $base) { $base = "C:\Users\$env:USERNAME\Documents\LocalAI" }

# Discover Ollama
$ollamaDir = "C:\Users\$env:USERNAME\AppData\Local\Programs\Ollama"
if (-not (Test-Path "$ollamaDir\ollama.exe")) {
  $ollamaCmd = Get-Command ollama -ErrorAction SilentlyContinue
  if ($ollamaCmd) { $ollamaDir = Split-Path $ollamaCmd.Source }
}

# Ensure Ollama running
if (-not (Get-Process ollama -ErrorAction SilentlyContinue)) {
  $env:OLLAMA_HOST = '0.0.0.0'
  $env:OLLAMA_ORIGINS = '*'
  if ($env:GHIDRA_INSTALL_DIR) { } else { $env:GHIDRA_INSTALL_DIR = 'C:\Ghidra\ghidra_12.1.4_PUBLIC' }
  if ($env:JAVA_HOME) { } else { $env:JAVA_HOME = 'C:\Program Files\Eclipse Adoptium\jdk-21.0.13.9-hotspot' }
  Start-Process -FilePath "$ollamaDir\ollama.exe" -ArgumentList "serve" -WindowStyle Hidden
  Start-Sleep -Seconds 4
}

# Ensure web UI running
$portOpen = $false
try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8080/' -UseBasicParsing -TimeoutSec 2; $portOpen = $true } catch {}
if (-not $portOpen) {
  $env:Path = "C:\jadx\bin;C:\Ghidra\ghidra_12.1.4_PUBLIC;C:\Program Files\Eclipse Adoptium\jdk-21.0.13.9-hotspot\bin;C:\Program Files\nodejs;C:\Users\$env:USERNAME\AppData\Roaming\npm;" + $env:Path
  if (-not $env:GHIDRA_INSTALL_DIR) { $env:GHIDRA_INSTALL_DIR = 'C:\Ghidra\ghidra_12.1.4_PUBLIC' }
  if (-not $env:JAVA_HOME) { $env:JAVA_HOME = 'C:\Program Files\Eclipse Adoptium\jdk-21.0.13.9-hotspot' }
  Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $base -WindowStyle Hidden
  Start-Sleep -Seconds 3
}

# Launch app window in Edge
Start-Process -FilePath "msedge" -ArgumentList "--app=http://127.0.0.1:8080","--window-size=1200,800"