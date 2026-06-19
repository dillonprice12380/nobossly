@echo off
cd /d "%~dp0"
echo Clearing any stale git lock...
if exist ".git\index.lock" del /q ".git\index.lock"
echo Committing and pushing NoBossly to GitHub...
git add -A
git commit -m "Fix null-username profiles (backfill past auth trigger), OAuth username chooser, bulletproof logout"
git push origin main
echo.
echo ===== DONE (exit %errorlevel%) =====
pause
