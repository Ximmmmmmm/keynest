@echo off
rem KeyNest launcher. Keep this file CRLF + ASCII only, cmd.exe misparses otherwise.
setlocal
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"

set "ELECTRON_EXE=%~dp0node_modules\electron\dist\electron.exe"

if exist "%ELECTRON_EXE%" goto run

echo Installing dependencies, please wait...
call npm install
if errorlevel 1 goto fail

:run
if not exist "%ELECTRON_EXE%" goto fail
start "" /d "%~dp0" "%ELECTRON_EXE%" .
exit /b 0

:fail
echo.
echo KeyNest could not start.
echo Expected: %ELECTRON_EXE%
echo Run "npm install" in this folder, then try again.
pause
exit /b 1
