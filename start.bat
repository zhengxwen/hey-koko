@echo off
rem Launch hey-koko on Windows: start the server and open the browser.
cd /d "%~dp0"
rem One-time (~7 MB): download pinned UI libraries for fully-offline use.
rem Safe to fail — missing files load from the CDN at runtime instead.
if not defined HEYKOKO_NO_VENDOR node scripts\fetch-vendor.js --quiet
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:1314"
node server.js
