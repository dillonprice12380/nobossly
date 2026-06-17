@echo off
cd /d "%~dp0"
echo Pushing NoBossly to GitHub (dillonprice12380/nobossly)...
echo.
git init
git add -A
git commit -m "Import NoBossly source"
git branch -M main
git remote remove origin 2>nul
git remote add origin https://github.com/dillonprice12380/nobossly.git
git push -u --force origin main
echo.
echo ===== DONE (exit %errorlevel%) =====
echo If you see "Authentication failed", sign in to GitHub when prompted (or via GitHub Desktop) and run again.
pause
