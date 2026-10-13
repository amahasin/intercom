# Adds or removes the Windows Firewall rules InterCom needs: inbound UDP 47800
# (discovery beacons) and TCP 47801 (peer links), for this program, and UDP and TCP
# 47802-47817 for the meeting relay's media worker (x64 builds), on every network
# profile: Domain, Private and Public. InterCom is a LAN app, and many office networks
# are classed Public by Windows; nobody should have to reclassify their network to chat.
# Peers are authenticated (mutual TLS) and every message is signed, whatever the profile. Run elevated. Used by the installer, the uninstaller and the
# in-app "Fix" button; IT can also run it directly when pushing a silent install.
#
#   powershell -ExecutionPolicy Bypass -File firewall.ps1 -Action add -Program "C:\...\InterCom.exe"

param(
  [ValidateSet('add', 'remove', 'check')]
  [string]$Action = 'add',
  [Parameter(Mandatory = $true)]
  [string]$Program,
  [int]$UdpPort = 47800,
  [int]$TcpPort = 47801,
  # The media relay worker (mediasoup-worker.exe) that hosts large meetings; optional.
  [string]$RelayWorker = '',
  [string]$RelayPorts = '47802-47817'
)

$ErrorActionPreference = 'Stop'
$Group = 'InterCom'
# Rules written by OfficeMesh, this app's old name; removed along with the new ones.
$LegacyGroup = 'OfficeMesh'

# 'check' needs no elevation: exit 0 if this program's rules exist and cover every network
# profile, 1 if not (an install from before Public networks were covered gets re-added).
# The installer uses it so an update with rules already there never asks for an administrator.
if ($Action -eq 'check') {
  $rules = @(Get-NetFirewallApplicationFilter -Program $Program -ErrorAction SilentlyContinue |
    Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Group -eq $Group })
  $anyProfile = @($rules | Where-Object { ([string]$_.Profile) -match 'Any' })
  if ($rules.Count -ge 2 -and $anyProfile.Count -ge 2) { exit 0 } else { exit 1 }
}

# Remove only this program's InterCom rules, so other installs (or a dev build) keep theirs.
Get-NetFirewallApplicationFilter -Program $Program -ErrorAction SilentlyContinue |
  Get-NetFirewallRule -ErrorAction SilentlyContinue |
  Where-Object { $_.Group -eq $Group -or $_.Group -eq $LegacyGroup } |
  Remove-NetFirewallRule
if ($RelayWorker) {
  Get-NetFirewallApplicationFilter -Program $RelayWorker -ErrorAction SilentlyContinue |
    Get-NetFirewallRule -ErrorAction SilentlyContinue |
    Where-Object { $_.Group -eq $Group -or $_.Group -eq $LegacyGroup } |
    Remove-NetFirewallRule
}

if ($Action -eq 'add') {
  New-NetFirewallRule -DisplayName 'InterCom discovery (UDP)' -Group $Group -Direction Inbound `
    -Action Allow -Protocol UDP -LocalPort $UdpPort -Program $Program -Profile Any | Out-Null
  New-NetFirewallRule -DisplayName 'InterCom peer link (TCP)' -Group $Group -Direction Inbound `
    -Action Allow -Protocol TCP -LocalPort $TcpPort -Program $Program -Profile Any | Out-Null
  if ($RelayWorker -and (Test-Path -LiteralPath $RelayWorker)) {
    New-NetFirewallRule -DisplayName 'InterCom meeting relay (UDP)' -Group $Group -Direction Inbound `
      -Action Allow -Protocol UDP -LocalPort $RelayPorts -Program $RelayWorker -Profile Any | Out-Null
    New-NetFirewallRule -DisplayName 'InterCom meeting relay (TCP)' -Group $Group -Direction Inbound `
      -Action Allow -Protocol TCP -LocalPort $RelayPorts -Program $RelayWorker -Profile Any | Out-Null
  }
}
exit 0
