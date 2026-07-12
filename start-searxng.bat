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
echo [1/4] Starting TCP relay (0.0.0.0:10812 -^> 127.0.0.1:10811)...
start /B python "%~dp0proxy-relay.py" >nul 2>&1

REM 2. 等待中继启动
timeout /t 2 /nobreak >nul

REM 3. 启动 WSL 后台会话 + socat 转发
echo [2/4] Starting WSL session and socat relay...
wsl -d Ubuntu -u root -- bash -c "socat TCP-LISTEN:10813,fork,reuseaddr TCP:$(ip route show default | awk '{print $3}'):10812 & echo 'WSL session + socat active'; sleep infinity" &
set WSL_PID=%!

REM 4. 等待 WSL 启动
timeout /t 5 /nobreak >nul

REM 5. 确保 SearXNG 容器运行
echo [3/4] Checking SearXNG container...
wsl -d Ubuntu -u root -- bash -c "docker start searxng 2>/dev/null; docker ps --format 'table {{.Names}}\t{{.Status}}' | grep searxng"

echo.
echo [4/4] Done!
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

REM 清理
taskkill /PID %WSL_PID% /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq proxy-relay*" /F >nul 2>&1
