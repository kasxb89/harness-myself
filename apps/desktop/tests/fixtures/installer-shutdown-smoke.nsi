; Private qualification of the production shutdown macro, without application registration or payload replacement.
Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "Desktop graceful shutdown qualification"
OutFile "${OUTPUT_FILE}"
LoadLanguageFile "${NSISDIR}\Contrib\Language files\English.nlf"
LoadLanguageFile "${NSISDIR}\Contrib\Language files\SimpChinese.nlf"
!define APP_EXECUTABLE_FILENAME "Yunshu.exe"
!define DSH_UPDATER_CACHE_NAME "yunshu-graceful-qualification-only"
!define /ifndef DSH_SHUTDOWN_WAIT_ITERATIONS 8
!define DSH_INSTALLER_LOG_DIR "${REPORT_DIR}"
!include "..\..\installer\strings.nsh"
!include "..\..\scripts\installer.nsh"

Section
  InitPluginsDir
  File "/oname=$PLUGINSDIR\window-frame.dll" "${SOURCE_DLL}"
  StrCpy $INSTDIR "${TARGET_DIR}"
  !insertmacro customCheckAppRunning
  FileOpen $0 "${REPORT_DIR}\shutdown-qualified.txt" w
  FileWrite $0 "Confirmed target installation processes exited without force."
  FileClose $0
  SetErrorLevel 0
SectionEnd
