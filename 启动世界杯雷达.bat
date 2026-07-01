@echo off
cd /d "%~dp0"
set PROFILE=SPORTS
set POLY_TAG=fifa-world-cup
set VERTICAL_LABEL=World Cup
rem personal-use "more signals" profile: 3-min poll
set POLL_SECONDS=180
rem World Cup thresholds (whale MIN_NOTIONAL=5000; edit to tune)
set MIN_NOTIONAL=5000
set SIGNAL_MIN_PNL=20000
set WATCHLIST_MIN_PNL=50000
set WATCHLIST_MIN_NOTIONAL=500
rem positioning snapshot independent low threshold (stats only, not signals)
set POSITIONING_MIN_NOTIONAL=500
rem cadence: positioning 1h, all-sports sharps 3h
set POSITIONING_MIN=60
set SHARP_MIN=180
rem winner latest-bets feed (proven winners' recent directional bets, tx-deduped so no repeats)
set WINNER_MIN=60
set WINNER_HOURS=24
set WINNER_MIN_BET=2000
set WINNER_MIN_PNL=100000
rem turn off the global Top-Traders profiles (off-topic for World Cup)
set PROFILES_ENABLED=off
rem turn off per-signal spam; consolidate into the periodic digests
set SIGNALS_ENABLED=off
echo ==========================================
echo   Polaris Radar V6.9 - World Cup (personal DM)
echo   winners' latest bets 1h - positioning 1h - sharps 3h
echo   Close this window to STOP.
echo ==========================================
echo.
node bot.js
echo.
echo Radar stopped. Press any key to close...
pause >nul
