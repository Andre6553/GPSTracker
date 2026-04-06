# Deploy patched lux-power-distribution-card.js to Home Assistant on the NUC and refresh Lovelace resource cache-busters.
# Prereqs: OpenSSH client, SSH key to the NUC (or ssh-agent), passwordless sudo for copying into /var/lib/homeassistant/...
#
# Defaults match docs/RUNBOOK.md — override with -Host / -User.
#
# Usage (from repo root):
#   pwsh home-assistant/scripts/deploy-lux-card-to-nuc.ps1
#   pwsh home-assistant/scripts/deploy-lux-card-to-nuc.ps1 -NucHost 192.168.10.173 -User andre

param(
    [string] $NucHost = "192.168.10.173",
    [string] $User = "andre",
    [string] $HaConfigRoot = "/var/lib/homeassistant/homeassistant",
    [string] $CardRelPath = "www/community/lux-power-distribution-card/lux-power-distribution-card.js"
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$localJs = Join-Path $repoRoot "home-assistant\www\lux-power-distribution-card.js"
$bustPy = Join-Path $repoRoot "home-assistant\scripts\bust-lux-resource-cache.py"

if (-not (Test-Path $localJs)) { throw "Missing $localJs" }
if (-not (Test-Path $bustPy)) { throw "Missing $bustPy" }

$remoteTmpJs = "/tmp/lux-power-distribution-card.js"
$remoteTmpPy = "/tmp/bust-lux-resource-cache.py"
$remoteDest = "$HaConfigRoot/$CardRelPath".Replace("\", "/")
$remoteStorage = "$HaConfigRoot/.storage/lovelace_resources"

$sshTarget = "${User}@${NucHost}"

# BatchMode=yes: fail fast if no SSH key (avoid hanging on password prompt).
# ConnectTimeout avoids indefinite hang if the NUC is offline.
$sshOpts = @("-o", "BatchMode=yes", "-o", "ConnectTimeout=15")

Write-Host "==> scp card -> ${sshTarget}:${remoteTmpJs}"
scp @sshOpts $localJs "${sshTarget}:${remoteTmpJs}"
if ($LASTEXITCODE -ne 0) { throw "scp card failed (exit $LASTEXITCODE). Add an SSH key for $sshTarget or run scp/ssh manually." }

Write-Host "==> scp bust script -> ${sshTarget}:${remoteTmpPy}"
scp @sshOpts $bustPy "${sshTarget}:${remoteTmpPy}"
if ($LASTEXITCODE -ne 0) { throw "scp bust script failed (exit $LASTEXITCODE)." }

$remoteShell = @"
set -e
sudo cp '$remoteTmpJs' '$remoteDest'
sudo chmod 644 '$remoteDest' || true
# If HACS shipped a .gz, refresh it so browsers do not keep loading stale gzip.
if [ -f '${remoteDest}.gz' ]; then
  sudo gzip -9 -c '$remoteDest' | sudo tee '${remoteDest}.gz' > /dev/null
fi
sudo python3 '$remoteTmpPy' '$remoteStorage'
rm -f '$remoteTmpJs' '$remoteTmpPy'
echo OK: card installed at $remoteDest and bust script ran on lovelace_resources
"@

Write-Host "==> ssh: install card + gzip + bust cache"
ssh @sshOpts $sshTarget $remoteShell
if ($LASTEXITCODE -ne 0) { throw "remote install failed (exit $LASTEXITCODE). Check sudo without password for cp/python3 on the NUC." }

Write-Host ""
Write-Host "Done. Hard-refresh the HA dashboard (Ctrl+F5)."
