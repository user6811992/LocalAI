@echo off
REM Local AI - manual start
setlocal
set "BASE=%~dp0"
set "PATH=C:\jadx\bin;C:\Ghidra\ghidra_12.1.4_PUBLIC;C:\Program Files\Eclipse Adoptium\jdk-21.0.13.9-hotspot\bin;C:\Program Files\nodejs;%APPDATA%\npm;%PATH%"
if not defined GHIDRA_INSTALL_DIR set "GHIDRA_INSTALL_DIR=C:\Ghidra\ghidra_12.1.4_PUBLIC"
if not defined JAVA_HOME set "JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-21.0.13.9-hotspot"
if not defined REA_JADX_MCP_JAR set "REA_JADX_MCP_JAR=C:\Tools\jadx-mcp\jadx-headless-mcp-0.7.1-all.jar"

REM Ensure Ollama running
tasklist /FI "IMAGENAME eq ollama.exe" 2>nul | find /I "ollama.exe" >nul
if errorlevel 1 (
  set "OLLAMA_HOST=0.0.0.0"
  set "OLLAMA_ORIGINS=*"
  start /B "" "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" serve
  timeout /t 4 /nobreak >nul
)

REM Start web UI
cd /d "%BASE%"
start /B node server.js
timeout /t 3 /nobreak >nul
echo Local AI web UI: http://127.0.0.1:8080
pause