param([string]$Root, [switch]$Keep)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$Repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$Cli = Join-Path $Repository 'AgentKnowledge/HybridRef.cmd'
$AutomaticRoot = -not $Root
$ExamplesRoot = Join-Path $Repository 'Code/Module/Runtime/Tests/Examples'
if ($AutomaticRoot) { $Root = Join-Path $ExamplesRoot ([Guid]::NewGuid().ToString('N')) }
$Root = [IO.Path]::GetFullPath($Root)
$Project = $null

function InvokeCli {
    param([string[]]$Arguments)
    $Output = & $Cli @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Agent command failed: $($Arguments -join ' ')" }
    $Result = ($Output -join "`n") | ConvertFrom-Json
    if (-not $Result.ok) { throw 'Agent returned ok=false.' }
    return $Result
}

try {
    $Created = InvokeCli -Arguments @('project', 'create', '--root', $Root, '--name', 'AgentExample')
    $Project = $Created.project
    $IndexBefore = [IO.File]::ReadAllText($Project)
    $null = InvokeCli -Arguments @('project', 'list', '--root', $Root)
    $null = InvokeCli -Arguments @('image', 'create', '--project', $Project, '--input', (Join-Path $PSScriptRoot 'Image.yaml'))
    $null = InvokeCli -Arguments @('text', 'create', '--project', $Project, '--input', (Join-Path $PSScriptRoot 'Text.yaml'))
    $null = InvokeCli -Arguments @('line', 'create', '--project', $Project, '--input', (Join-Path $PSScriptRoot 'Line.yaml'))
    $null = InvokeCli -Arguments @('element', 'list', '--project', $Project)
    $null = InvokeCli -Arguments @('element', 'inspect', '--project', $Project, '--id', 'TextA')
    $null = InvokeCli -Arguments @('element', 'update', '--project', $Project, '--id', 'ImageA', '--x', '120', '--y', '80', '--width', '360', '--height', '240')
    $null = InvokeCli -Arguments @('text', 'update', '--project', $Project, '--input', (Join-Path $PSScriptRoot 'TextUpdate.json'))
    $null = InvokeCli -Arguments @('image', 'update', '--project', $Project, '--id', 'ImageA', '--source', (Join-Path $PSScriptRoot 'Replacement.svg'))
    $null = InvokeCli -Arguments @('line', 'update', '--project', $Project, '--input', (Join-Path $PSScriptRoot 'LineUpdate.yaml'))
    $null = InvokeCli -Arguments @('line', 'update', '--project', $Project, '--input', (Join-Path $PSScriptRoot 'FreeLine.json'))
    $null = InvokeCli -Arguments @('element', 'update', '--project', $Project, '--id', 'LineA', '--x', '300', '--y', '320', '--width', '400', '--height', '200')

    # The exact alignment example: put TextA to the right of ImageA with a 24-unit gap.
    $Image = (InvokeCli -Arguments @('element', 'inspect', '--project', $Project, '--id', 'ImageA')).element
    $Text = (InvokeCli -Arguments @('element', 'inspect', '--project', $Project, '--id', 'TextA')).element
    $NextX = $Image.x + $Image.width + 24
    $NextY = $Image.y + ($Image.height - $Text.height) / 2
    $Invariant = [Globalization.CultureInfo]::InvariantCulture
    $null = InvokeCli -Arguments @('element', 'update', '--project', $Project, '--id', 'TextA', '--x', $NextX.ToString($Invariant), '--y', $NextY.ToString($Invariant))

    $Node = Join-Path $Repository 'Dependencies/Node/node.exe'
    $Direct = & $Node (Join-Path $PSScriptRoot 'DirectEdit.cjs') $Project
    if ($LASTEXITCODE -ne 0) { throw 'Direct YAML example failed.' }
    $null = $Direct
    $null = InvokeCli -Arguments @('validate', '--project', $Project)
    $Inspection = InvokeCli -Arguments @('project', 'inspect', '--project', $Project)
    if ($Inspection.elements.Count -ne 3) { throw 'Expected three elements.' }
    if ([IO.File]::ReadAllText($Project) -cne $IndexBefore) { throw 'Element commands unexpectedly modified the project index.' }
    if (-not $Keep) {
        $null = InvokeCli -Arguments @('project', 'delete', '--project', $Project)
        if (Test-Path -LiteralPath $Project) { throw 'Project deletion failed.' }
    }
    [ordered]@{ ok = $true; project = $Project; kept = [bool]$Keep; examples = 'create, inspect, edit, replace, bind, detach, resize, align, direct YAML, validate, delete unless Keep'; elements = $Inspection.elements } | ConvertTo-Json -Depth 12
} finally {
    if (-not $Keep) {
        try {
            # Also clean an interrupted example, but only after this run created it.
            if ($Project -and (Test-Path -LiteralPath $Project)) {
                $null = InvokeCli -Arguments @('project', 'delete', '--project', $Project)
            }
            if ($AutomaticRoot -and (Test-Path -LiteralPath $Root)) {
                if ([IO.Path]::GetDirectoryName($Root) -ne [IO.Path]::GetFullPath($ExamplesRoot)) { throw 'Unexpected example cleanup path.' }
                [IO.Directory]::Delete($Root, $false) # Remove only the now-empty generated parent.
            }
        } catch { Write-Warning "Example cleanup failed; inspect $Root. $($_.Exception.Message)" }
    }
}
