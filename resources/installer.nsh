; EastGenesis's uninstaller must never delete application files from a direct
; double-click without an explicit user decision. Silent invocations remain
; available for controlled update/recovery flows and are not interactive.
!macro customUnInit
  ${IfNot} ${Silent}
    MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 "EastGenesis will be uninstalled. User data is preserved. Continue?" IDYES +2
    Abort
  ${EndIf}
!macroend

; electron-builder only uses this rollback-capable removal path for upgrades.
; Apply it to direct uninstall as well so one locked file cannot leave a
; half-deleted application directory behind.
!macro customRemoveFiles
  CreateDirectory "$PLUGINSDIR\old-install"

  Push ""
  Call un.atomicRMDir
  Pop $R0

  ${If} $R0 != 0
    DetailPrint "File is busy, restoring the existing EastGenesis installation: $R0"
    Push ""
    Call un.restoreFiles
    Pop $R1
    Abort "EastGenesis uninstall was cancelled because an application file is still in use."
  ${EndIf}

  ; The uninstaller is locked while this macro runs. Only schedule the
  ; external cleanup after the atomic move succeeds, so an aborted removal
  ; cannot leave a helper racing with file restoration.
  System::Call 'kernel32::GetCurrentProcess() i.R4'
  System::Call 'kernel32::GetProcessId(i R4) i.R4'
  SetOutPath $TEMP
  ; atomicRMDir moves files into the rollback directory but intentionally
  ; leaves the empty directory tree behind. Restore electron-builder's
  ; in-process tree removal before scheduling the post-exit retry helper.
  RMDir /r "$INSTDIR"
  GetTempFileName $R0 "$TEMP"
  Delete $R0
  StrCpy $R1 "$R0.cmd"
  FileOpen $R2 $R1 w
  FileWrite $R2 "@echo off$\r$\n"
  FileWrite $R2 "setlocal EnableExtensions$\r$\n"
  FileWrite $R2 "set $\"caogenUninstallerPid=$R4$\"$\r$\n"
  FileWrite $R2 "set $\"caogenInstallRoot=$INSTDIR$\"$\r$\n"
  FileWrite $R2 "cd /d $\"$SYSDIR$\" >nul 2>&1$\r$\n"
  FileWrite $R2 "for /l %%I in (1,1,30) do ($\r$\n"
  FileWrite $R2 "  $\"$SYSDIR\tasklist.exe$\" /fi $\"PID eq %caogenUninstallerPid%$\" /nh | $\"$SYSDIR\findstr.exe$\" /r /c:$\"[ ]%caogenUninstallerPid%[ ]$\" >nul$\r$\n"
  FileWrite $R2 "  if errorlevel 1 ($\r$\n"
  FileWrite $R2 "    rmdir /s /q $\"%caogenInstallRoot%$\" >nul 2>&1$\r$\n"
  FileWrite $R2 "    if not exist $\"%caogenInstallRoot%$\" goto finish$\r$\n"
  FileWrite $R2 "  )$\r$\n"
  FileWrite $R2 "  $\"$SYSDIR\ping.exe$\" -n 2 127.0.0.1 >nul$\r$\n"
  FileWrite $R2 ")$\r$\n"
  FileWrite $R2 ":finish$\r$\n"
  FileWrite $R2 "del $\"%~f0$\" >nul 2>&1$\r$\n"
  FileClose $R2
  Exec '"$SYSDIR\cmd.exe" /d /c ""$R1""'
!macroend
