# Bharti Enterprises - office PC installer
#
# ONE LINE, typed into PowerShell on the office PC (it asks for admin by itself):
#
#   irm https://github.com/iodex99/bharti-releases/releases/latest/download/install.ps1 | iex
#
# NO INTERNET at the office: put install.cmd, install.ps1 and bharti-app-v*.zip in one
# folder (a USB stick is fine) and double-click install.cmd.
#
# Running it again is safe and is also how to repair or manually update: it installs the
# newest release over the top. C:\bharti\data - the business itself - is never touched.
#
# Two rules this file must keep (server/tests/unit/installer-script.test.ts checks both):
#  - PURE ASCII. `irm | iex` hands this file to PowerShell as a string, and Windows
#    PowerShell 5.1 mangles any non-ASCII character on the way.
#  - NEVER `exit`. Under `iex` it runs inside the user's own PowerShell window, and exit
#    would close that window, error message and all. Use return.

param(
  [string]$Root = 'C:\bharti',
  [int]$Port = 8787,
  # Public releases feed (ADR-042) - no credentials needed.
  [string]$Repo = 'iodex99/bharti-releases',
  # Only if you keep releases in a PRIVATE repo.
  [string]$GithubToken = '',
  # A release zip you already have. Without it: a bharti-app-v*.zip next to this script,
  # otherwise the latest release is downloaded.
  [string]$ZipPath = '',
  # Keep the window open at the end (used when the installer opens its own window).
  [switch]$PauseAtEnd
)

# Captured here, at the top level: inside the block below these describe the block.
$selfPath = $MyInvocation.MyCommand.Path
if ($selfPath -and ((Split-Path $selfPath -Leaf) -ne 'install.ps1')) { $selfPath = $null }

# Everything runs inside a script block so that, under `irm | iex`, no variable or
# preference leaks into the user's session and `return` ends the install cleanly.
& {
  $ErrorActionPreference = 'Stop'
  # The progress bar makes Invoke-WebRequest roughly ten times slower in PowerShell 5.1.
  $ProgressPreference = 'SilentlyContinue'
  # GitHub only speaks TLS 1.2+; older Windows 10 builds do not offer it by default.
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $installUrl = "https://github.com/$Repo/releases/latest/download/install.ps1"
  $here = if ($selfPath) { Split-Path $selfPath -Parent } else { $null }

  function Step($msg) { Write-Host ''; Write-Host "[$msg]" -ForegroundColor Cyan }
  function Say($msg) { Write-Host "  $msg" }

  function Finish {
    if ($PauseAtEnd) { Write-Host ''; [void](Read-Host 'Press Enter to close this window') }
  }

  # Stops the service AND anything still running out of the install folder. A running
  # copy holds node.exe and the service wrapper open, and Windows will not replace them.
  function Stop-App {
    $s = Get-Service bharti-app -ErrorAction SilentlyContinue
    if ($s -and $s.Status -ne 'Stopped') { Stop-Service bharti-app -Force }
    $prefix = $Root.TrimEnd('\') + '\'
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
  }

  # Deletes a folder however deep it goes. Remove-Item in PowerShell 5.1 gives up past
  # 260 characters, and node_modules gets close; rd understands the \\?\ long-path prefix.
  function Remove-Tree($path) {
    if ($path -and (Test-Path -LiteralPath $path)) {
      cmd.exe /d /c "rd /s /q `"\\?\$path`"" 2>$null | Out-Null
    }
  }

  # ------------------------------------------------------------ administrator rights
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $isAdmin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)

  if (-not $isAdmin) {
    # Re-open ourselves elevated. From `irm | iex` there is no file to re-open, so fetch
    # a copy of this same script first.
    $script = $selfPath
    if (-not $script) {
      $script = Join-Path $env:TEMP 'bharti-install.ps1'
      try {
        Invoke-WebRequest $installUrl -OutFile $script -UseBasicParsing
      } catch {
        Write-Host ''
        Write-Host "Could not download the installer from $installUrl" -ForegroundColor Red
        Write-Host 'Check that this PC is online. If it is, no release has been published yet.' -ForegroundColor Red
        return
      }
    }
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$script`"",
                 '-PauseAtEnd', '-Root', "`"$Root`"", '-Port', $Port, '-Repo', $Repo)
    if ($ZipPath) { $argList += @('-ZipPath', "`"$((Resolve-Path $ZipPath).Path)`"") }
    if ($GithubToken) { $argList += @('-GithubToken', $GithubToken) }

    Write-Host ''
    Write-Host 'Windows will now ask for administrator permission - choose Yes.' -ForegroundColor Yellow
    Write-Host 'The install continues in a new window.'
    try {
      Start-Process powershell.exe -Verb RunAs -ArgumentList $argList -Wait
    } catch {
      Write-Host 'Administrator permission was not given, so nothing was installed.' -ForegroundColor Red
    }
    return
  }

  $stage = $null
  $aside = $null
  $target = $null
  # Which version was active before we started, so a failed upgrade can go back to it.
  $prevCurrent = $null
  $currentFile = Join-Path $Root 'current.txt'
  if (Test-Path $currentFile) { $prevCurrent = [IO.File]::ReadAllText($currentFile) }
  $swapped = $false
  $dbBackup = $null
  # No database yet = first install. Only then is the first-run password worth showing;
  # on a re-run it has almost certainly been changed, and printing it would mislead.
  $freshInstall = -not (Test-Path (Join-Path $Root 'data\app.db'))
  try {
    Write-Host ''
    Write-Host 'Bharti Enterprises - installing on this PC' -ForegroundColor Green

    foreach ($d in 'supervisor', 'releases', 'data', 'logs', 'service', 'node', 'tmp') {
      New-Item -ItemType Directory -Force (Join-Path $Root $d) | Out-Null
    }

    # ---------------------------------------------------------- 1. get the release
    Step 'Getting the application'
    # Unpacked under the install folder, not %TEMP%: a short path keeps node_modules well
    # inside Windows' 260-character limit, and the same drive makes the final move an
    # instant rename.
    $stage = Join-Path $Root ('tmp\stage-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Force $stage | Out-Null
    $tempZip = $null

    if (-not $ZipPath -and $here) {
      # Offline install: the zip sits next to install.ps1. Prefer the highest version.
      $found = Get-ChildItem $here -Filter 'bharti-app-v*.zip' -ErrorAction SilentlyContinue |
        Sort-Object { try { [version]($_.BaseName -replace '^bharti-app-v', '') } catch { [version]'0.0' } } -Descending |
        Select-Object -First 1
      if ($found) { $ZipPath = $found.FullName }
    }

    if ($ZipPath) {
      if (-not (Test-Path $ZipPath)) { throw "Zip not found: $ZipPath" }
      $zip = (Resolve-Path $ZipPath).Path
      Say "using $zip"
    } else {
      $headers = @{ 'User-Agent' = 'bharti-installer' }
      if ($GithubToken) { $headers['Authorization'] = "Bearer $GithubToken" }
      Say "asking $Repo for the latest version..."
      try {
        $rel = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -Headers $headers
      } catch {
        throw "Could not read the release feed ($Repo). Is this PC online? If it is, no release has been published there yet. ($($_.Exception.Message))"
      }
      # The feed is shared with the (dormant) Android line - take OUR asset.
      $asset = $rel.assets | Where-Object { $_.name -like 'bharti-app-v*.zip' } | Select-Object -First 1
      if (-not $asset) { throw "Release $($rel.tag_name) has no bharti-app-v*.zip in it." }
      $sums = $rel.assets | Where-Object { $_.name -eq 'checksums.txt' } | Select-Object -First 1

      $tempZip = Join-Path $env:TEMP $asset.name
      $dl = $headers.Clone()
      if ($GithubToken) { $dl['Accept'] = 'application/octet-stream'; $url = $asset.url }
      else { $url = $asset.browser_download_url }
      Say "downloading $($asset.name) ($([math]::Round($asset.size / 1MB)) MB) - this can take a few minutes..."
      Invoke-WebRequest $url -OutFile $tempZip -Headers $dl -UseBasicParsing

      if ($sums) {
        if ($GithubToken) { $sumUrl = $sums.url } else { $sumUrl = $sums.browser_download_url }
        # Save to a file and read it back: for an octet-stream download, Windows PowerShell
        # 5.1 hands .Content back as a byte array, and [string] of that is "50 56 100 ..."
        # - which then never contains the file name.
        $sumFile = Join-Path $env:TEMP 'bharti-checksums.txt'
        Invoke-WebRequest $sumUrl -OutFile $sumFile -Headers $dl -UseBasicParsing
        $sumText = [IO.File]::ReadAllText($sumFile)
        Remove-Item $sumFile -Force -ErrorAction SilentlyContinue
        $line = ($sumText -split "`n") | Where-Object { $_ -match [regex]::Escape($asset.name) } | Select-Object -First 1
        $expected = if ($line) { ($line.Trim() -split '\s+')[0].ToLower() } else { $null }
        $actual = (Get-FileHash $tempZip -Algorithm SHA256).Hash.ToLower()
        if (-not $expected) { throw "checksums.txt does not list $($asset.name)." }
        if ($expected -ne $actual) { throw 'The download is corrupted (checksum mismatch). Run the installer again.' }
        Say 'download verified'
      }
      $zip = $tempZip
    }

    # Windows' own tar (bsdtar) reads zips. Explicit path: PATH may point at Git's GNU tar,
    # which cannot.
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (-not (Test-Path $tar)) { throw 'This Windows is too old (no tar.exe). Windows 10 version 1803 or later is required.' }
    & $tar -xf $zip -C $stage
    if ($LASTEXITCODE -ne 0) { throw "Could not unpack $zip" }

    # The version comes from the release itself, so releases\<version> and current.txt
    # can never disagree - whatever the zip happens to be called.
    $versionFile = Join-Path $stage 'version.json'
    if (-not (Test-Path $versionFile)) { throw 'That zip is not a Bharti release (no version.json in it).' }
    $version = 'v' + ((Get-Content $versionFile -Raw | ConvertFrom-Json).version)
    foreach ($need in 'server\dist\index.js', 'node\node.exe', 'supervisor\supervisor.cjs',
                      'service\WinSW.exe', 'service\bharti-service.xml') {
      if (-not (Test-Path (Join-Path $stage $need))) {
        throw "That release is incomplete or too old for this installer ($need is missing)."
      }
    }
    Say "version $version"

    # ---------------------------------------------------------- 2. stop the old copy
    # Everything up to here happened while the old copy kept serving; downtime starts now.
    if (Get-Service bharti-app -ErrorAction SilentlyContinue) {
      Step 'Stopping the running copy'
      Stop-App
      Say 'stopped'
    }

    # A new version migrates the database when it first starts, so copy it first - the
    # same safety copy the supervisor takes before every automatic update, named the same
    # way so it appears on the app's Backups screen. Taken with the app stopped, so the
    # database and its WAL file agree.
    $dbBackup = $null
    if (-not $freshInstall) {
      $tag = "install-$version-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
      $dbBackup = Join-Path $Root "data\backups\pre-update-$tag"
      New-Item -ItemType Directory -Force $dbBackup | Out-Null
      foreach ($n in 'app.db', 'app.db-wal', 'app.db-shm') {
        $src = Join-Path $Root "data\$n"
        if (Test-Path $src) { Copy-Item $src (Join-Path $dbBackup $n) }
      }
      Say "database backed up (data\backups\pre-update-$tag)"
    }

    # ---------------------------------------------------------- 3. put files in place
    Step "Installing into $Root"
    $target = Join-Path $Root "releases\$version"
    if (Test-Path $target) {
      # Re-installing a version that is already here - quite possibly the one that was
      # running a moment ago. Never delete it in place: if anything below fails, it is
      # moved back and started again (see catch), so the office is never left without one.
      $aside = Join-Path $Root ('tmp\replaced-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
      Move-Item $target $aside
    }
    Move-Item $stage $target
    $stage = $null
    $swapped = $true
    if ($tempZip) { Remove-Item $tempZip -Force -ErrorAction SilentlyContinue }

    # The supervisor and its Node are installed once at the root and never auto-updated;
    # each release then runs with the Node it shipped (ADR-044).
    Copy-Item (Join-Path $target 'supervisor\supervisor.cjs') (Join-Path $Root 'supervisor\supervisor.cjs') -Force
    Copy-Item (Join-Path $target 'node\node.exe') (Join-Path $Root 'node\node.exe') -Force
    # WinSW finds its config by its OWN file name, in its own folder.
    Copy-Item (Join-Path $target 'service\WinSW.exe') (Join-Path $Root 'service\bharti-service.exe') -Force
    Copy-Item (Join-Path $target 'service\bharti-service.xml') (Join-Path $Root 'service\bharti-service.xml') -Force

    # Keep whatever a previous install configured; fill in only what we know.
    $cfgFile = Join-Path $Root 'supervisor\config.json'
    $cfg = [ordered]@{}
    if (Test-Path $cfgFile) {
      try {
        (Get-Content $cfgFile -Raw | ConvertFrom-Json).PSObject.Properties |
          ForEach-Object { $cfg[$_.Name] = $_.Value }
      } catch { $cfg = [ordered]@{} }
    }
    $cfg['port'] = $Port
    $cfg['repo'] = $Repo
    if ($GithubToken) { $cfg['githubToken'] = $GithubToken }
    # ASCII, no BOM: the supervisor's JSON.parse must not trip over a byte-order mark.
    [IO.File]::WriteAllText($cfgFile, ($cfg | ConvertTo-Json), [Text.Encoding]::ASCII)

    [IO.File]::WriteAllText((Join-Path $Root 'current.txt'), "$version`r`n", [Text.Encoding]::ASCII)
    Say "Node $(& (Join-Path $Root 'node\node.exe') --version) (shipped with the release)"

    # ---------------------------------------------------------- 4. the Windows service
    Step 'Starting the service'
    $winsw = Join-Path $Root 'service\bharti-service.exe'
    if (-not (Get-Service bharti-app -ErrorAction SilentlyContinue)) {
      & $winsw install | Out-Null
      if (-not (Get-Service bharti-app -ErrorAction SilentlyContinue)) { throw 'The Windows service could not be registered.' }
      Say 'registered "Bharti Enterprises App" (starts with Windows)'
    }
    Start-Service bharti-app
    Say 'running'

    # A shortcut on everyone's desktop on this PC.
    $desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
    [IO.File]::WriteAllText((Join-Path $desktop 'Bharti Enterprises.url'),
      "[InternetShortcut]`r`nURL=http://localhost:$Port/`r`n", [Text.Encoding]::ASCII)

    # ---------------------------------------------------------- 5. prove it works
    Step 'Checking it answers'
    $ok = $false
    foreach ($i in 1..45) {
      Start-Sleep -Seconds 2
      try {
        $h = Invoke-RestMethod "http://localhost:$Port/api/system/health" -TimeoutSec 5
        if ($h.ok) { $ok = $true; break }
      } catch { }
    }
    if (-not $ok) {
      throw "The app did not answer on port $Port within 90 seconds. See $Root\logs\supervisor.log and $Root\logs\app.log"
    }

    Write-Host ''
    Write-Host '  ============================================================' -ForegroundColor Green
    # Only now that the new copy answers is the old one safe to throw away.
    Remove-Tree $aside
    $aside = $null

    Write-Host "   INSTALLED AND RUNNING  -  $version" -ForegroundColor Green
    Write-Host "   Open http://localhost:$Port  (shortcut on the desktop)" -ForegroundColor Green
    Write-Host '  ============================================================' -ForegroundColor Green

    $pw = Join-Path $Root 'data\initial-admin-password.txt'
    if ((Test-Path $pw) -and -not $freshInstall) {
      Write-Host ''
      Write-Host "  Reminder: delete $pw" -ForegroundColor Yellow
      Write-Host '  It holds the very first password, which is no longer in use.'
    } elseif (Test-Path $pw) {
      # The app writes this file as UTF-8; 5.1 would read it as ANSI and garble it.
      $note = (Get-Content $pw -Raw -Encoding UTF8).Trim()
      $user = if ($note -match 'username:\s*(\S+?),') { $Matches[1] } else { 'admin' }
      $pass = if ($note -match 'password:\s*(\S+)') { $Matches[1] } else { $null }
      Write-Host ''
      Write-Host '  FIRST SIGN-IN - write this down, you will set a new password straight away:' -ForegroundColor Yellow
      if ($pass) {
        Write-Host "    username:  $user" -ForegroundColor Yellow
        Write-Host "    password:  $pass" -ForegroundColor Yellow
      } else {
        Write-Host "    $note" -ForegroundColor Yellow
      }
      Write-Host "    (also saved in $pw - delete that file once you have signed in)"
    }
    Write-Host ''
    Write-Host "  The business data lives in $Root\data. That folder IS the business."
    Write-Host '  Updates install themselves once nobody has worked for a few minutes.'
    Write-Host '  Next: remote access for phones - see the install guide, Tailscale step.'
  } catch {
    Write-Host ''
    Write-Host '  INSTALL DID NOT FINISH' -ForegroundColor Red
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
    # The office must never be left without a working copy. Best effort only: nothing in
    # here may hide the message above.
    try {
      if ($swapped -and $null -ne $prevCurrent) {
        # We replaced a working install - put back exactly what was there: the release
        # folder, the active-version pointer and the database as it was before the new
        # version touched it. Restart unconditionally: a supervisor crash-looping on a bad
        # release still reports the service as Running.
        Stop-App
        Remove-Tree $target
        if ($aside -and (Test-Path $aside)) { Move-Item $aside $target }
        [IO.File]::WriteAllText($currentFile, $prevCurrent, [Text.Encoding]::ASCII)
        if ($dbBackup -and (Test-Path (Join-Path $dbBackup 'app.db'))) {
          foreach ($n in 'app.db', 'app.db-wal', 'app.db-shm') {
            Remove-Item (Join-Path $Root "data\$n") -Force -ErrorAction SilentlyContinue
            $src = Join-Path $dbBackup $n
            if (Test-Path $src) { Copy-Item $src (Join-Path $Root "data\$n") }
          }
        }
        Start-Service bharti-app
        Write-Host '  The version that was installed before has been put back and started again.' -ForegroundColor Yellow
        Write-Host '  Your data is exactly as it was.' -ForegroundColor Yellow
      } else {
        # Failed before anything was replaced: just make sure the old copy is running.
        $svc = Get-Service bharti-app -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -ne 'Running') {
          Start-Service bharti-app
          Write-Host '  The installed version has been started again.' -ForegroundColor Yellow
        }
        Write-Host '  Nothing in the data folder was changed.'
      }
    } catch { }
    Write-Host '  Fix the problem above and run the installer again.'
  } finally {
    Remove-Tree $stage
    # A failed run would otherwise leave the 70 MB download behind in %TEMP%.
    if ($tempZip -and (Test-Path $tempZip)) { Remove-Item $tempZip -Force -ErrorAction SilentlyContinue }
    Finish
  }
}
