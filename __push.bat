@echo off
cd /d "%~dp0"
echo Committing and pushing NoBossly to GitHub...
git add -A
git commit -m "Billing: EnRoute-style resilient checkout (inline price_data fallback, key-only gate)"
git push origin main
echo.
echo ===== DONE (exit %errorlevel%) =====
pause
