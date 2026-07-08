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
set POSITIONING_MIN_NOTIONAL=500
rem declutter: focus is the winner pin + scorecard pin; drop the hourly positioning message + slow all-sports to 6h
set POSITIONING_ENABLED=off
set SHARP_MIN=360
rem sports to scan for winners + strength tracking (added esports V9.9: LoL/CS2/Dota big volume, own out-of-sample group)
set SHARP_SPORTS=mlb,tennis,esports
set WINNER_SPORTS=fifa-world-cup,mlb,tennis,esports
rem winner latest-bets pin + per-wallet scorecard, refresh every 60 min
set WINNER_MIN=60
set WINNER_HOURS=24
set WINNER_MIN_BET=1000
set WINNER_MIN_PNL=50000
rem turn off the global Top-Traders profiles (off-topic for World Cup)
set PROFILES_ENABLED=off
rem turn off per-signal spam; consolidate into the periodic digests
set SIGNALS_ENABLED=off
echo ==========================================
echo   Polaris Radar V10.2 - World Cup (personal DM)
echo   focus: winner-bets pin + per-wallet scorecard
echo   Close this window to STOP.
echo ==========================================
echo.
node bot.js
echo.
echo Radar stopped. Press any key to close...
pause >nul
