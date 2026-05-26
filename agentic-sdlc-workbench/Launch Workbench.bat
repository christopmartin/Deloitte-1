@echo off
title Agentic SDLC Workbench — Launcher
color 0A

set "PROJECT_DIR=C:\Users\christopmartin\Agentic Workbench\agentic-sdlc-workbench\backend-node"

echo.
echo  ==========================================
echo   Agentic SDLC Workbench
echo  ==========================================
echo.

:: Check Node is available
where node >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Node.js not found in PATH.
    echo  Install Node.js from https://nodejs.org
    pause
    exit /b 1
)

:: Install dependencies if missing
if not exist "%PROJECT_DIR%\node_modules\express" (
    echo  Installing dependencies...
    cd /d "%PROJECT_DIR%"
    call npm install
    echo.
)

:: Kill any existing server on port 8000
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr /R ":8000 "') do (
    taskkill /F /PID %%a >nul 2>&1
)

:: Start server in a separate titled window (close that window to stop the server)
echo  Starting server...
start "ASDLC Server — close this window to stop" cmd /k "cd /d "%PROJECT_DIR%" && node server.js"

:: Wait for server to be ready
timeout /t 3 /nobreak >nul

:: Open browser
echo  Opening browser at http://localhost:8000
start "" "http://localhost:8000"

echo.
echo  Server is running. Close the "ASDLC Server" window to stop it.
echo.
timeout /t 4 /nobreak >nul
exit
