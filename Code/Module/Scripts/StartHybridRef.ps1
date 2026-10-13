param(
    [Parameter(Position = 0)][string]$Project,
    [switch]$Demo,
    [switch]$Build,
    [switch]$Check
)
$ErrorActionPreference = 'Stop'
$ModuleRoot = Split-Path -Parent $PSScriptRoot
$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $ModuleRoot '..\..'))
$LogRoot = Join-Path $ModuleRoot 'Runtime\Logs'
New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null
function InvokeHybridRefNative {
    param([string]$Executable, [string[]]$Arguments, [string]$LogPath)
    # Windows PowerShell 5 treats redirected native stderr as an ErrorRecord.
    # Build warnings must not abort a successful Node/pnpm process.
    $ErrorActionPreference = 'Continue'
    & $Executable @Arguments *> $LogPath
    return $LASTEXITCODE
}
try {
    $NodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    $NodePath = if ($NodeCommand) { $NodeCommand.Source } else {
        Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    }
    if (-not (Test-Path -LiteralPath $NodePath)) { throw 'Install Node.js 22 or later, then launch HybridRef again.' }
    & $NodePath -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Install Node.js 22 or later, then launch HybridRef again.' }
    $env:PATH = (Split-Path -Parent $NodePath) + ';' + $env:PATH
    if ($Demo) { $Project = Join-Path $RepositoryRoot 'Project\Demo\SimpleDemo.hbr' }
    if ($Project) { $Project = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Project) }
    Push-Location $ModuleRoot
    try {
        & $NodePath -e "try { require('sharp'); require.resolve('vite'); } catch { process.exit(1); }" *> $null
        $DependenciesReady = $LASTEXITCODE -eq 0
        if (-not $DependenciesReady) {
            $PnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
            $PnpmFallback = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
            if ($PnpmCommand) { $InstallExitCode = InvokeHybridRefNative -Executable $PnpmCommand.Source -Arguments @('install', '--frozen-lockfile') -LogPath (Join-Path $LogRoot 'Install.log') }
            elseif (Test-Path -LiteralPath $PnpmFallback) { $InstallExitCode = InvokeHybridRefNative -Executable $PnpmFallback -Arguments @('install', '--frozen-lockfile') -LogPath (Join-Path $LogRoot 'Install.log') }
            else {
                $NpxCommand = Get-Command npx.cmd -ErrorAction SilentlyContinue
                if (-not $NpxCommand) { throw 'Install pnpm 11 (npm install -g pnpm@11), then launch again.' }
                $InstallExitCode = InvokeHybridRefNative -Executable $NpxCommand.Source -Arguments @('--yes', 'pnpm@11.25.0', 'install', '--frozen-lockfile') -LogPath (Join-Path $LogRoot 'Install.log')
            }
            if ($InstallExitCode -ne 0) { throw 'Dependency installation failed. See Code\Module\Runtime\Logs\Install.log.' }
        }
        $LaunchArgs = @('Scripts/Launch.cjs')
        if ($Project) { $LaunchArgs += @('--project', $Project) }
        if ($Build) { $LaunchArgs += '--build' }
        if ($Check) { $LaunchArgs += '--check' }
        $LaunchExitCode = InvokeHybridRefNative -Executable $NodePath -Arguments $LaunchArgs -LogPath (Join-Path $LogRoot 'Launcher.log')
        if ($LaunchExitCode -ne 0) { throw 'HybridRef could not start. See Code\Module\Runtime\Logs\Launcher.log.' }
    } finally { Pop-Location }
} catch {
    $_ | Out-String | Add-Content -LiteralPath (Join-Path $LogRoot 'Launcher.log')
    if (-not $Check) {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'HybridRef') | Out-Null
    }
    Write-Error $_
    exit 1
}
