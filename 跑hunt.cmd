@echo off
rem Double-click: start the hunt cluster (no time limit, limits removed).
rem Chinese output comes from run-hunt.mjs -- cmd.exe would mangle UTF-8 here.
chcp 65001 >nul
cd /d "%~dp0"
title hunt cluster
node run-hunt.mjs %*
echo.
echo [closed] press any key
pause >nul
