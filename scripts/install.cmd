@echo off
rem Bharti Enterprises - double-click to install on this PC.
rem
rem Keep this file in the same folder as install.ps1. For an install with no internet,
rem put bharti-app-v*.zip in that folder too and it is used instead of downloading.
rem Windows will ask for administrator permission - choose Yes.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -PauseAtEnd %*
