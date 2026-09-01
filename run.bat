@echo off
setlocal
cd /d "%~dp0"

if "%~1"=="/?" goto help
if "%~1"=="--help" goto help
if "%~1"=="help" goto help

if not exist ".env" (
  echo Creating local production .env...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$pg=-join ((1..48)|ForEach-Object{('{0:x}' -f (Get-Random -Maximum 16))}); $auth=-join ((1..64)|ForEach-Object{('{0:x}' -f (Get-Random -Maximum 16))}); @('KANEO_CLIENT_URL=https://admin.polyquantlabs.xyz/kaneo','KANEO_API_URL=https://admin.polyquantlabs.xyz/kaneo/api','KANEO_BROWSER_API_URL=/kaneo/api','CORS_ORIGINS=https://admin.polyquantlabs.xyz','POSTGRES_DB=kaneo','POSTGRES_USER=kaneo',('POSTGRES_PASSWORD='+$pg),('AUTH_SECRET='+$auth),'DISABLE_GUEST_ACCESS=true') | Set-Content -LiteralPath '.env' -Encoding ascii"
  if errorlevel 1 exit /b %errorlevel%
)

docker compose -p kaneo up -d --build --remove-orphans
if errorlevel 1 exit /b %errorlevel%

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\repair-kaneo-tunnel.ps1"
exit /b %errorlevel%

:help
echo Kaneo startup runner
echo.
echo Starts Kaneo and Postgres, then publishes:
echo   https://admin.polyquantlabs.xyz/kaneo/
echo   https://admin.polyquantlabs.xyz/linear
endlocal
