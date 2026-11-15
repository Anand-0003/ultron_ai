#!/bin/zsh
# Launch ULTRON
cd "$(dirname "$0")"

MODEL=${ULTRON_MODEL:-gemma3:12b}

if ! command -v ollama >/dev/null; then
  echo "Ollama isn't installed. Get it from https://ollama.com/download (or: brew install ollama)"
  exit 1
fi

if ! curl -s http://127.0.0.1:11434/api/tags >/dev/null; then
  echo "Starting Ollama..."
  (ollama serve >/dev/null 2>&1 &)
  for i in {1..20}; do curl -s http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 0.5; done
fi

# Gemini models don't live in Ollama, so only pull local ones.
if [[ $MODEL != gemini-* ]] && ! ollama list | awk '{print $1}' | grep -qx "$MODEL"; then
  echo "Pulling $MODEL (first run only)..."
  ollama pull "$MODEL" || exit 1
fi

[ -d node_modules ] || npm install

PORT=${PORT:-7777}
( sleep 1.5
  # Own app window, so ULTRON never shares a window with the pages it controls.
  if [ -d "/Applications/Google Chrome.app" ]; then open -na "Google Chrome" --args --app="http://localhost:$PORT" --window-size=1400,900
  else open "http://localhost:$PORT"; fi ) &

exec node server.js
