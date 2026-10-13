param(
    [Parameter(Position = 0)][string]$Project,
    [switch]$Demo,
    [switch]$Build,
    [switch]$Check
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'LocalEnvironment.ps1') -Check:$Check
$ModuleRoot = Split-Path -Parent $PSScriptRoot
$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $ModuleRoot '..\..'))
$LogRoot = Join-Path $ModuleRoot 'Runtime\Logs'
New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null
try {
    $Environment = InitializeHybridRefTools
    TestHybridRefDependencies -Environment $Environment
    $NodePath = $Environment.NodePath
    if ($Demo) { $Project = Join-Path $RepositoryRoot 'Project\Demo\Demo.hbr' }
    if ($Project) { $Project = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Project) }
    Push-Location $ModuleRoot
    try {
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
