@echo off
cd /d "%~dp0"
set PROFILE=SPORTS
set POLY_TAG=fifa-world-cup
echo Building dashboard (refreshing candidate bet details, ~10s)...
node bot.js --dashboard --refresh %*
if exist dashboard.html (
  echo Opening dashboard.html ...
  start "" dashboard.html
) else (
  echo dashboard.html not generated - check output above.
)
