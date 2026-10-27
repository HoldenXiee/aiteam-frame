@echo off
rem Double-click: read out hunt (0 token, offline re-checkable).
chcp 65001 >nul
cd /d "%~dp0"
title hunt readout
call npm run exp
echo.
call npm run huntlib
echo.
if exist "research\labfirst\hunt\work\_cluster.lock" (
  echo [running] lock file:
  type "research\labfirst\hunt\work\_cluster.lock"
) else (
  echo [idle] no lock file -- cluster is not running
)
echo.
pause >nul
