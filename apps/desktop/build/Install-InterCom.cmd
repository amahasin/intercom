@echo off
rem Installs InterCom from the folder this file is in, without Windows SmartScreen's
rem "Windows protected your PC" warning. The installers are not code-signed, so a copy that
rem came by download, chat or e-mail carries a "from another computer" mark; this removes it from
rem the installer next to this file (and only that file) and then starts it.
rem Double-click it. It picks the installer for this PC (x64 or ARM64) and the newest version.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' };" ^
  "$found = Get-ChildItem -LiteralPath '%~dp0' -Filter ('InterCom-Setup-*-' + $arch + '.exe') | Sort-Object { [version]($_.Name -replace '^InterCom-Setup-(\d+\.\d+\.\d+)-.*$', '$1') } | Select-Object -Last 1;" ^
  "if (-not $found) { Write-Host 'No InterCom installer for this PC was found next to this file.'; exit 1 };" ^
  "Unblock-File -LiteralPath $found.FullName;" ^
  "Start-Process -FilePath $found.FullName"
if errorlevel 1 pause
endlocal
