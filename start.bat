@echo off
REM AegisAI - Start server in visible window for debugging
REM Use this if launcher.vbs fails to start the server

cd /d "%~dp0"

echo Starting AegisAI server...
echo Press Ctrl+C to stop.
echo.

REM Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    if exist "runtime\node\node.exe" (
        set "NODE_EXE=runtime\node\node.exe"
    ) else (
        echo ERROR: Node.js not found. Install from https://nodejs.org/
        pause
        exit /b 1
    )
) else (
    set "NODE_EXE=node"
)

REM Check node_modules
if not exist "node_modules\@modelcontextprotocol\sdk" (
    echo Installing dependencies...
    %NODE_EXE% -e "require('child_process').execSync('npm install', {stdio:'inherit'})" 2>nul
    if not exist "node_modules\@modelcontextprotocol\sdk" (
        echo ERROR: npm install failed. Run "npm install" manually.
        pause
        exit /b 1
    )
)

REM Set backend from backend.txt
if exist "backend.txt" (
    for /f "tokens=1,2 delims==" %%a in (backend.txt) do (
        if /i "%%a"=="BACKEND_TYPE" set "BACKEND_TYPE=%%b"
        if /i "%%a"=="BACKEND_URL" set "BACKEND_URL=%%b"
    )
)

if "%BACKEND_TYPE%"=="" set "BACKEND_TYPE=ollama"
if "%BACKEND_URL%"=="" set "BACKEND_URL=http://127.0.0.1:11434"

set "BACKEND_TYPE=%BACKEND_TYPE%"
set "BACKEND_URL=%BACKEND_URL%"
set "OLLAMA_URL=%BACKEND_URL%"

echo Backend: %BACKEND_TYPE% at %BACKEND_URL%
echo.

%NODE_EXE% server.js
pause