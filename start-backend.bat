@echo off
if /I not "%~1"=="--minimized" (
  start "Paper Reader Backend" /min cmd /k ""%~f0" --minimized"
  exit /b
)

cd /d "%~dp0"
title Paper Reader Backend
echo Starting backend server...
echo Keep this window open. Closing it will stop the backend.
node server/index.js
