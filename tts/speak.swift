// Persistent speech synthesizer for ULTRON
// Keeps the voice loaded so each sentence renders in milliseconds instead of ~1s per `say` call.
// stdin:  "<id>\t<voice>\t<rate>\t<pitch>\t<output.wav>\t<text>\n"   stdout: "ready\n", then "<id> ok|err\n"
// usage:  speak <voice name> <rate 0..1>

import Foundation
import AVFoundation

setvbuf(stdout, nil, _IOLBF, 0)

let args = CommandLine.arguments
let voiceName = args.count > 1 ? args[1] : "Daniel"
let rate = args.count > 2 ? (Float(args[2]) ?? 0.52) : 0.52

var voices: [String: AVSpeechSynthesisVoice] = [:]
func voice(named name: String) -> AVSpeechSynthesisVoice? {
  let key = name.isEmpty ? voiceName : name
  if let v = voices[key] { return v }
  let v = AVSpeechSynthesisVoice.speechVoices()
    .filter { $0.name == key }
    .max { $0.quality.rawValue < $1.quality.rawValue }
    ?? AVSpeechSynthesisVoice(language: "en-GB")
  voices[key] = v
  return v
}

let synth = AVSpeechSynthesizer()
var jobs: [(id: String, voice: String, rate: Float, pitch: Float, out: String, text: String)] = []
var busy = false

func next() {
  guard !busy, !jobs.isEmpty else { return }
  busy = true
  let job = jobs.removeFirst()
  let utt = AVSpeechUtterance(string: job.text)
  utt.voice = voice(named: job.voice)
  utt.rate = min(max(job.rate, 0.0), 1.0)
  utt.pitchMultiplier = min(max(job.pitch, 0.5), 2.0)
  var file: AVAudioFile?
  var failed = false
  var finished = false
  synth.write(utt) { buffer in
    guard let pcm = buffer as? AVAudioPCMBuffer, !finished else { return }
    if pcm.frameLength == 0 {
      finished = true
      let ok = file != nil && !failed
      file = nil // closes the file
      print("\(job.id) \(ok ? "ok" : "err")")
      DispatchQueue.main.async { busy = false; next() }
      return
    }
    do {
      if file == nil {
        file = try AVAudioFile(
          forWriting: URL(fileURLWithPath: job.out),
          settings: pcm.format.settings,
          commonFormat: pcm.format.commonFormat,
          interleaved: pcm.format.isInterleaved)
      }
      try file?.write(from: pcm)
    } catch {
      failed = true
    }
  }
}

print("ready")
DispatchQueue.global().async {
  while let line = readLine() {
    let parts = line.split(separator: "\t", maxSplits: 5, omittingEmptySubsequences: false).map(String.init)
    guard parts.count == 6 else { continue }
    DispatchQueue.main.async {
      jobs.append((parts[0], parts[1], Float(parts[2]) ?? rate, Float(parts[3]) ?? 1, parts[4], parts[5]))
      next()
    }
  }
  exit(0)
}

dispatchMain()
