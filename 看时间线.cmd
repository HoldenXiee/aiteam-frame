@echo off
rem Double-click: build the hunt timeline (offline) and open it in the browser.
chcp 65001 >nul
cd /d "%~dp0"
title hunt timeline
node --version >nul 2>&1
call npx tsx research/clusters/micro/viz.ts %*
if errorlevel 1 (
  echo.
  echo [error] timeline build failed -- see the message above.
  pause
  exit /b 1
)
start "" "logs\hunt-timeline.html"
echo.
echo [ok] opened logs\hunt-timeline.html
timeout /t 3 >nul
