@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','""%~dp0remove-lan-firewall.ps1""'"
