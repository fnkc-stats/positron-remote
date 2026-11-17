# One-time setup of Docker for FNKC Projects on Windows, without Docker Desktop: a small Alpine Linux
# distribution "fnkc" in WSL2 with Docker Engine inside. FNKC Projects starts it when a project
# runs on this computer and stops it after the last one.
#
#   powershell -ExecutionPolicy Bypass -File setup-wsl.ps1
#
# Enabling WSL itself needs administrator rights once and usually a restart; the script says when, and
# is then simply run again. Steps already done are skipped. To remove everything: wsl --unregister fnkc
[CmdletBinding()]
param(
  [string]$Distro = 'fnkc',
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'fnkc-wsl')
)
$ErrorActionPreference = 'Stop'

$AlpineVersion = '3.24.3'
$AlpineSha256 = 'f8e1cafba9b1b283b5d30d06f9885c8d2bc161ffe9083ade8e2e157813a53407'
$AlpineUrl = "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/alpine-minirootfs-$AlpineVersion-x86_64.tar.gz"

function Step($Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Note($Message) { Write-Host "    $Message" -ForegroundColor Yellow }
function Fail($Message) { Write-Host "Error: $Message" -ForegroundColor Red; exit 1 }

# wsl.exe writes UTF-16 unless told otherwise
$env:WSL_UTF8 = '1'
function Get-WslDistribution {
  $out = & wsl.exe --list --quiet 2>$null
  if ($LASTEXITCODE -ne 0) { return @() }
  return @($out | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ })
}
# One-line commands as root inside the distribution (no double quotes in them: they pass through Windows quoting)
function Invoke-Root($Command) {
  & wsl.exe -d $Distro -u root --exec sh -c $Command
  if ($LASTEXITCODE -ne 0) { Fail "failed inside WSL: $Command" }
}
function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# --- 1. WSL itself
& wsl.exe --status *> $null
if ($LASTEXITCODE -ne 0) {
  Step 'Enabling WSL (Windows Subsystem for Linux)'
  if (-not (Test-Admin)) { Fail 'enabling WSL needs administrator rights: run PowerShell as administrator and start this script again' }
  & wsl.exe --install --no-distribution
  if ($LASTEXITCODE -ne 0) { Fail 'wsl --install failed (is virtualization enabled in the BIOS/UEFI settings?)' }
  Note 'WSL is installed. Restart Windows, then run this script again (as a normal user).'
  exit 0
}
& wsl.exe --set-default-version 2 *> $null

# --- 2. The Alpine distribution
if ((Get-WslDistribution) -notcontains $Distro) {
  Step "Downloading Alpine Linux $AlpineVersion (4 MB)"
  $archive = Join-Path $env:TEMP "alpine-minirootfs-$AlpineVersion-x86_64.tar.gz"
  Invoke-WebRequest -Uri $AlpineUrl -OutFile $archive -UseBasicParsing
  if ((Get-FileHash -Algorithm SHA256 $archive).Hash.ToLower() -ne $AlpineSha256) {
    Remove-Item $archive
    Fail "checksum mismatch for $AlpineUrl"
  }
  Step "Creating the WSL distribution '$Distro' in $InstallDir"
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  & wsl.exe --import $Distro $InstallDir $archive --version 2
  if ($LASTEXITCODE -ne 0) { Fail 'wsl --import failed' }
  Remove-Item $archive
} else {
  Step "The WSL distribution '$Distro' already exists"
}

# --- 3. Docker Engine inside it
Step 'Installing Docker Engine inside it'
Invoke-Root 'apk add --no-cache docker >/dev/null'
# Keep Windows folders out of PATH inside the distribution; Docker is all it is for
Invoke-Root "printf '[interop]\nappendWindowsPath=false\n' > /etc/wsl.conf"
& wsl.exe --terminate $Distro *> $null

# --- 4. Check: start Docker the way FNKC Projects does, run a test container, stop it again
Step 'Checking that Docker works'
Start-Process -FilePath 'wsl.exe' -WindowStyle Hidden `
  -ArgumentList "-d $Distro -u root --exec sh -c `"exec dockerd > /var/log/dockerd.log 2>&1`""
$ready = $false
foreach ($i in 1..60) {
  & wsl.exe -d $Distro --exec docker info *> $null
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $ready) { Fail "Docker did not start; its log: wsl -d $Distro --exec cat /var/log/dockerd.log" }
& wsl.exe -d $Distro --exec docker run --rm hello-world | Select-String 'Hello from Docker' | Out-Host
if ($LASTEXITCODE -ne 0) { Fail 'the test container did not run' }
& wsl.exe --terminate $Distro *> $null

# --- 5. The rest FNKC Projects needs on Windows
Step 'Checking git and SSH'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Note 'git is missing: install Git for Windows (https://git-scm.com/download/win)' }
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) { Note 'ssh is missing: Settings -> Apps -> Optional features -> OpenSSH Client' }
$agent = Get-Service ssh-agent -ErrorAction SilentlyContinue
if (-not $agent) {
  Note 'the OpenSSH Authentication Agent service is missing (it comes with the OpenSSH Client)'
} elseif ($agent.StartType -eq 'Disabled' -or $agent.Status -ne 'Running') {
  if (Test-Admin) {
    Set-Service ssh-agent -StartupType Automatic
    Start-Service ssh-agent
    Step 'Enabled the SSH agent service'
  } else {
    Note 'the SSH agent is off; as administrator run: Set-Service ssh-agent -StartupType Automatic; Start-Service ssh-agent'
  }
}

Write-Host ''
Write-Host "Done. FNKC Projects will start Docker in WSL ('$Distro') when a project runs on this computer." -ForegroundColor Green
