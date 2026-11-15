"""Persistent Kokoro neural TTS engine for ULTRON

Keeps the 82M-parameter Kokoro model loaded so each sentence renders in a fraction of a second.
stdin:  "<id>\t<voice>\t<output.wav>\t<text>\n"   (voice e.g. bm_george; first letter = accent)
stdout: "ready\n" once loaded, then "<id> ok|err\n" per job.
"""

import os
import sys

# Keep the protocol channel clean: libraries print to stdout, so move them to stderr.
proto = os.fdopen(os.dup(1), "w", buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr

import warnings
warnings.filterwarnings("ignore")

# Once the model is cached, never touch the network: a slow HuggingFace update check
# can otherwise hang startup indefinitely.
_cache = os.path.expanduser("~/.cache/huggingface/hub/models--hexgrad--Kokoro-82M")
if os.path.isdir(_cache):
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "5")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "30")

import numpy as np
import soundfile as sf
import torch
from kokoro import KModel, KPipeline

REPO = "hexgrad/Kokoro-82M"
SPEED = float(os.environ.get("ULTRON_KOKORO_SPEED", "1.0"))
DEFAULT_VOICE = os.environ.get("ULTRON_KOKORO_VOICE", "bm_george")

torch.set_num_threads(max(1, min(8, os.cpu_count() or 4)))
model = KModel(repo_id=REPO).eval()
pipelines = {}


def pipeline(voice):
    lang = voice[0] if voice[:1] in "abefhijpz" else "b"
    if lang not in pipelines:
        pipelines[lang] = KPipeline(lang_code=lang, repo_id=REPO, model=model)
    return pipelines[lang]


def synth(text, voice, out, speed):
    chunks = [a.numpy() if hasattr(a, "numpy") else a
              for _, _, a in pipeline(voice)(text, voice=voice, speed=speed) if a is not None]
    if not chunks:
        return False
    audio = np.concatenate(chunks)
    # short fade in/out avoids clicks between sentences
    n = min(240, len(audio) // 4)
    if n:
        ramp = np.linspace(0, 1, n, dtype=audio.dtype)
        audio[:n] *= ramp
        audio[-n:] *= ramp[::-1]
    sf.write(out, audio, 24000, subtype="PCM_16")
    return True


with torch.inference_mode():
    list(pipeline(DEFAULT_VOICE)("Systems online.", voice=DEFAULT_VOICE))  # warm-up: loads voice + kernels
    proto.write("ready\n")

    for line in sys.stdin:
        parts = line.rstrip("\n").split("\t", 4)
        if len(parts) != 5:
            continue
        job_id, voice, speed, out, text = parts
        try:
            ok = synth(text, voice or DEFAULT_VOICE, out, float(speed or SPEED))
        except Exception as e:  # keep the engine alive no matter what
            print(f"[kokoro] {e}", file=sys.stderr)
            ok = False
        proto.write(f"{job_id} {'ok' if ok else 'err'}\n")
