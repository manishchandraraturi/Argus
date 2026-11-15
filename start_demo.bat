@echo off
setlocal enabledelayedexpansion

title ARGUS // SEE WHAT MOVES - DEMO LAUNCHER

echo ==================================================================
echo ARGUS // SPHEREx All-Sky Survey Demo Launcher
echo ==================================================================

:: 1. Check Python installation
where python >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Python is not installed or not in system PATH.
    echo Please install Python 3.10+ and re-run.
    pause
    exit /b 1
)

:: 2. Check Node.js installation
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed or not in system PATH.
    echo Please install Node.js 18+ and re-run.
    pause
    exit /b 1
)

:: 3. Check npm installation
where npm >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] npm is not installed or not in system PATH.
    pause
    exit /b 1
)

:: 4. Check / Create frontend/.env
set "FRONTEND_ENV=%~dp0frontend\.env"
if not exist "%FRONTEND_ENV%" (
    echo [INFO] Creating frontend\.env with default configuration...
    (
        echo VITE_API_BASE=http://localhost:8000
        echo VITE_BACKEND_URL=http://localhost:8000
        echo VITE_ALLOW_LIVE_FETCH=false
    ) > "%FRONTEND_ENV%"
    echo [INFO] Created %FRONTEND_ENV%
)

:: 5. Set Environment Variables for Backend
set "MOCK=0"
set "DEMO_DIR=demo_cache_final"
set "ENABLE_LIVE=0"
set "FORBID_IRSA=1"

echo [INFO] Launching ARGUS Backend on port 8000...
set "BACKEND_DIR=%~dp0backend"
if exist "%BACKEND_DIR%\.venv\Scripts\uvicorn.exe" (
    set "UVICORN_CMD=%BACKEND_DIR%\.venv\Scripts\uvicorn.exe"
) else (
    set "UVICORN_CMD=python -m uvicorn"
)

start "ARGUS Backend" cmd /c "cd /d "%BACKEND_DIR%" && set "MOCK=0" && set "DEMO_DIR=demo_cache_final" && set "ENABLE_LIVE=0" && set "FORBID_IRSA=1" && !UVICORN_CMD! server:app --port 8000"

:: 6. Schedule browser open after 3 seconds
start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:5173"

:: 7. Launch Vite Frontend in foreground
echo [INFO] Launching Vite Frontend on port 5173...
echo ==================================================================
echo ARGUS DEMO IS STARTING
echo   * Backend URL:  http://localhost:8000
echo   * Frontend URL: http://localhost:5173
echo.
echo Press Ctrl+C to stop the frontend.
echo To close background processes: taskkill /F /IM uvicorn.exe /IM python.exe
echo ==================================================================

cd /d "%~dp0frontend"
npm run dev
