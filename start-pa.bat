@echo off
cd /d "%~dp0"
node "%~dp0app\launch.ts"
if errorlevel 1 pause
