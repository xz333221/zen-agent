@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

REM ============================================================
REM  SearXNG Startup Script (with v2rayN proxy support)
REM  - Start Python TCP relay (0.0.0.0:10812 -> 127.0.0.1:10811)
REM  - Start WSL socat forward (localhost:10813 -> Windows:10812)
REM  - Start WSL background session to prevent VM shutdown
REM  - SearXNG container uses host network mode, proxy via localhost:10813
REM ============================================================

echo Starting SearXNG with proxy support...

REM 1. Start Python TCP relay (Windows side)
echo [1/5] Starting TCP relay (0.0.0.0:10812 -^> 127.0.0.1:10811)...

REM Check if port 10812 is already in use
netstat -ano | findstr ":10812 " | findstr "LISTENING" >nul 2>&1
if !ERRORLEVEL! equ 0 (
    echo      [SKIP] Port 10812 already in use, relay may already be running.
    goto :start_wsl
)

REM --- Detect Python (avoid Windows Store stub) ---
set "PYTHON_CMD="

REM Try py launcher first (most reliable on Windows)
py -3 --version >nul 2>&1
if !ERRORLEVEL! equ 0 (
    set "PYTHON_CMD=py -3"
    goto :found_python
)

REM Try python (check it's not the WindowsApps stub)
for /f "delims=" %%i in ('where python 2^>nul') do (
    echo %%i | findstr /i "WindowsApps" >nul 2>&1
    if !ERRORLEVEL! neq 0 (
        set "PYTHON_CMD=python"
        goto :found_python
    )
)

REM Try python3
python3 --version >nul 2>&1
if !ERRORLEVEL! equ 0 (
    set "PYTHON_CMD=python3"
    goto :found_python
)

REM Python not found
echo      [ERROR] Python not found in PATH!
echo      Detected commands tried: py, python, python3
echo.
echo      If you have Python installed, make sure it is added to system PATH
echo      (not just user PATH). Also disable the Windows Store Python alias:
echo      Settings ^> Apps ^> Advanced app settings ^> App execution aliases ^> python.exe = OFF
echo.
echo      Download Python from: https://www.python.org/downloads/
pause
exit /b 1

:found_python
echo      [INFO] Using Python: !PYTHON_CMD!
start /B !PYTHON_CMD! "%~dp0proxy-relay.py"

:start_wsl
REM 2. Wait for relay to start
timeout /t 2 /nobreak >nul

REM 3. Start WSL background session + socat forward
echo [2/5] Starting WSL session and socat relay...
start /B wsl -d Ubuntu -u root -- bash -c "socat TCP-LISTEN:10813,fork,reuseaddr TCP:$(ip route show default | awk '{print $3}'):10812 & echo 'WSL session + socat active'; sleep infinity"

REM 4. Wait for WSL socat to start
timeout /t 3 /nobreak >nul

REM 5. Ensure SearXNG container is running
echo [3/5] Checking SearXNG container...
wsl -d Ubuntu -u root -- bash -c "docker start searxng 2>/dev/null; docker ps --format 'table {{.Names}}\t{{.Status}}' | grep searxng"

if !ERRORLEVEL! neq 0 (
    echo.
    echo      [WARNING] SearXNG container not found or not running!
    echo      Run this command first to create it:
    echo      docker run -d --name searxng --network host ^
      -v %~dp0searxng-settings.yml:/etc/searxng/settings.yml ^
      searxng/searxng:latest
    echo.
)

REM 6. Verify SearXNG is reachable
echo [4/5] Verifying SearXNG is reachable...
timeout /t 3 /nobreak >nul
powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:8080' -UseBasicParsing -TimeoutSec 5; if ($r.StatusCode -eq 200) { Write-Host '      [OK] SearXNG is responding (HTTP 200)' } else { Write-Host '      [WARN] SearXNG returned HTTP' $r.StatusCode } } catch { Write-Host '      [FAIL] Cannot reach SearXNG at localhost:8080' }"

echo.
echo [5/5] Done!
echo.
echo ========================================
echo  SearXNG is running at http://localhost:8080
echo  JSON API: http://localhost:8080/search?q=QUERY^&format=json
echo  Proxy: v2rayN(10811) -^> relay(10812) -^> socat(10813)
echo ========================================
echo.
echo Press Ctrl+C to stop.
echo.

REM Keep script running
pause >nul

REM Cleanup: kill socat process in WSL
echo Cleaning up...
wsl -d Ubuntu -u root -- bash -c "pkill -f 'socat TCP-LISTEN:10813' 2>/dev/null" >nul 2>&1
REM Kill Python relay (match by command line)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":10812 " ^| findstr "LISTENING"') do (
    taskkill /PID %%a /F >nul 2>&1
)
echo Done.
