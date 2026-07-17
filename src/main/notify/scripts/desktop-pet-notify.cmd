@echo off
setlocal
rem userData on Windows = %APPDATA%\desktop-pet — note the lowercase 'd'.
rem Electron's `app.getPath('userData')` uses `app.name`, which comes from
rem package.json's `name` field (lowercase 'desktop-pet'), NOT the
rem `productName` field ('DesktopPet', used only by electron-builder for
rem install paths). Keep this in sync if package.json's `name` is renamed.
rem
rem IMPORTANT: %APPDATA% on Windows expands to "C:\Users\<user>\AppData\Roaming"
rem — the parentheses around `<user>` make the UNQUOTED assignment
rem `set PORT_FILE=%APPDATA%\desktop-pet\notify.port` a syntax error in
rem cmd.exe (parens introduce parenthesized blocks). Quote the RHS.
set "PORT_FILE=%APPDATA%\desktop-pet\notify.port"
if not exist "%PORT_FILE%" exit /b 0
set /p PORT=<"%PORT_FILE%"
if "%PORT%"=="" exit /b 0
curl -s -X POST -H "Content-Type: application/json" --data-binary @- http://127.0.0.1:%PORT%/notify >nul 2>nul
exit /b 0
