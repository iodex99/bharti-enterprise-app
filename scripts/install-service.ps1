# Bharti Enterprises — office machine installer (run as Administrator)
#
# Sets up C:\bharti with the supervisor + WinSW service, downloads the latest
# release zip from GitHub, and starts the service.
#
#   powershell -ExecutionPolicy Bypass -File install-service.ps1 [-Root C:\bharti] [-Port 8787]

param(
  [string]$Root = 'C:\bharti',
  [int]$Port = 8787,
  [string]$Repo = 'iodex99/bharti-enterprise-app',
  # Fine-grained PAT with "Contents: read" on the repo — required while the repo is PRIVATE.
  [string]$GithubToken = ''
)

$ErrorActionPreference = 'Stop'
$apiHeaders = @{ 'User-Agent' = 'bharti-installer' }
if ($GithubToken) { $apiHeaders['Authorization'] = "Bearer $GithubToken" }

# 0. prerequisites
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 24 is required. Install from https://nodejs.org (LTS) and re-run.' }
$major = [int]((node --version).TrimStart('v').Split('.')[0])
if ($major -ne 24) { Write-Warning "Node major version is $major; releases are built for Node 24. Install Node 24 LTS." }

# 1. directory scaffold
New-Item -ItemType Directory -Force "$Root\supervisor" | Out-Null
New-Item -ItemType Directory -Force "$Root\releases"   | Out-Null
New-Item -ItemType Directory -Force "$Root\data"       | Out-Null
New-Item -ItemType Directory -Force "$Root\logs"       | Out-Null
New-Item -ItemType Directory -Force "$Root\service"    | Out-Null

# 2. supervisor (from this script's repo checkout or alongside the script)
$src = Join-Path $PSScriptRoot '..\supervisor\supervisor.cjs'
if (-not (Test-Path $src)) { $src = Join-Path $PSScriptRoot 'supervisor.cjs' }
Copy-Item $src "$Root\supervisor\supervisor.cjs" -Force
@{ port = $Port; repo = $Repo; githubToken = $GithubToken } | ConvertTo-Json |
  Set-Content -Encoding utf8 "$Root\supervisor\config.json"

# 3. first release: download latest from GitHub
Write-Host "Fetching latest release from $Repo…"
$rel = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -Headers $apiHeaders
$zipAsset = $rel.assets | Where-Object { $_.name -like '*.zip' } | Select-Object -First 1
if (-not $zipAsset) { throw "Latest release has no zip asset." }
$version = $rel.tag_name
$zipPath = "$env:TEMP\$($zipAsset.name)"
# Private repos need the API asset URL + octet-stream Accept header.
$dlHeaders = $apiHeaders.Clone(); $dlHeaders['Accept'] = 'application/octet-stream'
Invoke-WebRequest $zipAsset.url -OutFile $zipPath -Headers $dlHeaders
$target = "$Root\releases\$version"
New-Item -ItemType Directory -Force $target | Out-Null
tar -xf $zipPath -C $target
Set-Content -Encoding ascii "$Root\current.txt" $version
Remove-Item $zipPath -Force

# 4. WinSW service wrapping the supervisor
$winswExe = "$Root\service\bharti-service.exe"
if (-not (Test-Path $winswExe)) {
  Write-Host 'Downloading WinSW…'
  $winsw = Invoke-RestMethod 'https://api.github.com/repos/winsw/winsw/releases/latest' -Headers @{ 'User-Agent' = 'bharti-installer' }
  $asset = $winsw.assets | Where-Object { $_.name -eq 'WinSW-x64.exe' } | Select-Object -First 1
  Invoke-WebRequest $asset.browser_download_url -OutFile $winswExe -Headers @{ 'User-Agent' = 'bharti-installer' }
}
Copy-Item (Join-Path $PSScriptRoot 'winsw\bharti-service.xml') "$Root\service\bharti-service.xml" -Force

& $winswExe stop "$Root\service\bharti-service.xml" 2>$null
& $winswExe uninstall "$Root\service\bharti-service.xml" 2>$null
& $winswExe install "$Root\service\bharti-service.xml"
& $winswExe start "$Root\service\bharti-service.xml"

Write-Host ''
Write-Host "Installed. App: http://localhost:$Port  (version $version)"
Write-Host "Data lives in $Root\data — back that folder up."
Write-Host 'Next: set up Cloudflare Tunnel for remote access (see docs/DEPLOYMENT.md).'
