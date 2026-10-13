@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0Code\Module\Scripts\StartHybridRef.ps1" %*
