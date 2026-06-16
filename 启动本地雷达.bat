@echo off
chcp 65001 >nul
cd /d "%~dp0"
set POLL_SECONDS=20
echo ============================================
echo    Polaris 雷达 - 本地快速模式 (每 20 秒扫描)
echo    关闭此窗口 即可停止
echo ============================================
echo.
node bot.js
echo.
echo [雷达已停止] 按任意键关闭此窗口...
pause >nul
