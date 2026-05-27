@echo off
if /I not "%~1"=="--minimized" (
  start "Paper Reader Frontend" /min cmd /k ""%~f0" --minimized"
  exit /b
)

cd /d "%~dp0"
title Paper Reader Frontend
echo Starting frontend dev server...
echo Keep this window open. Closing it will stop the frontend.
npm run dev
