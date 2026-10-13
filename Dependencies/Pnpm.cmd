@echo off
setlocal
if "%~1"=="" goto Usage
for %%C in (build dev start demo test test:run typecheck check:naming e2e exec run --version -v --help -h help) do if /I "%~1"=="%%C" goto Run
echo Dependency changes are managed by Code\Module\package.json and pnpm-lock.yaml.
echo Run Dependencies\Setup.cmd to install them. This wrapper only runs development commands.
exit /b 2
:Run
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\Code\Module\Scripts\LocalEnvironment.ps1" -Check
if errorlevel 1 exit /b %ERRORLEVEL%
set "PATH=%~dp0Node;%PATH%"
set "PNPM_HOME=%~dp0Cache\PnpmHome"
set "XDG_CACHE_HOME=%~dp0Cache\XdgCache"
set "XDG_STATE_HOME=%~dp0Cache\XdgState"
set "XDG_CONFIG_HOME=%~dp0Cache\Config"
set "NODE_COMPILE_CACHE=%~dp0Cache\Node"
set "npm_config_cache=%~dp0Cache\Npm"
set "pnpm_config_cache_dir=%~dp0Cache\Pnpm"
set "pnpm_config_state_dir=%~dp0Cache\State"
set "pnpm_config_store_dir=%~dp0Cache\Store"
set "pnpm_config_pm_on_fail=ignore"
set "pnpm_config_verify_deps_before_run="
set "NODE_PATH="
set "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1"
"%~dp0Node\node.exe" "%~dp0Pnpm\bin\pnpm.mjs" --dir "%~dp0..\Code\Module" %*
exit /b %ERRORLEVEL%
:Usage
echo Usage: Dependencies\Pnpm.cmd ^<build^|typecheck^|test:run^|exec playwright test^|...^>
echo Dependencies: Dependencies\Setup.cmd
exit /b 0
