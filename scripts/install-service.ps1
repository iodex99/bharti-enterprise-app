# Bharti Enterprises — office machine installer (run as Administrator)
#
# Installs the whole system in one command. Nothing needs to be installed first:
# the release carries its own Node runtime (ADR-044) and releases are public, so
# there is no token to create and nothing that expires later (ADR-042).
#
#   ONLINE  (normal):
#     powershell -ExecutionPolicy Bypass -File install-service.ps1
#
#   OFFLINE (no internet at the office — everything from a USB stick):
#     powershell -ExecutionPolicy Bypass -File install-service.ps1 `
#       -ZipPath E:\bharti-app-v1.0.0.zip -WinswPath E:\WinSW-x64.exe
#
# Re-running it is safe: it installs the newest release over the top and restarts the
# service. C:\bharti\data is never touched.

param(
  [string]$Root = 'C:\bharti',
  [int]$Port = 8787,
  # Public releases feed — no credentials needed.
  [string]$Repo = 'iodex99/bharti-releases',
  # Only needed if you kept releases in a PRIVATE repo.
  [string]$GithubToken = '',
  # Offline install: a release zip you already have.
  [string]$ZipPath = '',
  # Offline install: WinSW-x64.exe you already have.
  [string]$WinswPath = ''
)

$ErrorActionPreference = 'Stop'

function Say($msg) { Write-Host "  $msg" }
function Step($msg) { Write-Host ""; Write-Host "[$msg]" -ForegroundColor Cyan }

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this in an ELEVATED PowerShell (right-click > Run as administrator).'
}

$apiHeaders = @{ 'User-Agent' = 'bharti-installer' }
if ($GithubToken) { $apiHeaders['Authorization'] = "Bearer $GithubToken" }

# ---------------------------------------------------------------- 1. folders
Step 'Creating folders'
foreach ($d in 'supervisor', 'releases', 'data', 'logs', 'service', 'node') {
  New-Item -ItemType Directory -Force "$Root\$d" | Out-Null
}
Say "$Root"

# ---------------------------------------------------------------- 2. supervisor
Step 'Installing the supervisor'
$src = Join-Path $PSScriptRoot '..\supervisor\supervisor.cjs'
if (-not (Test-Path $src)) { $src = Join-Path $PSScriptRoot 'supervisor.cjs' }
if (-not (Test-Path $src)) { throw "supervisor.cjs not found next to this script or in ..\supervisor" }
Copy-Item $src "$Root\supervisor\supervisor.cjs" -Force

# Keep any settings a previous install already had; only fill in what we know.
$cfgFile = "$Root\supervisor\config.json"
$cfg = @{}
if (Test-Path $cfgFile) {
  try { (Get-Content $cfgFile -Raw | ConvertFrom-Json).PSObject.Properties |
          ForEach-Object { $cfg[$_.Name] = $_.Value } } catch { $cfg = @{} }
}
$cfg['port'] = $Port
$cfg['repo'] = $Repo
if ($GithubToken) { $cfg['githubToken'] = $GithubToken }
$cfg | ConvertTo-Json | Set-Content -Encoding utf8 $cfgFile
Say "config.json written (port $Port, feed $Repo)"

# ---------------------------------------------------------------- 3. the release
Step 'Getting the application'
$tempZip = $null
if ($ZipPath) {
  if (-not (Test-Path $ZipPath)) { throw "Zip not found: $ZipPath" }
  $zip = (Resolve-Path $ZipPath).Path
  Say "using $zip"
} else {
  Say "asking $Repo for the latest release..."
  $rel = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -Headers $apiHeaders
  # The releases feed is shared with the (dormant) Android line — take OUR asset.
  $asset = $rel.assets | Where-Object { $_.name -like 'bharti-app-v*.zip' } | Select-Object -First 1
  if (-not $asset) { throw "Release $($rel.tag_name) has no bharti-app-*.zip asset." }
  $tempZip = Join-Path $env:TEMP $asset.name
  $dl = $apiHeaders.Clone()
  if ($GithubToken) { $dl['Accept'] = 'application/octet-stream'; $url = $asset.url }
  else { $url = $asset.browser_download_url }
  Say "downloading $($asset.name) ($([math]::Round($asset.size / 1MB)) MB)..."
  Invoke-WebRequest $url -OutFile $tempZip -Headers $dl
  $zip = $tempZip
}

# Extract to a staging folder first: the version is read from the release itself, so a
# renamed zip can never produce a releases\<name> that disagrees with current.txt.
$stage = Join-Path $env:TEMP ("bharti-stage-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $stage | Out-Null
tar -xf $zip -C $stage
if ($LASTEXITCODE -ne 0) { throw "Could not extract $zip" }

$versionFile = Join-Path $stage 'version.json'
if (-not (Test-Path $versionFile)) { throw "That zip is not a Bharti release (no version.json)." }
$version = 'v' + ((Get-Content $versionFile -Raw | ConvertFrom-Json).version)
if (-not (Test-Path (Join-Path $stage 'server\dist\index.js'))) {
  throw "That zip is not a complete release (server\dist\index.js missing)."
}
Say "release $version"

$target = "$Root\releases\$version"
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
Move-Item $stage $target
if ($tempZip) { Remove-Item $tempZip -Force }

# ---------------------------------------------------------------- 4. node runtime
# The service runs the SUPERVISOR, which is never updated, so it needs a Node of its
# own at the root. Take the one this release shipped: it is the exact build the native
# modules were compiled against.
Step 'Installing the Node runtime'
$bundledNode = Join-Path $target 'node\node.exe'
if (Test-Path $bundledNode) {
  Copy-Item $bundledNode "$Root\node\node.exe" -Force
  Say "$( & "$Root\node\node.exe" --version ) (from the release — nothing to install)"
} elseif (Get-Command node -ErrorAction SilentlyContinue) {
  Copy-Item (Get-Command node).Source "$Root\node\node.exe" -Force
  Say "$( & "$Root\node\node.exe" --version ) (from this machine — release predates bundling)"
} else {
  throw 'This release does not bundle Node and none is installed. Install Node 24 LTS and re-run.'
}

Set-Content -Encoding ascii "$Root\current.txt" $version

# ---------------------------------------------------------------- 5. the service
Step 'Installing the Windows service'
$winswExe = "$Root\service\bharti-service.exe"
if ($WinswPath) {
  Copy-Item $WinswPath $winswExe -Force
} elseif (-not (Test-Path $winswExe)) {
  Say 'downloading WinSW...'
  $winsw = Invoke-RestMethod 'https://api.github.com/repos/winsw/winsw/releases/latest' `
    -Headers @{ 'User-Agent' = 'bharti-installer' }
  $wa = $winsw.assets | Where-Object { $_.name -eq 'WinSW-x64.exe' } | Select-Object -First 1
  Invoke-WebRequest $wa.browser_download_url -OutFile $winswExe `
    -Headers @{ 'User-Agent' = 'bharti-installer' }
}
Copy-Item (Join-Path $PSScriptRoot 'winsw\bharti-service.xml') "$Root\service\bharti-service.xml" -Force

$xml = "$Root\service\bharti-service.xml"
& $winswExe stop $xml 2>$null | Out-Null
& $winswExe uninstall $xml 2>$null | Out-Null
& $winswExe install $xml
& $winswExe start $xml
Say 'bharti-app installed and started'

# ---------------------------------------------------------------- 6. prove it works
Step 'Checking it answers'
$ok = $false
foreach ($i in 1..30) {
  Start-Sleep -Seconds 2
  try {
    $h = Invoke-RestMethod "http://localhost:$Port/api/system/health" -TimeoutSec 5
    if ($h.ok) { $ok = $true; break }
  } catch { }
}

Write-Host ''
if ($ok) {
  Write-Host "  Installed and running — $version" -ForegroundColor Green
  Write-Host "  Open  http://localhost:$Port" -ForegroundColor Green
  $pw = "$Root\data\initial-admin-password.txt"
  if (Test-Path $pw) {
    Write-Host ''
    Write-Host '  First sign-in (this file is created once — delete it afterwards):'
    Write-Host "    $pw"
    Write-Host "    $((Get-Content $pw -Raw).Trim())"
  }
  Write-Host ''
  Write-Host "  Business data lives in $Root\data — that folder IS the business. Back it up."
  Write-Host '  Updates install themselves once nobody has worked for a few minutes.'
  Write-Host '  Next: remote access with Tailscale — see docs/INSTALL_CLIENT.md.'
} else {
  Write-Warning "The service did not answer on port $Port within 60s."
  Write-Host "  Look at $Root\logs\supervisor.log and $Root\logs\app.log"
  exit 1
}
