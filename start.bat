@echo off
rem Double-click to start the local server and open the browser. Close this window to stop.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" -Open
