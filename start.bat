@echo off
setlocal
set "OPR_PROJECT_DIR=%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js wurde nicht gefunden.
  echo Bitte installiere Node.js von https://nodejs.org/ und starte diese Datei danach erneut.
  pause
  exit /b 1
)

rem Start only one local server. The server window stays hidden.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$listener = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue; if (-not $listener) { Start-Process -FilePath 'node.exe' -ArgumentList 'server.js' -WorkingDirectory $env:OPR_PROJECT_DIR -WindowStyle Hidden }"

timeout /t 1 /nobreak >nul
start "" "http://127.0.0.1:4173/"

endlocal
