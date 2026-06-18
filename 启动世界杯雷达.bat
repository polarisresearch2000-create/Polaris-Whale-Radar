@echo off
cd /d "%~dp0"
set PROFILE=SPORTS
set POLY_TAG=fifa-world-cup
set VERTICAL_LABEL=World Cup
set POLL_SECONDS=20
rem World Cup thresholds (whale MIN_NOTIONAL=5000; edit to tune)
set MIN_NOTIONAL=5000
set SIGNAL_MIN_PNL=20000
set WATCHLIST_MIN_PNL=50000
set WATCHLIST_MIN_NOTIONAL=500
rem positioning snapshot independent low threshold (stats only, not signals)
set POSITIONING_MIN_NOTIONAL=500
rem push the positioning analysis every 15 minutes
set POSITIONING_MIN=15
rem turn off the global Top-Traders profiles (off-topic for World Cup)
set PROFILES_ENABLED=off
echo ==========================================
echo   Polaris Radar V3.1 - World Cup (Sports) 20s
echo   Close this window to STOP.
echo ==========================================
echo.
node bot.js
echo.
echo Radar stopped. Press any key to close...
pause >nul
