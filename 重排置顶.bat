@echo off
cd /d "%~dp0"
rem One-click: clean up orphan/duplicate pins and re-order (scorecard on top).
rem Must carry the World Cup env, otherwise --repin reads the crypto state by mistake.
set PROFILE=SPORTS
set POLY_TAG=fifa-world-cup
node bot.js --repin
echo.
echo Done. Press any key to close...
pause >nul
