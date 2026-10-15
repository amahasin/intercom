; Windows Firewall rules for discovery (UDP 47800), peer links (TCP 47801), the meeting
; relay worker (UDP/TCP 47802-47817, x64 builds) and the remote help helper (TCP, any port), added
; through one elevation prompt. If the user declines, the app still installs and shows a
; banner with a one-click fix. Silent installs (/S) skip this: IT runs firewall.ps1
; with their own tooling.

!macro customInstall
  ${IfNot} ${Silent}
    ; Rules already in place (an update): no elevation prompt at all.
    nsExec::Exec 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\resources\firewall.ps1" -Action check -Program "$INSTDIR\${APP_EXECUTABLE_FILENAME}" -AssistHelper "$INSTDIR\resources\intercom-assist.exe"'
    Pop $0
    StrCmp $0 "0" officemesh_rules_done
    ExecShellWait "runas" "powershell.exe" '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\resources\firewall.ps1" -Action add -Program "$INSTDIR\${APP_EXECUTABLE_FILENAME}" -RelayWorker "$INSTDIR\resources\relay\mediasoup-worker.exe" -AssistHelper "$INSTDIR\resources\intercom-assist.exe"' SW_HIDE
    officemesh_rules_done:
  ${EndIf}
!macroend

!macro customUnInstall
  ${IfNot} ${Silent}
    ExecShellWait "runas" "powershell.exe" '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\resources\firewall.ps1" -Action remove -Program "$INSTDIR\${APP_EXECUTABLE_FILENAME}" -RelayWorker "$INSTDIR\resources\relay\mediasoup-worker.exe" -AssistHelper "$INSTDIR\resources\intercom-assist.exe"' SW_HIDE
  ${EndIf}
!macroend
