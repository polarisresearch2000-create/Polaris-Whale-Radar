@echo off
cd /d "%~dp0"
set POLL_SECONDS=20
echo ==========================================
echo   Polaris Radar V7.3 - Crypto Local (20s)
echo   Close this window to STOP.
echo ==========================================
echo.
node bot.js
echo.
echo Radar stopped. Press any key to close...
pause >nul
