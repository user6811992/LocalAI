@echo off
REM AegisAI Diagnostic Script - runs checks and shows results
REM Run this if AegisAI won't start

echo ============================================
echo  AegisAI Diagnostic
echo ============================================
echo.

echo [1/6] Checking Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo   FAIL: Node.js not found on PATH
    echo   Fix: Install from https://nodejs.org/
    goto :done
)
node --version
echo   OK
echo.

echo [2/6] Checking npm...
where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo   FAIL: npm not found on PATH
    echo   Fix: Reinstall Node.js from https://nodejs.org/
    goto :done
)
npm --version
echo   OK
echo.

echo [3/6] Checking node_modules...
if exist "%~dp0node_modules\@modelcontextprotocol\sdk" (
    echo   OK: MCP SDK found
) else (
    echo   FAIL: node_modules missing or incomplete
    echo   Fix: Run "npm install" in: %~dp0
)
echo.

echo [4/6] Checking port 8080...
netstat -an | findstr ":8080" | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    echo   WARNING: Port 8080 is already in use
    echo   Fix: Close other apps using port 8080, or set PORT env var
) else (
    echo   OK: Port 8080 is free
)
echo.

echo [5/6] Checking backend...
if exist "%~dp0backend.txt" (
    type "%~dp0backend.txt"
) else (
    echo   No backend.txt found (will default to ollama)
)
echo.

echo [6/6] Checking server.log...
if exist "%~dp0server.log" (
    echo   Last 10 lines of server.log:
    echo   ---
    powershell -Command "Get-Content '%~dp0server.log' | Select-Object -Last 10"
    echo   ---
) else (
    echo   No server.log found (server has never started successfully)
)
echo.

:done
echo ============================================
echo  Press any key to exit...
pause >nul