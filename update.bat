@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node.exe not found in PATH. Install Node.js first.
  pause
  exit /b 1
)

echo [1/3] Build site from pages\*.md  (pagelist.js + docs\*.md.js + self-check)
node "tools\pages_build.js"
if errorlevel 1 ( echo [ERROR] pages_build.js failed. Nothing was published. & pause & exit /b 1 )

echo [2/3] Tidy data\*.js layout (blank-only reformat, token-checked)
node "tools\data_pretty.js"
if errorlevel 1 echo [WARN] data_pretty.js refused to rewrite something - check its output above.

echo [3/3] Opening index.html ...
start "" "%~dp0index.html"

echo Reminders:
echo   - Text lives ONLY in pages\**.md; edit there. No script writes text into md anymore.
echo   - Media paths inside md are resolved against the site root, never use ../ prefixes.
echo   - One-off tools: pages_restructure.js / pages_split_archive.js / pages_use_thumbs.js /
echo     make_thumbs.js / site_move_unused.js  (see README for when to run them).
pause
endlocal
