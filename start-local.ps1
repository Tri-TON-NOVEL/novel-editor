param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 8765,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$siteDir = [System.IO.Path]::GetFullPath($PSScriptRoot)
$generatedDir = Join-Path $PSScriptRoot 'local-server\local'
$configPath = Join-Path $generatedDir 'Caddyfile'

try {
  $caddyInFolder = Join-Path $PSScriptRoot 'caddy.exe'
  if (Test-Path -LiteralPath $caddyInFolder) {
    $caddy = $caddyInFolder
  } else {
    $cmd = Get-Command caddy.exe -ErrorAction SilentlyContinue
    if (-not $cmd) { throw 'Caddy was not found. Put the official caddy.exe next to this script.' }
    $caddy = $cmd.Source
  }

  New-Item -ItemType Directory -Path $generatedDir -Force | Out-Null
  $siteCaddy = $siteDir.Replace('\', '/')
  $config = @"
{
    admin off
    auto_https off
}

http://localhost:${Port} {
    root * "$siteCaddy"
    @private path /caddy.exe /*.ps1 /*.bat /.claude/* /local-server/*
    respond @private 404
    encode zstd gzip
    header Cache-Control "no-store"
    file_server
}
"@
  [IO.File]::WriteAllText($configPath, $config, [Text.UTF8Encoding]::new($false))

  & $caddy validate --config $configPath --adapter caddyfile
  if ($LASTEXITCODE -ne 0) { throw 'The generated Caddy configuration is invalid.' }

  Write-Host ''
  Write-Host 'Ayatsuzuri local server is ready.' -ForegroundColor Green
  Write-Host "URL: http://localhost:${Port}/"
  Write-Host 'Keep this window open. Press Enter to stop the server.'
  Write-Host ''

  $process = Start-Process -FilePath $caddy -ArgumentList @('run', '--config', $configPath, '--adapter', 'caddyfile') -PassThru -NoNewWindow
  try {
    if (-not $NoBrowser) { Start-Process "http://localhost:${Port}/" }
    [void](Read-Host)
  } finally {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -ErrorAction SilentlyContinue }
  }
} catch {
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
