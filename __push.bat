@echo off
cd /d "%~dp0"
echo Clearing any stale git lock...
if exist ".git\index.lock" del /q ".git\index.lock"
echo Committing and pushing NoBossly to GitHub...
git add -A
git commit -m "Free/paid split: Budget (free tracker + paid AI), Collaborations (free join, paid create), Blueprint (free 1, paid unlimited)"
git push origin main
echo.
echo ===== DONE (exit %errorlevel%) =====
pause
