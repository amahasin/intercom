# Adds or removes the Windows Firewall rules OfficeMesh needs: inbound UDP 47800
# (discovery beacons) and TCP 47801 (peer links), for this program, on Private and
# Domain networks only. Run elevated. Used by the installer, the uninstaller and the
# in-app "Fix" button; IT can also run it directly when pushing a silent install.
#
#   powershell -ExecutionPolicy Bypass -File firewall.ps1 -Action add -Program "C:\...\OfficeMesh.exe"

param(
  [ValidateSet('add', 'remove')]
  [string]$Action = 'add',
  [Parameter(Mandatory = $true)]
  [string]$Program,
  [int]$UdpPort = 47800,
  [int]$TcpPort = 47801
)

$ErrorActionPreference = 'Stop'
$Group = 'OfficeMesh'

# Remove only this program's OfficeMesh rules, so other installs (or a dev build) keep theirs.
Get-NetFirewallApplicationFilter -Program $Program -ErrorAction SilentlyContinue |
  Get-NetFirewallRule -ErrorAction SilentlyContinue |
  Where-Object { $_.Group -eq $Group } |
  Remove-NetFirewallRule

if ($Action -eq 'add') {
  New-NetFirewallRule -DisplayName 'OfficeMesh discovery (UDP)' -Group $Group -Direction Inbound `
    -Action Allow -Protocol UDP -LocalPort $UdpPort -Program $Program -Profile Private, Domain | Out-Null
  New-NetFirewallRule -DisplayName 'OfficeMesh peer link (TCP)' -Group $Group -Direction Inbound `
    -Action Allow -Protocol TCP -LocalPort $TcpPort -Program $Program -Profile Private, Domain | Out-Null
}
exit 0
