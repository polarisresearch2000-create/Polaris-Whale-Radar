@echo off
cd /d "%~dp0"
set PROFILE=SPORTS
set POLY_TAG=fifa-world-cup
set VERTICAL_LABEL=World Cup
set POLL_SECONDS=20
rem --- World Cup thresholds (moderate: lively but still quality; raise these if too noisy) ---
set MIN_NOTIONAL=2000
set SIGNAL_MIN_PNL=20000
set WATCHLIST_MIN_PNL=50000
set WATCHLIST_MIN_NOTIONAL=500
echo ==========================================
echo   Polaris Radar - World Cup (Sports) 20s
echo   Close this window to STOP.
echo ==========================================
echo.
node bot.js
echo.
echo Radar stopped. Press any key to close...
pause >nul
