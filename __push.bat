@echo off
cd /d "%~dp0"
echo Committing and pushing NoBossly to GitHub...
git add -A
git commit -m "Auth: host-only session cookies + protocol-aware Secure (fix dev-domain login)"
git push origin main
echo.
echo ===== DONE (exit %errorlevel%) =====
pause
