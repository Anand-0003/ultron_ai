# Launch ULTRON on Windows.  Double-click start.bat, or:  powershell -ExecutionPolicy Bypass -File start.ps1
$ErrorActionPreference = 'Continue'   # native tools report failure through exit codes
Set-Location -LiteralPath $PSScriptRoot

$model = if ($env:ULTRON_MODEL) { $env:ULTRON_MODEL } else { 'gemma3:12b' }
$port = if ($env:PORT) { $env:PORT } else { '7777' }

function Fail($msg) { Write-Host "`n  $msg`n" -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js isn''t installed. Get it from https://nodejs.org (version 20 or newer).' }

$ollama = (Get-Command ollama -ErrorAction SilentlyContinue).Source
if (-not $ollama) {
  $guess = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
  if (Test-Path $guess) { $ollama = $guess } else { Fail 'Ollama isn''t installed. Get it from https://ollama.com/download' }
}

function OllamaUp { try { Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2 -ErrorAction Stop | Out-Null; $true } catch { $false } }
if (-not (OllamaUp)) {
  Write-Host 'Starting Ollama...'
  Start-Process -FilePath $ollama -ArgumentList 'serve' -WindowStyle Hidden
  for ($i = 0; $i -lt 30 -and -not (OllamaUp); $i++) { Start-Sleep -Milliseconds 500 }
}

# Gemini models don't live in Ollama, so only pull local ones.
if ($model -notlike 'gemini-*') {
  $have = (Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags').models | ForEach-Object { $_.name }
  $want = if ($model -like '*:*') { $model } else { "$model`:latest" }
  if ($have -notcontains $want) {
    Write-Host "Pulling $model (first run only)..."
    & $ollama pull $model
    if ($LASTEXITCODE -ne 0) { Fail "Couldn't pull $model" }
  }
}

if (-not (Test-Path node_modules)) { npm install; if ($LASTEXITCODE -ne 0) { Fail 'npm install failed' } }

# The built-in terminal needs Python with pywinpty. Optional: everything else works without it.
if (Get-Command py -ErrorAction SilentlyContinue) {
  & py -3 -c "import winpty" 2>$null
  if ($LASTEXITCODE -ne 0) { Write-Host 'Installing pywinpty for the built-in terminal...'; & py -3 -m pip install --user --quiet pywinpty 2>$null }
}

# Its own app window, so ULTRON never shares a window with the pages it controls.
$url = "http://localhost:$port"
$browser = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

Start-Job -ScriptBlock {
  param($browser, $url)
  Start-Sleep -Seconds 2
  if ($browser) { Start-Process -FilePath $browser -ArgumentList "--app=$url", '--window-size=1400,900' } else { Start-Process $url }
} -ArgumentList $browser, $url | Out-Null

node server.js
