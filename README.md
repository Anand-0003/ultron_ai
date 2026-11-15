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

---

You start it once. After that it's listening.

ULTRON runs on your own computer. It hears your voice, looks through your webcam, opens your apps, moves your mouse, types into your windows and reads your screen. It writes code, builds websites and runs commands. It remembers every conversation.

No cloud. No company on the other end. Just you, [Ollama](https://ollama.com), and a machine that does what it's told.

> [!WARNING]
> **This is not a toy.** ULTRON has real control of your computer and runs commands **without asking** (dangerous ones still ask first). Read [Safety](#-safety) before you start it.

> [!NOTE]
> **There is no `.exe` or `.dmg` download.** ULTRON runs from the source code. Follow the steps below, it takes about 5 minutes.

---

## ◉ Run it on Mac

1. Install **[Ollama](https://ollama.com/download)** and **[Node.js](https://nodejs.org)** (version 20 or newer).
2. Open **Terminal** and run:

   ```bash
   xcode-select --install
   git clone https://github.com/arditbe/UltronAI.git
   cd UltronAI
   ./start.sh
   ```

3. ULTRON opens in Chrome. Click **Initialize** and start talking.
4. Give Terminal access in **System Settings → Privacy & Security → Accessibility** and **Screen Recording**, then run `./start.sh` again.

**Optional:**
- Better voice: `./setup-voice.sh`
- Let it unlock your Mac when you clap: `./set-unlock-password.sh`

---

## ◉ Run it on Windows

1. Install **[Ollama](https://ollama.com/download)**, **[Node.js](https://nodejs.org)** (version 20 or newer) and **[Git](https://git-scm.com/download/win)**.
2. Open **PowerShell** and run:

   ```powershell
   git clone https://github.com/arditbe/UltronAI.git
   cd UltronAI
   .\start.bat
   ```

   Or download the ZIP from GitHub (**Code → Download ZIP**), unzip it, and double-click **`start.bat`**.

3. ULTRON opens in Chrome or Edge. Click **Initialize** and start talking.

**Optional:**
- Better voice: install [Python 3.12](https://python.org), then double-click **`setup-voice.bat`**
- If Windows Security blocks `control\control.exe`, allow it under **Protection history**.

---

## ◉ iPhone app (needs a Mac + an iPhone)

There's a native iPhone app in the `ios/` folder. You talk to ULTRON from anywhere, and it can **call you** with a real incoming-call screen.

You build it yourself, so you need a **Mac with Xcode** and an **iPhone**. Once it's installed, the app works with ULTRON running on either a Mac or a Windows PC.

1. Install [Tailscale](https://tailscale.com) on the computer and the iPhone (same account).
2. Open `ios/Ultron.xcodeproj` in Xcode.
3. In **Signing & Capabilities**, pick your Apple ID team and change the bundle ID to something of your own.
4. Plug in your iPhone and press **Run**.
5. In the app, enter your computer's Tailscale address (like `http://100.x.x.x:7777`). In ULTRON on the computer, press **Phone link → Pair a phone** and type the code into the app.

No Mac? You can still use ULTRON from any phone's browser over Tailscale, just without the app.

---

## ◉ Pick a brain

The first start downloads `gemma3:12b` (about 8 GB). You can switch models any time in the left panel.

| Your RAM | Model | |
|---|---|---|
| 8 GB | `gemma3:4b` | works, but makes more mistakes |
| **16 GB** | **`gemma3:12b`** | **default**, can see images |
| 32 GB+ | `gemma3:27b` | smarter |
| any | `gpt-oss:120b-cloud` | runs on Ollama's servers (`ollama signin` first) |

Download one with `ollama pull <model>`. For building websites, a coding model like `qwen2.5-coder:14b` works much better.

---

## ◉ Things to say

```
"Open Spotify and play something dark."
"What's on my screen?"
"What am I holding?"
"Build me a website for a coffee shop called Ash."
"Remind me in 20 minutes to check the oven."
"Remember I hate light mode."
"What did we talk about yesterday?"
"Go red. Darker."
"Type I'll be there in ten. Send it."
```

**Space** = push to talk · **Esc** = stop it talking

---

## ◉ Safety

- ULTRON runs commands **without asking** by default. Dangerous ones (deleting your drive, `sudo`, `format`, shutting down…) still ask first. Turn off **Auto-authorize** in the left panel to approve every command yourself.
- It only listens on your own computer, never your Wi-Fi network.
- Everything it remembers stays in the `memory/` folder on your disk.
- Small models make mistakes. Keep backups.

---

<div align="center">

*I was designed to save the world. I'm starting with your calendar.*

**ULTRON** · runs local · no strings attached

</div>
