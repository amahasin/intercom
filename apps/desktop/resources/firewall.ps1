# Adds or removes the Windows Firewall rules OfficeMesh needs: inbound UDP 47800
# (discovery beacons) and TCP 47801 (peer links), for this program, and UDP and TCP
# 47802-47817 for the meeting relay's media worker (x64 builds), on Private and Domain
# networks only. Run elevated. Used by the installer, the uninstaller and the
# in-app "Fix" button; IT can also run it directly when pushing a silent install.
#
#   powershell -ExecutionPolicy Bypass -File firewall.ps1 -Action add -Program "C:\...\OfficeMesh.exe"

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
$Group = 'OfficeMesh'

# 'check' needs no elevation: exit 0 if this program's rules exist, 1 if not. The installer
# uses it so an update (rules already there) never asks for administrator approval.
if ($Action -eq 'check') {
  $rules = @(Get-NetFirewallApplicationFilter -Program $Program -ErrorAction SilentlyContinue |
    Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Group -eq $Group })
  if ($rules.Count -ge 2) { exit 0 } else { exit 1 }
}

# Remove only this program's OfficeMesh rules, so other installs (or a dev build) keep theirs.
Get-NetFirewallApplicationFilter -Program $Program -ErrorAction SilentlyContinue |
  Get-NetFirewallRule -ErrorAction SilentlyContinue |
  Where-Object { $_.Group -eq $Group } |
  Remove-NetFirewallRule
if ($RelayWorker) {
  Get-NetFirewallApplicationFilter -Program $RelayWorker -ErrorAction SilentlyContinue |
    Get-NetFirewallRule -ErrorAction SilentlyContinue |
    Where-Object { $_.Group -eq $Group } |
    Remove-NetFirewallRule
}

if ($Action -eq 'add') {
  New-NetFirewallRule -DisplayName 'OfficeMesh discovery (UDP)' -Group $Group -Direction Inbound `
    -Action Allow -Protocol UDP -LocalPort $UdpPort -Program $Program -Profile Private, Domain | Out-Null
  New-NetFirewallRule -DisplayName 'OfficeMesh peer link (TCP)' -Group $Group -Direction Inbound `
    -Action Allow -Protocol TCP -LocalPort $TcpPort -Program $Program -Profile Private, Domain | Out-Null
  if ($RelayWorker -and (Test-Path -LiteralPath $RelayWorker)) {
    New-NetFirewallRule -DisplayName 'OfficeMesh meeting relay (UDP)' -Group $Group -Direction Inbound `
      -Action Allow -Protocol UDP -LocalPort $RelayPorts -Program $RelayWorker -Profile Private, Domain | Out-Null
    New-NetFirewallRule -DisplayName 'OfficeMesh meeting relay (TCP)' -Group $Group -Direction Inbound `
      -Action Allow -Protocol TCP -LocalPort $RelayPorts -Program $RelayWorker -Profile Private, Domain | Out-Null
  }
}
exit 0
