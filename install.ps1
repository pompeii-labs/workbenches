param(
    [string]$Version = $(if ($env:WORKBENCH_VERSION) { $env:WORKBENCH_VERSION } else { 'latest' }),
    [string]$BinDir = $(if ($env:WORKBENCH_INSTALL_DIR) { $env:WORKBENCH_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Workbench\bin' }),
    [string]$Repository = 'pompeii-labs/workbenches'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Workbench requires 64-bit Windows.' }
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Invalid release repository.' }
$headers = @{ 'User-Agent' = 'workbench-installer'; Accept = 'application/vnd.github+json' }
if ($Version -eq 'latest') {
    $releases = Invoke-RestMethod "https://api.github.com/repos/$Repository/releases?per_page=100" -Headers $headers
    $latest = $releases | Where-Object {
        $_.draft -is [bool] -and $_.prerelease -is [bool] -and -not $_.draft -and -not $_.prerelease -and
        $_.published_at -is [string] -and $_.published_at -match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$' -and
        $_.tag_name -match '^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$'
    } | Sort-Object { [version]$_.tag_name.Substring(1) } -Descending | Select-Object -First 1
    if (-not $latest) { throw 'No stable Workbench release is available.' }
    $Version = $latest.tag_name
}
if ($Version -notmatch '^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$') { throw 'Invalid release version.' }
$tag = 'v' + $Version.TrimStart('v')
$name = 'workbench-windows-x64'
$archiveName = "$name.tar.gz"
$root = "https://github.com/$Repository/releases/download/$tag"
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('workbench-install-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
    $archive = Join-Path $temporary $archiveName
    Invoke-WebRequest "$root/$archiveName" -OutFile $archive -UseBasicParsing
    $checksums = (Invoke-WebRequest "$root/checksums.txt" -UseBasicParsing).Content
    $checksum = $checksums -split '\r?\n' | Where-Object { $_ -match ('^[a-fA-F0-9]{64}\s+\*?' + [regex]::Escape($archiveName) + '$') } | Select-Object -First 1
    if (-not $checksum) { throw "Checksum is missing for $archiveName." }
    $hasher = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($archive)
    try { $digest = ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '') }
    finally { $stream.Dispose(); $hasher.Dispose() }
    if ($digest -ne ($checksum -split '\s+')[0]) { throw 'Checksum verification failed.' }
    & tar.exe -xzf $archive -C $temporary "$name/workbench.exe" "$name/LICENSE" "$name/NOTICE"
    if ($LASTEXITCODE -ne 0) { throw 'Could not extract the Workbench release.' }
    $source = Join-Path $temporary "$name\workbench.exe"
    & $source --version
    if ($LASTEXITCODE -ne 0) { throw 'The downloaded Workbench executable could not start.' }
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    $installed = @()
    $token = [guid]::NewGuid().ToString()
    try {
        foreach ($file in @('workbench.exe', 'wb.exe', 'LICENSE', 'NOTICE')) {
            $destination = Join-Path $BinDir $file
            $staged = Join-Path $BinDir ('.workbench-install-' + $token + '-' + $file)
            $backup = Join-Path $BinDir ('.workbench-previous-' + $token + '-' + $file)
            $entry = @{ Destination = $destination; Staged = $staged; Backup = $backup; Moved = $false; Installed = $false }
            $installed += $entry
            $inputFile = if ($file -eq 'wb.exe') { $source } else { Join-Path $temporary "$name\$file" }
            Copy-Item -LiteralPath $inputFile -Destination $staged
            if (Test-Path -LiteralPath $destination) {
                Move-Item -LiteralPath $destination -Destination $backup
                $entry.Moved = $true
            }
            Move-Item -LiteralPath $staged -Destination $destination
            $entry.Installed = $true
        }
    } catch {
        $failure = $_
        [array]::Reverse($installed)
        foreach ($entry in $installed) {
            if ($entry.Installed) { Remove-Item -LiteralPath $entry.Destination -Force }
            if ($entry.Moved) { Move-Item -LiteralPath $entry.Backup -Destination $entry.Destination }
            if (Test-Path -LiteralPath $entry.Staged) { Remove-Item -LiteralPath $entry.Staged -Force }
        }
        throw $failure
    }
    foreach ($entry in $installed) {
        if ($entry.Moved) { Remove-Item -LiteralPath $entry.Backup -Force -ErrorAction SilentlyContinue }
    }
    Write-Host "Installed Workbench to $BinDir"
    Write-Host 'Add this directory to your user PATH to use wb and workbench in new terminals.'
} finally {
    $resolvedTemporary = [IO.Path]::GetFullPath($temporary)
    if (-not $resolvedTemporary.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe installer temporary directory.' }
    Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force
}
