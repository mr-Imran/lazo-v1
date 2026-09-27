# Starts the LAZO API automatically when you log on to Windows.
#
# PM2 restarts the API if it crashes; this makes PM2 itself come back after a
# reboot by running `pm2 resurrect` (which restarts everything `pm2 save`
# recorded) from a per-user scheduled task. No administrator rights needed.
#
# From a cmd prompt in lazobackend (PowerShell's Set-Location needs
# -LiteralPath because of the brackets in "[ LAZO ]"):
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$taskName = 'LAZO API (PM2 resurrect)'

if ($Remove) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed '$taskName'."
  exit 0
}

$pm2 = Join-Path (npm prefix -g) 'pm2.cmd'
if (-not (Test-Path $pm2)) { throw "pm2 not found at $pm2. Install it with: npm install -g pm2" }

# cmd /c so PM2's .cmd shim runs; a short delay lets the network come up first.
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c timeout /t 20 /nobreak >nul & `"$pm2`" resurrect"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Restores the PM2-managed LAZO API (lazo-api) after logon.' -Force | Out-Null

Write-Host "Installed '$taskName'. PM2 will restore saved apps at each logon."
Write-Host "Make sure the API is saved:  npm run serve   (it runs 'pm2 save')"
