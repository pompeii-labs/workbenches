@echo off
setlocal
set "WORKBENCH_UPDATE_WRAPPER=1"
set "WORKBENCH_BINARY=%~dp0workbench.exe"
set "WORKBENCH_UPDATE=%~dp0workbench.update.exe"
call :apply_update
if errorlevel 1 exit /b 1
"%WORKBENCH_BINARY%" %*
set "WORKBENCH_EXIT=%ERRORLEVEL%"
call :apply_update
if errorlevel 1 exit /b 1
exit /b %WORKBENCH_EXIT%

:apply_update
if not exist "%WORKBENCH_UPDATE%" exit /b 0
move /y "%WORKBENCH_UPDATE%" "%WORKBENCH_BINARY%" >nul
if errorlevel 1 (
    >&2 echo workbench: could not finish the pending update
    exit /b 1
)
exit /b 0
