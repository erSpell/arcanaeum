@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules\electron" (
  echo Installing dependencies for the first time...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo npm install failed. Is Node.js installed?
    pause
    exit /b 1
  )
)

start "" /b cmd /c "npx electron ."
exit /b 0
