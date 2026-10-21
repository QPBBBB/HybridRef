@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\Code\Module\Scripts\LocalEnvironment.ps1" -Check
if errorlevel 1 exit /b %ERRORLEVEL%
"%~dp0..\Dependencies\Node\node.exe" "%~dp0..\Code\Module\Scripts\RunAgent.cjs" %*
exit /b %ERRORLEVEL%
