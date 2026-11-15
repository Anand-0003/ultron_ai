# Persistent speech engine for ULTRON on Windows (System.Speech, built into Windows).
# Same line protocol as speak.swift:
#   in:  <id> TAB <voice> TAB <rate 0..1> TAB <pitch> TAB <out.wav> TAB <text>
#   out: "ready" once, then "<id> ok" or "<id> fail" per line
# voice "default" uses the system voice; anything else picks an installed voice whose name contains it.

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name })
$in = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
$out = [Console]::Out

function Escape([string]$s) { [Security.SecurityElement]::Escape($s) }

$out.WriteLine('ready'); $out.Flush()
while ($null -ne ($line = $in.ReadLine())) {
  $f = $line.Split("`t", 6)
  if ($f.Count -lt 6) { continue }
  $id, $voice, $rate, $pitch, $file, $text = $f
  try {
    $name = $null
    if ($voice -and $voice -ne 'default') { $name = $voices | Where-Object { $_ -like "*$voice*" } | Select-Object -First 1 }
    # rate 0..1 (0.5 is normal) to -10..10; pitch 1.0 is normal, as a percentage shift
    $r = [Math]::Max(-10, [Math]::Min(10, [int][Math]::Round(([double]$rate - 0.5) * 20)))
    $p = [int][Math]::Round(([double]$pitch - 1) * 50)
    $sign = if ($p -ge 0) { '+' } else { '' }
    $body = '<prosody pitch="' + $sign + $p + '%">' + (Escape $text) + '</prosody>'
    if ($name) { $body = '<voice name="' + (Escape $name) + '">' + $body + '</voice>' }
    $ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">' + $body + '</speak>'
    $synth.Rate = $r
    $synth.SetOutputToWaveFile($file)
    $synth.SpeakSsml($ssml)
    $synth.SetOutputToNull()
    $out.WriteLine("$id ok")
  } catch {
    try { $synth.SetOutputToNull() } catch {}
    $out.WriteLine("$id fail")
  }
  $out.Flush()
}
