@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\Code\Module\Scripts\LocalEnvironment.ps1" -Setup %*
exit /b %ERRORLEVEL%
