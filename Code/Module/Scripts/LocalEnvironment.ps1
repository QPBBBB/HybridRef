param(
    [switch]$Setup,
    [switch]$Check,
    [switch]$Offline
)

$ErrorActionPreference = 'Stop'

function GetHybridRefEnvironment {
    $ModuleRoot = Split-Path -Parent $PSScriptRoot
    $RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $ModuleRoot '..\..'))
    $EnvironmentRoot = Join-Path $RepositoryRoot 'Dependencies'
    return [pscustomobject]@{
        ModuleRoot = $ModuleRoot
        RepositoryRoot = $RepositoryRoot
        EnvironmentRoot = $EnvironmentRoot
        NodePath = Join-Path $EnvironmentRoot 'Node\node.exe'
        PnpmPath = Join-Path $EnvironmentRoot 'Pnpm\bin\pnpm.mjs'
        DependencyRoot = Join-Path $EnvironmentRoot 'Packages'
        DependencyPath = Join-Path $EnvironmentRoot 'Packages\node_modules'
        LinkPath = Join-Path $ModuleRoot 'node_modules'
        CacheRoot = Join-Path $EnvironmentRoot 'Cache'
        StatePath = Join-Path $EnvironmentRoot 'Packages\Environment.json'
        LogRoot = Join-Path $ModuleRoot 'Runtime\Logs'
    }
}

function AssertHybridRefDirectory {
    param([string]$Path, [switch]$Create)
    $Entry = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($Entry -and (($Entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not $Entry.PSIsContainer)) {
        throw "Expected an ordinary directory, not a file or link: $Path"
    }
    if (-not $Entry -and $Create) { New-Item -ItemType Directory -Path $Path | Out-Null }
}

function SetHybridRefProcessEnvironment {
    param($Environment)
    $env:PATH = (Split-Path -Parent $Environment.NodePath) + ';' + $env:PATH
    $env:PNPM_HOME = Join-Path $Environment.CacheRoot 'PnpmHome'
    $env:XDG_CACHE_HOME = Join-Path $Environment.CacheRoot 'XdgCache'
    $env:XDG_STATE_HOME = Join-Path $Environment.CacheRoot 'XdgState'
    $env:XDG_CONFIG_HOME = Join-Path $Environment.CacheRoot 'Config'
    $env:NODE_COMPILE_CACHE = Join-Path $Environment.CacheRoot 'Node'
    $env:npm_config_cache = Join-Path $Environment.CacheRoot 'Npm'
    $env:pnpm_config_cache_dir = Join-Path $Environment.CacheRoot 'Pnpm'
    $env:pnpm_config_state_dir = Join-Path $Environment.CacheRoot 'State'
    $env:pnpm_config_store_dir = Join-Path $Environment.CacheRoot 'Store'
    $env:pnpm_config_pm_on_fail = 'ignore'
    # pnpm 11 keeps this environment override as a string, including "false".
    # Clear it so the workspace's actual boolean false disables the check.
    $env:pnpm_config_verify_deps_before_run = $null
    $env:NODE_PATH = $null
    $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
}

function InvokeHybridRefNative {
    param([string]$Executable, [string[]]$Arguments, [string]$LogPath)
    # Windows PowerShell 5 wraps redirected native stderr in ErrorRecord objects.
    # Preserve the process exit code instead of treating warnings as fatal errors.
    $ErrorActionPreference = 'Continue'
    if ($LogPath) { & $Executable @Arguments *> $LogPath }
    else { & $Executable @Arguments 2>&1 | Out-Host }
    return $LASTEXITCODE
}

function InitializeHybridRefTools {
    $Environment = GetHybridRefEnvironment
    foreach ($Path in @($Environment.ModuleRoot, (Split-Path -Parent $Environment.ModuleRoot), $Environment.EnvironmentRoot,
        (Join-Path $Environment.EnvironmentRoot 'Node'), (Join-Path $Environment.EnvironmentRoot 'Pnpm'))) {
        AssertHybridRefDirectory -Path $Path
    }
    if (-not (Test-Path -LiteralPath $Environment.NodePath -PathType Leaf)) {
        throw 'The local Node.js runtime is missing. Restore Dependencies\Node\node.exe from the complete HybridRef folder.'
    }
    if (-not (Test-Path -LiteralPath $Environment.PnpmPath -PathType Leaf)) {
        throw 'The local pnpm tool is missing. Restore Dependencies\Pnpm from the complete HybridRef folder.'
    }
    SetHybridRefProcessEnvironment -Environment $Environment
    New-Item -ItemType Directory -Force -Path $Environment.LogRoot | Out-Null
    $NodeCode = "const [Major, Minor] = process.versions.node.split('.').map(Number); process.exit(process.platform === 'win32' && process.arch === 'x64' && (Major > 22 || Major === 22 && Minor >= 13) ? 0 : 1)"
    $CheckLogPath = Join-Path $Environment.LogRoot "Environment-$PID.log"
    $ExitCode = InvokeHybridRefNative -Executable $Environment.NodePath -Arguments @('-e', $NodeCode) -LogPath $CheckLogPath
    if ($ExitCode -ne 0) { throw "Dependencies\Node must contain Node.js 22.13 or later for Windows x64. See $CheckLogPath" }
    Remove-Item -LiteralPath $CheckLogPath
    return $Environment
}

function ConnectHybridRefDependencies {
    param($Environment)
    AssertHybridRefDirectory -Path $Environment.DependencyRoot
    AssertHybridRefDirectory -Path $Environment.DependencyPath
    if (-not (Test-Path -LiteralPath $Environment.DependencyPath -PathType Container)) {
        throw 'Local dependencies are missing. Run Dependencies\Setup.cmd first.'
    }
    # The only removable path is the exact node_modules entry under this script's
    # Code\Module directory. Never recurse, and never delete its target contents.
    $ExpectedLinkPath = [IO.Path]::GetFullPath((Join-Path $Environment.ModuleRoot 'node_modules'))
    if ($ExpectedLinkPath -ne $Environment.LinkPath) { throw 'Refusing to modify an unexpected dependency link path.' }
    $Entry = Get-Item -LiteralPath $ExpectedLinkPath -Force -ErrorAction SilentlyContinue
    if ($Entry) {
        if (($Entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
            throw 'Code\Module\node_modules is an existing real directory. Move it aside before using the local environment; no files were removed.'
        }
        $Target = @($Entry.Target)[0]
        if ($Target -and [IO.Path]::GetFullPath($Target) -eq $Environment.DependencyPath) { return }
        [IO.Directory]::Delete($ExpectedLinkPath, $false)
    }
    New-Item -ItemType Junction -Path $ExpectedLinkPath -Target $Environment.DependencyPath | Out-Null
}

function GetHybridRefDependencyState {
    param($Environment)
    function GetHybridRefFileHash {
        param([string]$Path)
        $Stream = [IO.File]::OpenRead($Path)
        $Algorithm = [Security.Cryptography.SHA256]::Create()
        try { return [BitConverter]::ToString($Algorithm.ComputeHash($Stream)).Replace('-', '') }
        finally { $Algorithm.Dispose(); $Stream.Dispose() }
    }
    return [ordered]@{
        FormatVersion = 1
        PackageHash = GetHybridRefFileHash -Path (Join-Path $Environment.ModuleRoot 'package.json')
        LockHash = GetHybridRefFileHash -Path (Join-Path $Environment.ModuleRoot 'pnpm-lock.yaml')
        WorkspaceHash = GetHybridRefFileHash -Path (Join-Path $Environment.ModuleRoot 'pnpm-workspace.yaml')
    }
}

function TestHybridRefDependencies {
    param($Environment)
    if (-not (Test-Path -LiteralPath $Environment.StatePath -PathType Leaf)) {
        throw 'The local dependency setup is incomplete. Run Dependencies\Setup.cmd first.'
    }
    $Expected = GetHybridRefDependencyState -Environment $Environment
    $Saved = Get-Content -LiteralPath $Environment.StatePath -Raw | ConvertFrom-Json
    foreach ($Key in $Expected.Keys) {
        if ($Saved.$Key -ne $Expected[$Key]) { throw 'The dependency definitions have changed. Run Dependencies\Setup.cmd to refresh the local dependencies.' }
    }
    ConnectHybridRefDependencies -Environment $Environment
    $DependencyCode = "const Require = require('node:module').createRequire(require('node:path').join(process.argv[1], 'package.json')); for (const Name of ['react', 'react-dom', 'bmp-js', 'yaml', 'vite', 'typescript', 'vitest', '@playwright/test', 'esbuild']) Require.resolve(Name); Require('sharp'); Require('esbuild')"
    $CheckLogPath = Join-Path $Environment.LogRoot "Environment-$PID.log"
    $ExitCode = InvokeHybridRefNative -Executable $Environment.NodePath -Arguments @('-e', $DependencyCode, $Environment.ModuleRoot) -LogPath $CheckLogPath
    if ($ExitCode -ne 0) { throw "Local dependencies could not load. Run Dependencies\Setup.cmd; see $CheckLogPath" }
    Remove-Item -LiteralPath $CheckLogPath
}

function InstallHybridRefDependencies {
    param($Environment, [switch]$Offline)
    AssertHybridRefDirectory -Path $Environment.DependencyRoot -Create
    AssertHybridRefDirectory -Path $Environment.DependencyPath
    AssertHybridRefDirectory -Path $Environment.CacheRoot -Create
    $Package = Get-Content -LiteralPath (Join-Path $Environment.ModuleRoot 'package.json') -Raw | ConvertFrom-Json
    # Source manifests stay authoritative; this installation manifest intentionally
    # has no scripts whose relative paths refer to the source tree.
    $Package.PSObject.Properties.Remove('scripts')
    $Utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText((Join-Path $Environment.DependencyRoot 'package.json'), (($Package | ConvertTo-Json -Depth 100) + [Environment]::NewLine), $Utf8)
    foreach ($Filename in @('pnpm-lock.yaml', 'pnpm-workspace.yaml')) {
        Copy-Item -LiteralPath (Join-Path $Environment.ModuleRoot $Filename) -Destination (Join-Path $Environment.DependencyRoot $Filename) -Force
    }
    $Arguments = @($Environment.PnpmPath, '--dir', $Environment.DependencyRoot, 'install', '--frozen-lockfile', '--reporter=append-only',
        '--store-dir', (Join-Path $Environment.CacheRoot 'Store'))
    if ($Offline) { $Arguments += '--offline' }
    Write-Host 'Installing the locked dependencies into Dependencies\Packages (system Edge is used; no browser download).'
    $ExitCode = InvokeHybridRefNative -Executable $Environment.NodePath -Arguments $Arguments -LogPath (Join-Path $Environment.LogRoot 'Install.log')
    Get-Content -LiteralPath (Join-Path $Environment.LogRoot 'Install.log') | ForEach-Object { Write-Host $_ }
    if ($ExitCode -ne 0) { throw "Dependency installation failed (exit $ExitCode). See Code\Module\Runtime\Logs\Install.log." }
    $State = GetHybridRefDependencyState -Environment $Environment
    [IO.File]::WriteAllText($Environment.StatePath, (($State | ConvertTo-Json) + [Environment]::NewLine), $Utf8)
    TestHybridRefDependencies -Environment $Environment
    Write-Host 'HybridRef local development environment is ready.'
}

# StartHybridRef.ps1 dot-sources this file to share validation and link repair.
if ($MyInvocation.InvocationName -ne '.') {
    try {
        $Environment = InitializeHybridRefTools
        if ($Setup) { InstallHybridRefDependencies -Environment $Environment -Offline:$Offline }
        else { TestHybridRefDependencies -Environment $Environment }
        exit 0
    } catch {
        Write-Error $_ -ErrorAction Continue
        exit 1
    }
}
