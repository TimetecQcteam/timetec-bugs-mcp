@echo off
REM Double-clickable wrapper for install.ps1 - bypasses ExecutionPolicy per-run only.
setlocal
set "SCRIPT_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install.ps1" %*
echo.
echo Press any key to close this window.
pause >nul
endlocal
