@echo off
REM ============================================================
REM  SearXNG 启动脚本（含 v2rayN 代理支持）
REM  - 启动 Python TCP 中继 (0.0.0.0:10812 -> 127.0.0.1:10811)
REM  - 启动 WSL socat 转发 (localhost:10813 -> Windows:10812)
REM  - 启动 WSL 后台会话防止 VM 关闭
REM  - SearXNG 容器使用 host 网络模式，通过 localhost:10813 代理
REM ============================================================

echo Starting SearXNG with proxy support...

REM 1. 启动 Python TCP 中继（Windows 端）
echo [1/5] Starting TCP relay (0.0.0.0:10812 -^> 127.0.0.1:10811)...

REM 检查端口 10812 是否已被占用
netstat -ano | findstr ":10812 " | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo      [SKIP] Port 10812 already in use, relay may already be running.
) else (
    REM 检查 Python 是否可用
    python --version >nul 2>&1
    if %ERRORLEVEL% neq 0 (
        echo      [ERROR] Python not found in PATH! Please install Python or add it to PATH.
        echo      You can download from: https://www.python.org/downloads/
        pause
        exit /b 1
    )
    start /B python "%~dp0proxy-relay.py"
)

REM 2. 等待中继启动
timeout /t 2 /nobreak >nul

REM 3. 启动 WSL 后台会话 + socat 转发
REM    注意：必须用 start /B 后台启动，否则 sleep infinity 会阻塞脚本
echo [2/5] Starting WSL session and socat relay...
start /B wsl -d Ubuntu -u root -- bash -c "socat TCP-LISTEN:10813,fork,reuseaddr TCP:$(ip route show default | awk '{print $3}'):10812 & echo 'WSL session + socat active'; sleep infinity"

REM 4. 等待 WSL socat 启动
timeout /t 3 /nobreak >nul

REM 5. 确保 SearXNG 容器运行
echo [3/5] Checking SearXNG container...
wsl -d Ubuntu -u root -- bash -c "docker start searxng 2>/dev/null; docker ps --format 'table {{.Names}}\t{{.Status}}' | grep searxng"

if %ERRORLEVEL% neq 0 (
    echo.
    echo      [WARNING] SearXNG container not found or not running!
    echo      Run this command first to create it:
    echo      docker run -d --name searxng --network host ^
      -v %~dp0searxng-settings.yml:/etc/searxng/settings.yml ^
      searxng/searxng:latest
    echo.
)

REM 6. 验证服务可访问性
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

REM 保持脚本运行
pause >nul

REM 清理：杀掉 WSL 中的 socat 进程
echo Cleaning up...
wsl -d Ubuntu -u root -- bash -c "pkill -f 'socat TCP-LISTEN:10813' 2>/dev/null" >nul 2>&1
REM 杀掉 Python relay（按命令行匹配）
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":10812 " ^| findstr "LISTENING"') do (
    taskkill /PID %%a /F >nul 2>&1
)
echo Done.
