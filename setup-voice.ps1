# Installs the Kokoro neural voice for ULTRON on Windows (one-time, about 1 GB with PyTorch).
# Double-click setup-voice.bat, or:  powershell -ExecutionPolicy Bypass -File setup-voice.ps1
$ErrorActionPreference = 'Continue'   # native tools report failure through exit codes
Set-Location -LiteralPath $PSScriptRoot

function Fail($msg) { Write-Host "`n  $msg`n" -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }

if (-not (Get-Command py -ErrorAction SilentlyContinue)) { Fail 'Python isn''t installed. Get Python 3.12 from https://python.org (tick "Add python.exe to PATH").' }
$ver = $null
foreach ($v in '3.12', '3.11', '3.10') { & py "-$v" -c "pass" 2>$null; if ($LASTEXITCODE -eq 0) { $ver = $v; break } }
if (-not $ver) { Fail 'Kokoro needs Python 3.10 to 3.12. Install Python 3.12 from https://python.org' }

# Kokoro reads unusual words with espeak-ng. It works without it, just a little worse.
$espeak = (Get-Command espeak-ng -ErrorAction SilentlyContinue) -or (Test-Path "$env:ProgramFiles\eSpeak NG\espeak-ng.exe")
if (-not $espeak) { Write-Host 'Tip: install espeak-ng (the .msi from https://github.com/espeak-ng/espeak-ng/releases) for better pronunciation.' -ForegroundColor Yellow }

New-Item -ItemType Directory -Force -Path .tts | Out-Null
if (-not (Test-Path tts\venv)) { & py "-$ver" -m venv tts\venv }
$py = Resolve-Path tts\venv\Scripts\python.exe
& $py -m pip install -q --upgrade pip
& $py -m pip install -q kokoro soundfile
if ($LASTEXITCODE -ne 0) { Fail 'Installing Kokoro failed (see the messages above).' }

Write-Host 'Downloading the voice model and voices...'
& $py -c @"
from huggingface_hub import hf_hub_download
for v in 'bm_george bm_fable bm_lewis bm_daniel am_michael am_fenrir am_puck bf_emma bf_isabella af_heart af_bella'.split():
    hf_hub_download('hexgrad/Kokoro-82M', f'voices/{v}.pt')
"@
$test = Join-Path $PWD '.tts\test.wav'
"1`tbm_george`t$test`tGood evening. All systems are online." | & $py tts\kokoro_server.py
Remove-Item -Force -ErrorAction SilentlyContinue $test
Write-Host "`nKokoro voice installed. Start ULTRON with start.bat" -ForegroundColor Green
