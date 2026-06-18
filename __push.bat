@echo off
cd /d "%~dp0"
echo Committing and pushing NoBossly to GitHub...
git add -A
git commit -m "Debug: report STRIPE/SUB_SYNC/SITE_URL env presence on /debug"
git push origin main
echo.
echo ===== DONE (exit %errorlevel%) =====
pause
