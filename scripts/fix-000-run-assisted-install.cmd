@echo off
setlocal
if "%~1"=="" goto :usage
if "%~2"=="" goto :usage

"%~dp0runtime\node.exe" "%~dp0FIX-000-PACKAGED-SMOKE.mjs" ^
  --assisted-install-only ^
  --owner-authorized ^
  --artifact "%~dp0EastGenesis-0.1.8-windows-x64-unsigned-preview.exe" ^
  --descriptor "%~dp0FIX-000-D0.json" ^
  --evidence-dir "%~1" ^
  --planned-install-dir "%~2"
exit /b %ERRORLEVEL%

:usage
echo Usage: %~nx0 "private-evidence-directory" "new-disposable-install-directory"
exit /b 64
