@echo off
cd /d "%~dp0"
set PROFILE=SPORTS
set POLY_TAG=fifa-world-cup
echo Building dashboard from local data...
node bot.js --dashboard %*
if exist dashboard.html (
  echo Opening dashboard.html ...
  start "" dashboard.html
) else (
  echo dashboard.html not generated - check output above.
)
