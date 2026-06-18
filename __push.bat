@echo off
cd /d "%~dp0"
echo Committing and pushing NoBossly to GitHub...
git add -A
git commit -m "Debug: surface exact reason on checkout 'not configured' redirect"
git push origin main
echo.
echo ===== DONE (exit %errorlevel%) =====
pause
