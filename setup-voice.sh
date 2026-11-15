#!/bin/zsh
# Installs the Kokoro neural voice for ULTRON (one-time, ~1 GB incl. PyTorch).
set -e
cd "$(dirname "$0")"

command -v espeak-ng >/dev/null || brew install espeak-ng

PY=""
for v in python3.12 python3.11 python3.10; do
  command -v $v >/dev/null && { PY=$v; break; }
done
[ -n "$PY" ] || { echo "Kokoro needs Python 3.10–3.12:  brew install python@3.12"; exit 1; }

mkdir -p .tts
[ -d tts/venv ] || $PY -m venv tts/venv
tts/venv/bin/pip install -q --upgrade pip
tts/venv/bin/pip install -q kokoro soundfile

echo "Downloading the voice model and voices…"
tts/venv/bin/python -c "
from huggingface_hub import hf_hub_download
for v in 'bm_george bm_fable bm_lewis bm_daniel am_michael am_fenrir am_puck bf_emma bf_isabella af_heart af_bella'.split():
    hf_hub_download('hexgrad/Kokoro-82M', f'voices/{v}.pt')
"
echo "1\tbm_george\t$PWD/.tts/test.wav\tGood evening, sir. All systems are online." \
  | tts/venv/bin/python tts/kokoro_server.py
rm -f .tts/test.wav
echo "Kokoro voice installed. Start ULTRON with ./start.sh"
