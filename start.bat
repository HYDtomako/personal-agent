@echo off
rem Start the agent WITH logs in this console (Ctrl+C stops it).
rem For the no-console desktop version: node app\install.ts
rem Keep this file ASCII-only: Chinese Windows cmd mangles non-ANSI bytes.
cd /d "%~dp0"

if not exist config.json (
  echo config.json not found. Copy config.example.json to config.json and fill it in first.
  pause
  exit /b 1
)

node app\launch.ts --console
pause
