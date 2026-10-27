@echo off
rem Double-click: stop the hunt cluster gracefully (waits for its own shutdown).
chcp 65001 >nul
cd /d "%~dp0"
title stop hunt
node stop-hunt.mjs
echo.
echo [closed] press any key
pause >nul
