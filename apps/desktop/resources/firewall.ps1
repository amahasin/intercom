# Adds or removes the Windows Firewall rules InterCom needs: inbound UDP 47800
# (discovery beacons) and TCP 47801 (peer links), for this program, UDP and TCP
# 47802-47817 for the meeting relay's media worker (x64 builds), and inbound TCP on any port
# for the remote help helper (intercom-assist.exe: Windows gives it its own port for each
# session, so the rule is for the program), on every network
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
  [string]$RelayPorts = '47802-47817',
  # The remote help helper (intercom-assist.exe) that shares a desktop with a colleague; optional.
  [string]$AssistHelper = ''
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
  if (-not ($rules.Count -ge 2 -and $anyProfile.Count -ge 2)) { exit 1 }
  if ($AssistHelper -and (Test-Path -LiteralPath $AssistHelper)) {
    $helper = @(Get-NetFirewallApplicationFilter -Program $AssistHelper -ErrorAction SilentlyContinue |
      Get-NetFirewallRule -ErrorAction SilentlyContinue |
      Where-Object { $_.Group -eq $Group -and ([string]$_.Profile) -match 'Any' })
    if ($helper.Count -lt 1) { exit 1 }
  }
  exit 0
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
if ($AssistHelper) {
  Get-NetFirewallApplicationFilter -Program $AssistHelper -ErrorAction SilentlyContinue |
    Get-NetFirewallRule -ErrorAction SilentlyContinue |
    Where-Object { $_.Group -eq $Group } |
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
  if ($AssistHelper -and (Test-Path -LiteralPath $AssistHelper)) {
    # Remote help: the helper listens, for a colleague who was let in, on a port Windows picks.
    New-NetFirewallRule -DisplayName 'InterCom remote help (TCP)' -Group $Group -Direction Inbound `
      -Action Allow -Protocol TCP -Program $AssistHelper -Profile Any | Out-Null
  }
}
exit 0
