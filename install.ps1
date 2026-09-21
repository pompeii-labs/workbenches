[CmdletBinding()]
param(
    [string]$Version = $env:WORKBENCH_VERSION,
    [string]$BinDir = $env:WORKBENCH_INSTALL_DIR,
    [string]$Repository = $env:WORKBENCH_REPOSITORY
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $Version) { $Version = '0.1.0-alpha.6' }
if (-not $Repository) { $Repository = 'pompeii-labs/workbenches' }
if (-not $BinDir) {
    $base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $env:USERPROFILE }
    if (-not $base) { throw 'workbench installer: no installation directory; set WORKBENCH_INSTALL_DIR' }
    $BinDir = Join-Path $base 'Programs\Workbench\bin'
}

$architecture = switch ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) {
    'X64' { 'x64' }
    'Arm64' { 'arm64' }
    default { throw "workbench installer: unsupported architecture: $_" }
}
$target = "workbench-windows-$architecture"
$archiveName = "$target.tar.gz"
$downloadRoot = $env:WORKBENCH_DOWNLOAD_ROOT

if ($downloadRoot) {
    $baseUrl = $downloadRoot.TrimEnd('/')
} elseif ($Version -eq 'latest') {
    $baseUrl = "https://github.com/$Repository/releases/latest/download"
} else {
    $tag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
    $baseUrl = "https://github.com/$Repository/releases/download/$tag"
}

$temporary = Join-Path ([IO.Path]::GetTempPath()) "workbench-install-$([Guid]::NewGuid().ToString('N'))"
$archive = Join-Path $temporary $archiveName
$checksums = Join-Path $temporary 'checksums.txt'

function Receive-WorkbenchFile {
    param([string]$Url, [string]$Destination)
    $uri = [Uri]$Url
    if ($uri.Scheme -eq 'https') {
        Invoke-WebRequest -UseBasicParsing -Uri $uri -OutFile $Destination
        return
    }
    if ($env:WORKBENCH_ALLOW_INSECURE -eq '1' -and $uri.IsFile) {
        Copy-Item -LiteralPath $uri.LocalPath -Destination $Destination
        return
    }
    throw "workbench installer: refusing non-HTTPS download: $Url"
}

try {
    New-Item -ItemType Directory -Force -Path $temporary | Out-Null
    Receive-WorkbenchFile "$baseUrl/$archiveName" $archive
    Receive-WorkbenchFile "$baseUrl/checksums.txt" $checksums

    $expected = $null
    foreach ($line in Get-Content -LiteralPath $checksums) {
        if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$' -and $Matches[2] -eq $archiveName) {
            $expected = $Matches[1].ToLowerInvariant()
            break
        }
    }
    if (-not $expected) { throw "workbench installer: checksum is missing for $archiveName" }
    $stream = [IO.File]::OpenRead($archive)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = $hasher.ComputeHash($stream)
    } finally {
        $stream.Dispose()
        $hasher.Dispose()
    }
    $actual = [BitConverter]::ToString($hash).Replace('-', '').ToLowerInvariant()
    if ($actual -ne $expected) { throw "workbench installer: checksum verification failed for $archiveName" }

    & tar.exe -xzf $archive -C $temporary
    if ($LASTEXITCODE -ne 0) { throw 'workbench installer: could not extract the release archive' }
    $source = Join-Path $temporary "$target\workbench.exe"
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw 'workbench installer: release archive does not contain workbench.exe'
    }

    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    $temporaryBinary = Join-Path $BinDir ".workbench-$([Guid]::NewGuid().ToString('N')).exe"
    Copy-Item -LiteralPath $source -Destination $temporaryBinary
    Move-Item -Force -LiteralPath $temporaryBinary -Destination (Join-Path $BinDir 'workbench.exe')
    $alias = '@echo off' + "`r`n" + '"%~dp0workbench.exe" %*' + "`r`n"
    Set-Content -NoNewline -Encoding Ascii -LiteralPath (Join-Path $BinDir 'wb.cmd') -Value $alias

    Write-Output "Installed Workbench to $(Join-Path $BinDir 'workbench.exe')"
    if (-not (($env:PATH -split ';') -contains $BinDir)) {
        Write-Output "Add $BinDir to PATH to use workbench and wb."
    }
} finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath $temporary
}
