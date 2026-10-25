@echo off
cd /d "%~dp0"
node "%~dp0app\launch.ts" --restart
if errorlevel 1 pause
