@echo off
rem Double-click: build the hunt timeline (offline, one HTML file) and open it.
rem   4 views: topology / research process (swimlane) / research content (cards) / numbers
rem   URL params:  #t=SECONDS  #view=flow|cards|nums  #pick=E134
rem   --list              list archived rounds
rem   HUNT_LAB=...        another parallel space
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
echo      4 views: topology / research process / research content / numbers
echo      jump to a moment:  ...html#t=900     a view: ...html#view=flow
timeout /t 5 >nul
