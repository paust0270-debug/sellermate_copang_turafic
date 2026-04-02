@echo off
setlocal
cd /d "%~dp0"

set "EXE_PATH=%~dp0dist-exe-fixed\CoupangTraffic 1.0.0.exe"
if not exist "%EXE_PATH%" (
  echo [ERROR] exe not found:
  echo %EXE_PATH%
  pause
  exit /b 1
)

start "" "%EXE_PATH%"
exit /b 0
