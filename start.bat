@echo off
rem Launch hey-koko on Windows: start the server and open the browser.
cd /d "%~dp0"
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:1314"
node server.js
