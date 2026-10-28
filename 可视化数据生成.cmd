@echo off
rem ============================================================
rem  hunt data exporter  ->  a JSON file  ->  viz-ui (React page)
rem
rem  This .cmd is PURE ASCII on purpose: cmd.exe reads .cmd in
rem  the OEM codepage (cp936 here) and mangles UTF-8 Chinese.
rem
rem  What it does:
rem    1) research/clusters/micro/vizdata.ts  ->  viz-ui\data\hunt.json
rem    2) builds viz-ui\dist if missing (npm install only if needed)
rem    3) opens viz-ui\dist\index.html
rem  Then in the page: pick (or drag in) the JSON file.
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"
title hunt data exporter

echo [1/3] export data ...
call npx tsx research/clusters/micro/vizdata.ts %*
if errorlevel 1 goto fail

if not exist "viz-ui\node_modules" (
  echo [2/3] install frontend deps ^(one time, needs network^) ...
  pushd viz-ui
  call npm install --no-fund --no-audit
  popd
  if errorlevel 1 goto fail
) else (
  echo [2/3] frontend deps ok
)

if not exist "viz-ui\dist\index.html" (
  echo [2/3] build frontend ...
  pushd viz-ui
  call npm run build
  popd
  if errorlevel 1 goto fail
)

echo [3/3] open the page
start "" "%~dp0viz-ui\dist\index.html"

echo.
echo    Data file : %~dp0viz-ui\data\hunt.json
echo    In the page: click "select hunt.json" (or drag the file into the window)
echo.
echo    Tip: re-run this .cmd after each hunt round; the page keeps its last view.
rem portable pause (avoid clashing with unix `timeout` on PATH)
ping -n 8 127.0.0.1 >nul
exit /b 0

:fail
echo.
echo [error] step failed - see the message above.
pause
exit /b 1
