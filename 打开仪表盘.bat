@echo off
cd /d "%~dp0"
set PROFILE=SPORTS
set POLY_TAG=fifa-world-cup
echo ==========================================
echo   Dashboard server - press F5 in browser to refresh.
echo   Keep this window OPEN. Close it to stop.
echo ==========================================
echo.
node bot.js --serve 8899
echo.
echo Dashboard server stopped. Press any key to close...
pause >nul
