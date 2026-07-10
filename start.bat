@echo off
setlocal
cd /d "%~dp0"

echo ===============================
echo   Karaoke Party - Starting...
echo ===============================

if not exist node_modules (
    echo Installing Node dependencies...
    call npm install
)

if exist "C:\Users\hex\bgutil-ytdlp-pot-provider\server\build\main.js" (
    netstat -ano | findstr ":4416" | findstr "LISTENING" >nul
    if errorlevel 1 (
        echo Starting YouTube POT provider...
        start "POT Provider" /min cmd /k "cd /d C:\Users\hex\bgutil-ytdlp-pot-provider\server && node build\main.js"
    )
) else (
    echo POT provider not found - skipping ^(YouTube downloads may hit bot checks^)
)

echo Starting server...
start "Karaoke Server" cmd /k node server.js

timeout /t 2 /nobreak >nul
start "" http://localhost:3000

endlocal
