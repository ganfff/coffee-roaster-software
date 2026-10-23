@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-DebugDesktop.ps1" %*
set "taskExit=%errorlevel%"
if not "%taskExit%"=="0" pause
exit /b %taskExit%
