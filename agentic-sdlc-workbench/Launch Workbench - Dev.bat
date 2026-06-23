@echo off
title Agentic SDLC Workbench — DEV Launcher
color 0B

set "REPO_DIR=C:\Users\christopmartin\Agentic Workbench"
set "PROJECT_DIR=%REPO_DIR%\agentic-sdlc-workbench\backend-node"

echo.
echo  ==========================================
echo   Agentic SDLC Workbench  [DEV BRANCH]
echo  ==========================================
echo.

:: Check Node is available
where node >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Node.js not found in PATH.
    pause
    exit /b 1
)

:: Switch to Dev branch
cd /d "%REPO_DIR%"
for /f "tokens=*" %%b in ('git branch --show-current 2^>nul') do set "CURRENT_BRANCH=%%b"
if /i not "%CURRENT_BRANCH%"=="Dev" (
    echo  Switching from %CURRENT_BRANCH% to Dev...
    git checkout Dev
    if errorlevel 1 (
        echo  ERROR: Could not switch to Dev branch. Commit or stash changes first.
        pause
        exit /b 1
    )
) else (
    echo  Already on Dev branch.
)
echo.

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

:: Start server
echo  Starting DEV server...
start "ASDLC Server [DEV] — close this window to stop" cmd /k "cd /d "%PROJECT_DIR%" && node server.js"

timeout /t 3 /nobreak >nul

echo  Opening browser at http://localhost:8000
start "" "http://localhost:8000"

echo.
echo  DEV server is running. Close the "ASDLC Server [DEV]" window to stop it.
echo.
timeout /t 4 /nobreak >nul
exit
