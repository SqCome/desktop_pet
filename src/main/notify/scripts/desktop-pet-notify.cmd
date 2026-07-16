@echo off
setlocal
rem userData on Windows = %APPDATA%\DesktopPet (matches productName in package.json).
rem Keep this string in sync if productName is ever renamed.
set PORT_FILE=%APPDATA%\DesktopPet\notify.port
if not exist "%PORT_FILE%" exit /b 0
set /p PORT=<"%PORT_FILE%"
if "%PORT%"=="" exit /b 0
curl -s -X POST -H "Content-Type: application/json" --data-binary @- http://127.0.0.1:%PORT%/notify >nul 2>nul
exit /b 0
