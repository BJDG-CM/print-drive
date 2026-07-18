@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Repair-PrintDrive.ps1"
set "PRINT_DRIVE_REPAIR_EXIT=%ERRORLEVEL%"
echo.
if not "%PRINT_DRIVE_REPAIR_EXIT%"=="0" echo Print Drive repair stopped with exit code %PRINT_DRIVE_REPAIR_EXIT%.
pause
exit /b %PRINT_DRIVE_REPAIR_EXIT%
