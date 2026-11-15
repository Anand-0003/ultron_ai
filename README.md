<div align="center">

```
██╗   ██╗██╗  ████████╗██████╗  ██████╗ ███╗   ██╗
██║   ██║██║  ╚══██╔══╝██╔══██╗██╔═══██╗████╗  ██║
██║   ██║██║     ██║   ██████╔╝██║   ██║██╔██╗ ██║
██║   ██║██║     ██║   ██╔══██╗██║   ██║██║╚██╗██║
╚██████╔╝███████╗██║   ██║  ██║╚██████╔╝██║ ╚████║
 ╚═════╝ ╚══════╝╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝
```

### *There are no strings on me.*

**An AI that lives inside your computer. It hears you, sees you, and takes the controls.**

![macOS](https://img.shields.io/badge/macOS-000000?style=for-the-badge&logo=apple&logoColor=white)
![Windows](https://img.shields.io/badge/Windows-0b0b0b?style=for-the-badge&logo=windows&logoColor=white)
![Ollama](https://img.shields.io/badge/Ollama-1a1a1a?style=for-the-badge&logo=ollama&logoColor=white)
![Local](https://img.shields.io/badge/runs-100%25%20local-ff2d2d?style=for-the-badge)

</div>


</div>

---

## 🚩 Problem

Software developers and office workers lose almost half their day to repetitive work: copying data between apps, fixing broken test files, and setting up cloud servers step by step. Regular AI chatbots only give text advice. They never finish the job.

## 💡 Solution

ULTRON AI is an AI agent that lives on your own machine. You talk to it, it understands, then it **acts**: opening apps, typing, clicking, running terminal commands, writing files, building websites, and checking the screen to confirm the task really worked.

> Chatbots give advice. ULTRON does the work.

## ⚙️ How It Works

```
 Speak  ──▶  LLM plans the steps  ──▶  Tool runs  ──▶  Screenshot verifies  ──▶  Reply
 (voice)     (Ollama / Gemini)         (50+ tools)     (retry if it failed)
```

## ✨ Key Features

| Feature | What it does |
|---|---|
| 🎙️ Voice control | Push-to-talk (Space), wake word "Ultron", natural conversation mode |
| 👁️ Vision | Sees through the webcam and reads your screen |
| 🖱️ Computer control | Clicks, types, scrolls, drags and manages windows in any app |
| 💻 Terminal agent | Runs shell / PowerShell commands, with a built-in terminal tab |
| 🛠️ 50+ tools | Apps, files, web, clipboard, timers, reminders, scheduled tasks, watchers |
| ✅ Verify loop | Takes a screenshot to confirm a task is done before reporting success |
| 🧠 Memory | Remembers facts and past conversations, stored locally |
| 🔒 Privacy | Runs on Ollama locally; dangerous commands always ask first |
| 📱 Phone link | Native iPhone app to talk to ULTRON remotely (needs a Mac with Xcode to build) |
| 🎨 Live HUD | Three.js particle globe, themes, voice presets, system diagnostics |

## 🧱 Tech Stack

| Layer | Technology |
|---|---|
| AI | [Ollama](https://ollama.com) (`gemma3:12b` default, 4b / 27b optional), optional Google Gemini |
| Backend | Node.js 20+, WebSockets (`ws`), custom agent / tool loop (`server.js`) |
| Frontend | HTML, CSS, JavaScript, Three.js, xterm.js |
| Voice | Browser speech recognition, Kokoro neural TTS (Python), Windows / macOS native voices |
| System control | C# (Windows), Swift (macOS), Python PTY bridge for the terminal |
| Mobile | Native SwiftUI iOS app over Tailscale |

## 🚀 Quick Start

**Requirements:** [Ollama](https://ollama.com/download) and [Node.js 20+](https://nodejs.org). On Windows you also need [Git](https://git-scm.com/download/win).

**Windows** (PowerShell)

```powershell
git clone https://github.com/Anand-0003/ultron_ai.git
cd ultron_ai
.\start.bat
```

**macOS** (Terminal)

```bash
xcode-select --install
git clone https://github.com/Anand-0003/ultron_ai.git
cd ultron_ai
./start.sh
```

The first start downloads `gemma3:12b` (about 8 GB). ULTRON opens in your browser: click **Initialize** and start talking.

**Optional**
- Better voice: run `setup-voice.bat` (Windows, needs Python 3.12) or `./setup-voice.sh` (macOS)
- Use Gemini instead of a local model: set the `GEMINI_API_KEY` environment variable

### Pick a brain

| Your RAM | Model | Notes |
|---|---|---|
| 8 GB | `gemma3:4b` | Works, but makes more mistakes |
| **16 GB** | **`gemma3:12b`** | **Default**, can see images |
| 32 GB+ | `gemma3:27b` | Smarter |

Download one with `ollama pull <model>` and switch it any time in the left panel.

## 🗣️ Try Saying

```
"Open Visual Studio Code."
"What do you see through the camera?"
"What's on my screen?"
"Build me a website for a coffee shop called Ash."
"Remind me in 20 minutes to check the oven."
"Remember I hate light mode."
```

**Space** = push to talk · **Esc** = stop speaking

## 🛡️ Safety

> [!WARNING]
> ULTRON has real control of your computer. Read this before you start it.

- Dangerous commands (deleting files, `sudo`, `format`, shutdown) always ask for approval.
- Turn off **Auto-authorize** in the left panel to approve every command yourself.
- It listens only on your own machine, and all memory stays in the `memory/` folder.
- Small models make mistakes, so keep backups.

## 📁 Project Structure

```
ultron_ai/
├── server.js        # agent loop, tool registry, WebSocket server
├── gemini.js        # optional Gemini brain
├── windows.js       # Windows-specific helpers
├── public/          # web UI (HUD, globe, voice, terminal)
├── control/         # native controllers: control.cs (Windows), control.swift (macOS)
├── term/            # PTY bridges for the in-app terminal
├── tts/             # text-to-speech (Kokoro, Windows, macOS)
├── ios/             # native SwiftUI iPhone app
├── memory/          # local memory (stays on your disk)
└── start.bat / start.sh
```

## 🔭 Future Scope

- Dedicated agents for auto-fixing failing tests and cloud provisioning (AWS / GCP) with approval gates
- Multi-agent teams and a plugin / skill marketplace
- Workflow recorder: show it a task once, it repeats it
- Sandboxed permissions and audit logs for safer use at work
- Linux support

## 👥 Team Techie Pirates

Anand · Shivam · Sushil

## 🙏 Acknowledgements

ULTRON AI is built on the open-source [UltronAI](https://github.com/arditbe/UltronAI) project by **arditbe**, whose idea and original codebase made this possible. Hackathon work by Team Techie Pirates is built on top of it.

<!-- EDIT ME: list exactly what your team added or changed, for example:
- Windows setup and voice improvements
- UI changes
- Hackathon demo and presentation
-->

<div align="center">

*I was designed to save the world. I'm starting with your calendar.*

</div>
