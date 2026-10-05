; Windows Firewall rules for discovery (UDP 47800) and peer links (TCP 47801), added
; through one elevation prompt. If the user declines, the app still installs and shows a
; banner with a one-click fix. Silent installs (/S) skip this: IT runs firewall.ps1
; with their own tooling.

!macro customInstall
  ${IfNot} ${Silent}
    ExecShellWait "runas" "powershell.exe" '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\resources\firewall.ps1" -Action add -Program "$INSTDIR\${APP_EXECUTABLE_FILENAME}"' SW_HIDE
  ${EndIf}
!macroend

!macro customUnInstall
  ${IfNot} ${Silent}
    ExecShellWait "runas" "powershell.exe" '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\resources\firewall.ps1" -Action remove -Program "$INSTDIR\${APP_EXECUTABLE_FILENAME}"' SW_HIDE
  ${EndIf}
!macroend
