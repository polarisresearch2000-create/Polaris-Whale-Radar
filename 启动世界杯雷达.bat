@echo off
cd /d "%~dp0"
set PROFILE=SPORTS
set POLY_TAG=fifa-world-cup
set VERTICAL_LABEL=World Cup
rem personal-use: slow 5-min poll (lighter on API; near-real-time not needed since per-signal alerts are off)
set POLL_SECONDS=300
rem World Cup thresholds (whale MIN_NOTIONAL=5000; edit to tune)
set MIN_NOTIONAL=5000
set SIGNAL_MIN_PNL=20000
set WATCHLIST_MIN_PNL=50000
set WATCHLIST_MIN_NOTIONAL=500
rem positioning snapshot independent low threshold (stats only, not signals)
set POSITIONING_MIN_NOTIONAL=500
rem personal-use cadence: positioning every 3h, all-sports sharps every 12h (was 15min / 6h)
set POSITIONING_MIN=180
set SHARP_MIN=720
rem turn off the global Top-Traders profiles (off-topic for World Cup)
set PROFILES_ENABLED=off
rem turn off per-signal spam; consolidate into the periodic digests
set SIGNALS_ENABLED=off
echo ==========================================
echo   Polaris Radar V6.3 - World Cup (personal DM)
echo   poll 5min - positioning 3h - sharps 12h
echo   Close this window to STOP.
echo ==========================================
echo.
node bot.js
echo.
echo Radar stopped. Press any key to close...
pause >nul
