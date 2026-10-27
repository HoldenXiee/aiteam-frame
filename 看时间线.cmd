@echo off
rem Double-click: build the hunt topology timeline (offline) and open it.
rem Optional: 看时间线.cmd --list      list archived rounds
rem           set HUNT_LAB=research\labfirst\hunt-r2  另一路并行空间
chcp 65001 >nul
cd /d "%~dp0"
title hunt timeline
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
echo      tip: add #t=SECONDS to the URL to jump to a moment (e.g. ...html#t=900)
timeout /t 4 >nul
