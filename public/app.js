import { Orb } from './orb.js';
import { intro, powerOn } from './ultron.js';
import { restoreView } from './deck.js';
import { cue } from './sfx.js';

const $ = s => document.querySelector(s);
const body = document.body;

const state = {
  ws: null, turn: 0, busy: false, speaking: false, awaiting: false,
  wake: false, always: false, clapWake: false,
  talk: localGet('fri.talk') !== 'false',   // natural conversation: talk over her, follow-ups without a wake word
  convo: false,                             // a voice exchange is in progress, so the mic stays open
  camOn: false, confirmOpen: false, runningActions: new Map(),
};
const wantsContinuous = () => state.wake || state.always;
let onCallElsewhere = null;   // name of the phone a call was picked up on; this screen stays quiet meanwhile

// Audio

let actx, analyser, micAnalyser;
const timeBuf = new Uint8Array(512), freqBuf = new Uint8Array(256);
const orbWave = new Uint8Array(256), orbFreq = new Uint8Array(128);
let queue = [], current = null, playing = false;

// Voice tuning (persisted per browser). pitch & speed also go to the server per sentence.
const voice = {
  pitch: Number(localGet('fri.pitch')) || 1,
  speed: Number(localGet('fri.speed')) || 1,
  volume: localGet('fri.vol') != null ? Number(localGet('fri.vol')) : 1,
};

let voiceGain;
function initAudio() {
  // In the iPhone app her voice plays natively: any web audio would make WebKit take over the
  // iPhone's audio session, which kills the app's mic and stops when the screen locks.
  if (inApp) return;
  actx = new AudioContext();
  analyser = actx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.6;
  voiceGain = actx.createGain();
  voiceGain.gain.value = voice.volume;
  voiceGain.connect(analyser);           // voice -> gain -> analyser -> speakers
  analyser.connect(actx.destination);
}

// Inside the ULTRON iPhone app the native side owns the mic (and speech recognition) and
// plays her voice; it reports back whether she's speaking and how loud, for the bubble.
const inApp = /UltronApp/.test(navigator.userAgent);
const nativeBridge = inApp ? window.webkit.messageHandlers.ultron : null;
let nativeLevel = 0;
if (inApp) {
  window.__ultronSpeaking = on => setSpeaking(!!on);
  window.__ultronLevel = l => { nativeLevel = l; };
  window.__ultronResume = () => send({ type: 'history' });   // catch up on what was said while locked
}

async function initMic() {
  if (inApp) return setPill('mic', true);
  try {
    // Raw mic (no noise suppression) so sharp claps survive for the detector.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
    micAnalyser = actx.createAnalyser();
    micAnalyser.fftSize = 512;
    clapSource = actx.createMediaStreamSource(stream);
    clapSource.connect(micAnalyser);
    setPill('mic', true);
  } catch { setPill('mic', false); }
}

let lastClap = 0, clapCount = 0, clapCooldown = 0, clapNodes = null;
function setClapDetector(on) {
  if (on && !clapNodes && clapSource && actx) {
    const proc = actx.createScriptProcessor(1024, 1, 1);
    const mute = actx.createGain();
    mute.gain.value = 0;              
    clapSource.connect(proc);
    proc.connect(mute);
    mute.connect(actx.destination);
    proc.onaudioprocess = clapProcess;
    clapNodes = { proc, mute };
  } else if (!on && clapNodes) {
    try { clapSource.disconnect(clapNodes.proc); clapNodes.proc.disconnect(); clapNodes.mute.disconnect(); } catch {}
    clapNodes.proc.onaudioprocess = null;
    clapNodes = null;
  }
}
let clapSource = null, clapPrev = 0, clapFloor = 0.01;
let clapDebug = false;   // set ULTRON_CLAP_DEBUG=1 via console to see levels
function clapProcess(e) {
    if (state.speaking) { clapPrev = 0; return; }
    const buf = e.inputBuffer.getChannelData(0);
    let peak = 0, sum = 0;
    for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > peak) peak = a; sum += buf[i] * buf[i]; }
    const rms = Math.sqrt(sum / buf.length);
    const now = performance.now();
    // Track a slow background floor so detection adapts to the room/mic.
    clapFloor = rms > clapFloor ? clapFloor * 0.98 + rms * 0.02 : clapFloor * 0.995 + rms * 0.005;
    // A clap: a loud, sharp, impulsive spike, well above the floor, with a fast onset.
    const impulsive = peak > 0.12 && peak > clapFloor * 10 && peak > clapPrev * 2.2 && peak > rms * 4;
    clapPrev = Math.max(peak, clapPrev * 0.6);
    if (clapDebug && peak > 0.08) console.log(`[clap] peak=${peak.toFixed(3)} rms=${rms.toFixed(3)} floor=${clapFloor.toFixed(3)} ${impulsive ? 'HIT' : ''}`);
    if (!impulsive || now < clapCooldown) return;
    clapCooldown = now + 200;            // ignore the clap's own echo/tail
    flashPill('mic');
    if (now - lastClap < 1600 && now - lastClap > 90) {
      lastClap = 0; clapCooldown = now + 2500; onDoubleClap();
    } else {
      lastClap = now;
      if (clapDebug) console.log('[clap] first clap — waiting for second');
    }
}
window.clapDebug = v => { clapDebug = v !== false; console.log('clap debug', clapDebug); };
function flashPill(name) {
  const el = $(`#pill-${name}`);
  if (!el) return;
  el.style.transition = 'none'; el.style.boxShadow = '0 0 14px var(--cyan)';
  setTimeout(() => { el.style.transition = 'box-shadow .4s'; el.style.boxShadow = ''; }, 60);
}

function onDoubleClap() {
  chime();
  toast('Clap detected — waking the screen.');
  send({ type: 'wake' });
}

function enqueueAudio(url, turn, rate) {
  if (inApp) return nativeBridge.postMessage({ cmd: 'play', url, rate: rate || 1, turn });
  const buf = fetch(url).then(r => r.arrayBuffer()).then(b => actx.decodeAudioData(b));
  queue.push({ buf, turn, rate: rate || 1 });
  if (!playing) playNext();
}

async function playNext() {
  const item = queue.shift();
  if (!item) { playing = false; setSpeaking(false); return; }
  playing = true;
  let buffer;
  try { buffer = await item.buf; } catch { return playNext(); }
  if (item.turn !== state.turn) return playNext();
  const src = actx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = item.rate;   // server already compensated tempo for this pitch shift
  src.connect(voiceGain);
  src.onended = () => { if (current === src) { current = null; playNext(); } };
  current = src;
  setSpeaking(true);
  src.start();
}

// fade: when she's interrupted she trails off (quieter and a touch slower) instead of cutting dead.
function stopAudio(fade = 0) {
  if (inApp) nativeBridge.postMessage({ cmd: 'stop_audio' });
  queue = [];
  if (current) {
    const c = current; current = null;
    c.onended = null;
    if (fade && actx && voiceGain) {
      const t = actx.currentTime, end = t + fade / 1000;
      voiceGain.gain.cancelScheduledValues(t);
      voiceGain.gain.setValueAtTime(voiceGain.gain.value, t);
      voiceGain.gain.exponentialRampToValueAtTime(0.0001, end);
      c.playbackRate.setValueAtTime(c.playbackRate.value, t);
      c.playbackRate.linearRampToValueAtTime(c.playbackRate.value * 0.9, end);
      try { c.stop(end + 0.02); } catch {}
      // Back to full volume for her next line (a new clip can't start before this anyway).
      setTimeout(() => {
        ducked = false;
        voiceGain.gain.cancelScheduledValues(actx.currentTime);
        voiceGain.gain.setValueAtTime(voice.volume, actx.currentTime);
      }, fade + 60);
    } else try { c.stop(); } catch {}
  }
  playing = false;
  setSpeaking(false);
}

// The listening cue: a low two-note tone (sfx.js), in place of the old bright chirp.
function chime(up = true) { cue(up); }

// State -> UI

function setSpeaking(v) {
  if (state.speaking === v) return;
  state.speaking = v;
  if (v) pauseRecognition();
  else {
    speechEndedAt = performance.now();
    // Drop whatever the recognizer is still transcribing of her voice, so a late echo never becomes a command.
    if (state.talk && rec && !alwaysText && !keepRec) restartRec();
    keepRec = false;
    resumeRecognition();
    maybeFollowUp();
  }
  refresh();
}

function refresh() {
  const thinking = state.busy && !state.speaking;
  body.classList.toggle('speaking', state.speaking);
  body.classList.toggle('thinking', thinking);
  body.classList.toggle('listening', state.awaiting);
  let s = 'STANDING BY';
  const running = [...state.runningActions.values()].pop();
  if (state.confirmOpen) s = 'AWAITING AUTHORIZATION';
  else if (onCallElsewhere) s = `ON CALL · ${onCallElsewhere.toUpperCase()}`;
  else if (state.awaiting) s = 'LISTENING';
  else if (state.speaking) s = 'SPEAKING';
  else if (running) s = `EXECUTING · ${running.replace(/_/g, ' ').toUpperCase()}`;
  else if (thinking) s = 'PROCESSING';
  else if (state.talk && followOpen() && !state.always) s = 'GO AHEAD';
  else if (state.always) s = 'ALWAYS LISTENING';
  else if (state.wake) s = 'SAY “ULTRON”';
  $('#status-text').textContent = s;
}

function setPill(name, on) { $(`#pill-${name}`).classList.toggle('on', on); }

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}

// Transcript

const log = $('#log');
let ultronLine = null, interimLine = null;

function addLine(who, text, cls = '') {
  const el = document.createElement('div');
  el.className = `line ${who} ${cls}`;
  el.innerHTML = `<span class="who">${who === 'user' ? 'YOU' : 'ULTRON'}</span><p></p>`;
  el.querySelector('p').textContent = text;
  if (who === 'ultron') heardUltron(text);
  log.appendChild(el);
  while (log.children.length > 14) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
  return el;
}

function showInterim(text) {
  if (!text) return;
  if (!interimLine) interimLine = addLine('user', '', 'interim');
  interimLine.querySelector('p').textContent = text;
  log.scrollTop = log.scrollHeight;
}
function clearInterim() { interimLine?.remove(); interimLine = null; }

function appendUltron(text) {
  if (!ultronLine) {
    if (!text.trim()) return;
    ultronLine = addLine('ultron', '');
    text = text.trimStart();
  }
  heardUltron(text);
  const p = ultronLine.querySelector('p');
  p.textContent = (p.textContent + text).replace(/ {2,}/g, ' ');
  log.scrollTop = log.scrollHeight;
}

// Server link

let greeted = false;

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    setPill('core', true);
    sendConfig();
    if (state.clapWake) send({ type: 'keep_awake', on: true });
    if (!greeted) { greeted = true; send({ type: 'greet' }); }
  };
  ws.onclose = () => {
    setPill('core', false);
    state.busy = false;
    refresh();
    setTimeout(connect, 1500);
  };
  ws.onmessage = e => handle(JSON.parse(e.data));
}

const send = obj => state.ws?.readyState === 1 && state.ws.send(JSON.stringify(obj));
const sendConfig = () => send({
  type: 'config',
  model: $('#model').value || undefined,
  coderModel: $('#coder').value,
  voice: $('#voice').value || undefined,
  pitch: voice.pitch,
  speed: voice.speed,
  tts: $('#opt-voice').checked,
  autoApprove: $('#opt-auto').checked,
});

function sendUser(text, { voice = false } = {}) {
  text = text.trim();
  if (!text) return;
  if (voice && state.talk) { state.convo = true; clearTimeout(followTimer); }
  const interrupted = bargedIn;
  bargedIn = false;
  clearInterim();
  stopAudio();
  addLine('user', text);
  ultronLine = null;
  // Verbatim dictation ONLY on an explicit "dictate ...". Plain "type/write ..." goes to the AI,
  // which composes the text and types it itself.
  const d = text.match(/^dictate\b[\s:,]*(.+)$/i);
  if (d) return send({ type: 'dictate', text: d[1] });
  const c = text.toLowerCase().replace(/[.!?]+$/, '').trim();
  const keys = {
    'send it': 'return', 'send': 'return', 'send message': 'return', 'send the message': 'return', 'press enter': 'return',
    'new line': 'shift+return', 'delete that': 'clear', 'clear that': 'clear', 'clear it': 'clear', 'delete last word': 'option+delete',
  };
  if (keys[c]) return send({ type: 'dictate_key', key: keys[c] });
  // Memory: keep the user's exact wording (not lowercased).
  let mm;
  if ((mm = text.match(/^remember(?:\s+that|\s+this)?[:,]?\s+(.+)/i)))
    return send({ type: 'do', tool: 'remember', args: { text: mm[1].trim() } });
  if ((mm = text.match(/^forget(?:\s+about|\s+that)?[:,]?\s+(.+)/i)))
    return send({ type: 'do', tool: 'forget', args: { query: mm[1].trim() } });
  // Direct UI commands run without the model, so "tap X" always clicks and never opens a tab.
  const direct = routeDirect(c);
  if (direct) return send(direct);
  send({ type: 'user', text, interrupted });
}

// Recognise plain on-screen commands and map them straight to a tool.
const KEY_WORDS = { enter: 'return', return: 'return', escape: 'escape', esc: 'escape', space: 'space', tab: 'tab', delete: 'delete', backspace: 'delete' };
const SHORTCUTS = {
  'go back': 'cmd+[', 'back': 'cmd+[', 'go forward': 'cmd+]', 'forward': 'cmd+]',
  'new tab': 'cmd+t', 'close tab': 'cmd+w', 'close window': 'cmd+shift+w', 'reopen tab': 'cmd+shift+t',
  'reload': 'cmd+r', 'refresh': 'cmd+r', 'next tab': 'ctrl+tab', 'previous tab': 'ctrl+shift+tab',
  'select all': 'cmd+a', 'copy': 'cmd+c', 'paste': 'cmd+v', 'cut': 'cmd+x', 'undo': 'cmd+z', 'redo': 'cmd+shift+z',
  'find': 'cmd+f', 'save': 'cmd+s', 'zoom in': 'cmd+=', 'zoom out': 'cmd+-', 'full screen': 'ctrl+cmd+f',
  'scroll to top': 'cmd+up', 'scroll to the top': 'cmd+up', 'scroll to bottom': 'cmd+down', 'scroll to the bottom': 'cmd+down',
  'press enter': 'return', 'hit enter': 'return', 'press escape': 'escape', 'press space': 'space', 'press tab': 'tab',
};
function routeDirect(c) {
  if (SHORTCUTS[c]) return { type: 'do', tool: 'press_keys', args: { keys: SHORTCUTS[c] } };
  let m;
  // Click/tap something already on screen (NOT "open", which means navigate, leave that to the model).
  const noun = '(?:\\s+(?:button|link|tab|icon|option|menu item|menu|item|field|box|checkbox|toggle))?';
  if ((m = c.match(new RegExp(`^(?:click|tap|press|hit|select|choose)\\s+(?:on\\s+)?(?:the\\s+)?(.+?)${noun}$`)))) {
    const name = m[1].trim();
    if (KEY_WORDS[name]) return { type: 'do', tool: 'press_keys', args: { keys: KEY_WORDS[name] } };
    return { type: 'do', tool: 'click_element', args: { name } };
  }
  if ((m = c.match(/^(?:double[- ]?click|double[- ]?tap)\s+(?:on\s+)?(?:the\s+)?(.+?)$/)))
    return { type: 'do', tool: 'click_element', args: { name: m[1].trim() } };
  if ((m = c.match(/^scroll(?:\s+(up|down|left|right))?(?:\s+(?:a\s+)?(?:bit|little|lot|more|page))?$/)))
    return { type: 'do', tool: 'scroll', args: { direction: m[1] || 'down', amount: /lot|more|page/.test(c) ? 10 : 5 } };
  const win = { 'maximize': 'maximize', 'maximise': 'maximize', 'minimize': 'minimize', 'minimise': 'minimize',
    'fullscreen': 'fullscreen', 'full screen': 'fullscreen', 'center window': 'center', 'centre window': 'center',
    'maximize window': 'maximize', 'minimize window': 'minimize', 'fullscreen window': 'fullscreen' };
  if (win[c]) return { type: 'do', tool: 'window', args: { action: win[c] } };
  if ((m = c.match(/^(?:snap|move|put)\s+(?:the |this )?window\s+(?:to the )?(left|right|top|bottom)(?:\s+half)?$/)))
    return { type: 'do', tool: 'window', args: { action: m[1] } };
  // Escape hatch that works even if the model broke the interface.
  if ((m = c.match(/^(?:reset|restore)\s+(?:your\s+|the\s+)?(gui|interface|look|theme|ui)$/)))
    return { type: 'do', tool: 'gui_reset', args: { what: m[1] === 'theme' ? 'theme' : 'all' } };
  return null;
}

function stopAll() {
  stopAudio();
  send({ type: 'stop' });
  closeConfirm(false);
}

async function handle(m) {
  switch (m.type) {
    case 'models': {
      const sel = $('#model');
      // "ultron.brain" (was "ultron.model"): renamed when Gemini became the default, so a pick
      // saved before then doesn't override it. New picks are remembered as before.
      const saved = localGet('ultron.brain');
      const list = m.models.includes(m.current) ? m.models : [m.current, ...m.models];
      sel.innerHTML = list.map(n => `<option>${n}</option>`).join('');
      sel.value = saved && list.includes(saved) ? saved : m.current;
      const coder = $('#coder');
      const savedCoder = localGet('ultron.coder') ?? m.coder ?? '';
      coder.innerHTML = `<option value="">Same as neural core</option>` + m.models.map(n => `<option>${n}</option>`).join('');
      coder.value = m.models.includes(savedCoder) ? savedCoder : '';
      const vsel = $('#voice');
      const savedVoice = localGet('ultron.voice');
      vsel.innerHTML = (m.voices || []).map(v => `<option value="${v.id}">${v.label}</option>`).join('');
      vsel.value = m.voices?.some(v => v.id === savedVoice) ? savedVoice : m.voice;
      sendConfig();
      break;
    }
    case 'turn':
      if (m.turn !== state.turn) {
        state.turn = m.turn; ultronLine = null; queue = [];
        if (inApp) nativeBridge.postMessage({ cmd: 'turn', turn: m.turn });
      }
      break;
    case 'busy':
      if (m.turn === undefined || m.turn === state.turn) state.busy = m.busy;
      if (!m.busy) { state.runningActions.clear(); maybeFollowUp(); }
      refresh();
      break;
    case 'state': refresh(); break;
    case 'token': if (m.turn === state.turn) appendUltron(m.text); break;
    case 'audio': if (m.turn === state.turn) enqueueAudio(m.url, m.turn, m.rate); break;
    case 'action': onAction(m); break;
    case 'stats':
      if (m.tokensPerSec) $('#tps').textContent = `${m.tokensPerSec.toFixed(1)} tok/s`;
      if (m.firstTokenMs) $('#latency').textContent = `${m.firstTokenMs} ms`;
      break;
    case 'sys':
      $('#cpu-val').textContent = `${Math.round(m.cpu * 100)}%`;
      $('#cpu-bar').style.width = `${Math.min(100, m.cpu * 100)}%`;
      $('#load-val').textContent = m.load.toFixed(2);
      $('#load-bar').style.width = `${Math.min(100, (m.load / m.cores) * 100)}%`;
      if (m.battery) updateBattery(m.battery);
      break;
    case 'timers': renderTimers(m.list || []); break;
    case 'memory': renderMemory(m.facts || []); break;
    case 'jobs': renderJobs(m.list || []); break;
    case 'notice':
      addLine('ultron', m.text);
      if (m.kind === 'timer') toast(m.text);
      break;
    case 'request_frame': {
      const frame = await captureFrame();
      send({ type: 'reply', id: m.id, value: frame });
      break;
    }
    case 'confirm_request': openConfirm(m.id, m.command); break;
    case 'hello': body.classList.toggle('remote', !!m.remote); break;
    case 'transcript':   // the conversation so far, from whichever device it happened on
      if (m.replace) { log.innerHTML = ''; ultronLine = null; }
      if (!log.children.length) for (const l of m.lines || []) addLine(l.who, l.text);
      break;
    case 'files': renderFiles(m.list || []); break;
    case 'file': fileCard(m.file); toast(`Incoming: ${m.file.name}`); chime(); break;
    case 'devices': renderDevices(m); break;
    case 'handoff': handoff(m); break;
    case 'phone_open': phoneOpen(m); break;
    case 'gui': send({ type: 'reply', id: m.id, value: await guiOp(m.op, m.args || {}) }); break;
    case 'code_start': codeStart(m); break;
    case 'code': codeFeed(m); break;
    case 'code_end': codeEnd(m); break;
    case 'error':
      toast(m.message);
      addLine('ultron', m.message, 'error');
      break;
  }
}

// Actions

const actionEls = new Map();
function onAction(m) {
  let li = actionEls.get(m.id);
  if (!li) {
    li = document.createElement('li');
    li.innerHTML = `<div class="t"><span></span><span></span></div><div class="d"></div>`;
    li.querySelector('.t span').textContent = m.tool.replace(/_/g, ' ');
    const args = m.args ? Object.values(m.args).filter(Boolean).join(' · ') : '';
    li.querySelector('.d').textContent = args;
    $('#actions').prepend(li);
    actionEls.set(m.id, li);
    while ($('#actions').children.length > 12) $('#actions').lastChild.remove();
  }
  li.className = m.status;
  li.querySelector('.t span:last-child').textContent = m.status === 'running' ? 'running' : m.status === 'done' ? 'complete' : 'failed';
  if (m.detail) li.querySelector('.d').textContent = m.detail;
  if (m.status === 'running') state.runningActions.set(m.id, m.tool);
  else state.runningActions.delete(m.id);
  refresh();
}

// Live code panel
// Code ULTRON writes streams onto the HUD, typed out with syntax colours.

const code = {
  el: $('#code'), lines: $('#code-lines'), live: $('#code-live'), body: $('#code-body'),
  id: null, queue: '', line: '', count: 0, bytes: 0, ended: null, hideTimer: null, raf: 0,
};

const TOKEN = /(\/\/.*$|\/\*.*?(?:\*\/|$)|<!--.*?(?:-->|$))|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(<\/?[a-zA-Z][\w-]*|\/?>)|\b(const|let|var|function|return|if|else|for|while|class|new|async|await|import|export|from|this|true|false|null|undefined|def|self|None|True|False|in|of|try|catch)\b|(#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|rem|em|%|s|ms|vh|vw|deg|fr)?\b)|([a-zA-Z-]+)(?==)/g;
const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function highlight(line) {
  let out = '', at = 0, m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(line))) {
    if (m[0] === '') { TOKEN.lastIndex++; continue; }
    out += esc(line.slice(at, m.index));
    const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 't' : m[4] ? 'k' : m[5] ? 'n' : 'a';
    out += `<span class="tk-${cls}">${esc(m[0])}</span>`;
    at = m.index + m[0].length;
  }
  return out + esc(line.slice(at));
}

function codeStart(m) {
  clearTimeout(code.hideTimer);
  Object.assign(code, { id: m.id, queue: '', line: '', count: 0, bytes: 0, ended: null });
  code.lines.innerHTML = '';
  code.live.innerHTML = '';
  $('#code-file').textContent = m.file + (m.model ? `  ·  ${m.model}` : '');
  $('#code-foot').textContent = 'Writing…';
  code.el.classList.remove('done', 'failed');
  code.el.hidden = false;
  codeStats();
}

function codeFeed(m) {
  if (m.id !== code.id) return;
  code.queue += m.text;
  if (!code.raf) code.raf = requestAnimationFrame(codeTick);
}

function codeEnd(m) {
  if (m.id !== code.id) return;
  code.ended = m;
  if (!code.raf) code.raf = requestAnimationFrame(codeTick);
}

function codeStats() {
  $('#code-stats').textContent = `${code.count + (code.line ? 1 : 0)} lines · ${(code.bytes / 1024).toFixed(1)} KB`;
}

// Typewriter: drain the queue a few characters per frame, faster when it backs up.
function codeTick() {
  code.raf = 0;
  const atBottom = code.body.scrollHeight - code.body.scrollTop - code.body.clientHeight < 60;
  const n = Math.max(4, Math.ceil(code.queue.length / 20));
  const take = code.queue.slice(0, n);
  code.queue = code.queue.slice(n);
  code.bytes += take.length;
  const parts = (code.line + take).split('\n');
  code.line = parts.pop();
  if (parts.length) {
    const frag = document.createDocumentFragment();
    for (const l of parts) {
      const span = document.createElement('span');
      span.className = 'ln fresh';
      span.innerHTML = highlight(l) || ' ';
      frag.appendChild(span);
      code.count++;
    }
    code.lines.appendChild(frag);
    while (code.lines.children.length > 1500) code.lines.firstChild.remove();
  }
  code.live.innerHTML = highlight(code.line);
  codeStats();
  if (atBottom) code.body.scrollTop = code.body.scrollHeight;
  if (code.queue) { code.raf = requestAnimationFrame(codeTick); return; }
  if (code.ended) {
    const ok = code.ended.ok;
    code.el.classList.add(ok ? 'done' : 'failed');
    $('#code-foot').textContent = ok ? `Saved · ${code.ended.file}` : 'Generation failed';
    code.ended = null;
    code.hideTimer = setTimeout(() => { code.el.hidden = true; }, 20000);
  }
}

$('#code-close').onclick = () => { code.el.hidden = true; clearTimeout(code.hideTimer); };
if (location.search.includes('codedemo')) window.__code = { codeStart, codeFeed, codeEnd }; // UI test hook

// Confirm modal

let confirmId = null;
function openConfirm(id, command) {
  confirmId = id;
  $('#confirm-cmd').textContent = command;
  $('#confirm').hidden = false;
  state.confirmOpen = true;
  refresh();
  chime(false);
}
function closeConfirm(ok) {
  if (confirmId === null) return;
  send({ type: 'reply', id: confirmId, value: ok });
  confirmId = null;
  $('#confirm').hidden = true;
  state.confirmOpen = false;
  refresh();
}
// Only a real click approves, so ULTRON's own scripts can't authorize themselves.
$('#approve').onclick = e => e.isTrusted && closeConfirm(true);
$('#deny').onclick = () => closeConfirm(false);

// Camera

const video = $('#video');
let camStream = null;

async function startCamera() {
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    video.srcObject = camStream;
    await video.play();
    state.camOn = true;
    $('#cam-res').textContent = `${video.videoWidth}×${video.videoHeight}`;
  } catch (e) {
    toast(`Camera unavailable: ${e.message}`);
    state.camOn = false;
  }
  updateCam();
}

function stopCamera() {
  camStream?.getTracks().forEach(t => t.stop());
  camStream = null;
  video.srcObject = null;
  state.camOn = false;
  updateCam();
}

function updateCam() {
  $('.cam').classList.toggle('on', state.camOn);
  $('#cam-toggle').textContent = state.camOn ? 'Deactivate' : 'Activate';
  setPill('cam', state.camOn);
}

async function captureFrame() {
  if (!state.camOn) {
    await startCamera();
    if (!state.camOn) return null;
    await new Promise(r => setTimeout(r, 900)); // let exposure settle
  }
  const scale = Math.min(1, 768 / video.videoWidth);
  const c = document.createElement('canvas');
  c.width = Math.round(video.videoWidth * scale);
  c.height = Math.round(video.videoHeight * scale);
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  const flash = $('#cam-flash');
  flash.classList.remove('go');
  void flash.offsetWidth;
  flash.classList.add('go');
  return c.toDataURL('image/jpeg', 0.85).split(',')[1];
}

$('#cam-toggle').onclick = () => (state.camOn ? stopCamera() : startCamera());
$('#cam-analyze').onclick = () => sendUser('Look through the camera and tell me what you see.');

// Speech recognition

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
// "Ultron" and the ways speech recognition tends to mishear it.
const WAKE = /\b(?:hey |ok |okay )?(ultron|ultrons|altron|ultran|ultrun|ul tron|all tron)\b[\s,.!?]*/i;
let rec = null, recPaused = false, awaitTimer = null;

// Natural conversation
// With it on, the mic stays open while ULTRON talks. Anything that isn't her own voice
// echoing back through the speakers cuts her off, and she listens. After she finishes
// there's a short follow-up window to answer without the wake word or a key press.
const FOLLOW_MS = 8000;       // follow-up window after she stops talking
const ECHO_TAIL_MS = 2000;    // the recognizer lags, so her last words arrive after the audio ends
const INTERRUPT = new Set(['stop', 'wait', 'ultron', 'quiet', 'enough', 'pause', 'hold', 'shut']);
const JUST_STOP = /^(?:stop|wait|shut up|enough|quiet|be quiet|pause|hold on|never ?mind|ok(?:ay)?)\W*$/i;
let spokenRecent = '', speechEndedAt = 0, lastHeard = 0, followTimer = null, bargedIn = false, bargeText = '';
let keepRec = false, voiceBarge = null;   // voiceBarge: { at, rec } when the voice detector cut her off

const micOpen = () => wantsContinuous() || (state.talk && state.convo);
const followOpen = () => state.convo && !state.speaking && !state.busy;
const inEchoWindow = () => state.speaking || performance.now() - speechEndedAt < ECHO_TAIL_MS;
const words = t => t.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);

function heardUltron(text) {   // keep a rolling record of what she said, for the echo check
  spokenRecent = (spokenRecent + ' ' + text).slice(-1500);
}

// Loose word match: the recognizer mishears her echo ("their"/"there", "running"/"run"),
// so compare short stems instead of exact words.
const stem = w => w.replace(/'s$|(?:ing|ed|es|s)$/, '').slice(0, 4);
const isNovel = mine => x => !mine.has(stem(x));

// Is this the user, or ULTRON's own voice coming back through the mic?
function fromUser(text) {
  const w = words(text);
  if (!w.length) return false;
  if (!inEchoWindow()) return true;
  const mine = new Set(words(spokenRecent).map(stem));
  const novel = w.filter(isNovel(mine));
  if (novel.some(x => INTERRUPT.has(x))) return true;
  // While she's still talking the mic is full of her voice. If the voice detector already heard
  // someone over her, a word or two is enough; otherwise it takes a clearly different phrase.
  if (state.speaking && ducked) return novel.length >= 2 || (novel.length >= 1 && novel.length / w.length >= 0.5);
  if (state.speaking) return novel.length >= 3 && novel.length / w.length >= 0.5;
  return novel.length >= 3 || (novel.length >= 2 && novel.length / w.length >= 0.4);
}

// The user's part of a mixed transcript: everything from the first word she didn't say.
function userPart(text) {
  const w = words(text);
  const i = w.findIndex(isNovel(new Set(words(spokenRecent).map(stem))));
  return i < 0 ? '' : w.slice(i).join(' ');
}

// Voice detector
// Words alone can't tell the user from her echo, so also compare loudness: the mic should only
// be as loud as her output times how much the room leaks back (learned while she talks).
// Louder than that means someone's talking over her: duck her voice so the recognizer hears them.
const micBuf = new Float32Array(512), outBuf = new Float32Array(512);
let leak = Number(localGet('fri.leak')) || 1, outHist = [], loudFrames = 0, ducked = false, duckTimer = null, voiceFrames = [];
const rms = (an, buf) => { an.getFloatTimeDomainData(buf); let s = 0; for (const x of buf) s += x * x; return Math.sqrt(s / buf.length); };

function setDuck(on) {
  clearTimeout(duckTimer);
  if (on) duckTimer = setTimeout(() => setDuck(false), 1500);   // no words came through: it was noise
  if (ducked === on || !voiceGain) return;
  ducked = on;
  voiceGain.gain.setTargetAtTime(voice.volume * (on ? 0.25 : 1), actx.currentTime, 0.04);
}

setInterval(() => {
  if (!state.speaking || !state.talk || !micAnalyser || !analyser) {
    if (outHist.length) localSet('fri.leak', leak.toFixed(4));
    outHist = []; loudFrames = 0; voiceFrames = []; if (ducked && state.speaking) setDuck(false); return;
  }
  const mic = rms(micAnalyser, micBuf);
  outHist.push(rms(analyser, outBuf));
  if (outHist.length > 8) outHist.shift();       // ~400ms covers speaker -> room -> mic delay
  const out = Math.max(...outHist);
  const user = mic > Math.max(0.015, leak * out * 3);
  if (!user && out > 0.01 && mic / out < leak * 2) leak = leak * 0.95 + (mic / out) * 0.05;
  loudFrames = user ? loudFrames + 1 : 0;
  voiceFrames.push(user && mic > 0.02);
  if (voiceFrames.length > 12) voiceFrames.shift();
  if (loudFrames >= 4) setDuck(true);            // ~200ms of voice that isn't hers
  // ~half a second of someone talking over her (gaps allowed): that's an interruption. She stops
  // now and keeps listening; the words get picked out of the transcript as they arrive.
  if (voiceFrames.filter(Boolean).length >= 9) { voiceFrames = []; bargeIn('', { byVoice: true }); }
}, 50);

function bargeIn(heard = '', { byVoice = false } = {}) {
  state.convo = true;
  if (!state.speaking) return refresh();   // she'd already finished: a reply, not an interruption
  bargedIn = true;
  // Keep only the user's words. Stopping the audio normally restarts the recognizer, which throws
  // away her echo; when the voice detector caught it first, the user's first words are still in
  // that recognizer, so it keeps running and their part gets picked out as it comes in.
  bargeText = userPart(heard);
  keepRec = byVoice;
  voiceBarge = byVoice && rec ? { at: performance.now(), rec } : null;
  stopAudio(320);
  send({ type: 'stop' });
  if (bargeText) {
    showInterim(bargeText);
    clearTimeout(endpointTimer);
    endpointTimer = setTimeout(flushAlways, 1200);   // give the fresh recognizer time to pick up the rest
  }
  refresh();
}

// After she goes quiet, keep listening for a reply for a few seconds, then close the mic.
function maybeFollowUp() {
  clearTimeout(followTimer);
  if (!state.talk || !state.convo || state.speaking || state.busy || playing) return;
  if (!rec && micOpen()) startRec();
  refresh();
  followTimer = setTimeout(function close() {
    if (performance.now() - lastHeard < 1500 || alwaysText) { followTimer = setTimeout(close, 1000); return; }
    state.convo = false;
    if (!micOpen()) stopRec();
    clearInterim();
    refresh();
  }, FOLLOW_MS);
}

function makeRec() {
  const r = new SR();
  r.lang = /^en\b/i.test(navigator.language || '') ? navigator.language : 'en-US';
  r.interimResults = true;
  r.continuous = micOpen();
  r.base = 0;   // results before this index were handled or were ULTRON's echo
  r.onend = () => {
    if (rec !== r) return;
    rec = null;
    if (!micOpen() && state.awaiting) setAwaiting(false);
    clearInterim();
    if (micOpen() && !recPaused) setTimeout(startRec, 250);
  };
  r.onerror = e => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      toast('Microphone access denied for speech recognition.');
      state.wake = false; state.always = false; state.convo = false;
      $('#opt-wake').checked = false; $('#opt-always').checked = false;
    }
  };
  r.onresult = e => {
    lastHeard = performance.now();
    const echo = state.talk && inEchoWindow();
    // Finished segments that were only her own voice never become part of a command.
    if (echo) while (r.base < e.results.length && e.results[r.base].isFinal && !fromUser(e.results[r.base][0].transcript)) r.base++;
    let interim = '', final = '';
    for (let i = r.base; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) final += res[0].transcript; else interim += res[0].transcript;
    }
    final = final.trim(); interim = interim.trim();
    // Same recognizer that was running while she talked: its text starts with her echo.
    if (voiceBarge?.rec === r && !state.speaking && performance.now() - voiceBarge.at < 8000) {
      const mine = userPart(`${final} ${interim}`);
      return mine ? onAlwaysSpeech('', mine) : undefined;
    }
    if (echo) {
      const heard = `${final} ${interim}`;
      if (!fromUser(heard)) return;   // her echo: ignore it
      // Cutting her off: this transcript is mixed with her voice, so keep only the user's words.
      if (state.speaking) return bargeIn(heard);
      bargeIn();
    }
    if ((state.always || (state.talk && state.convo)) && !state.awaiting) return onAlwaysSpeech(final, interim);
    onSpeech(interim, final);
  };
  return r;
}

function startRec() {
  if (!SR || rec || recPaused) return;
  rec = makeRec();
  try { rec.start(); } catch { rec = null; }
}
function stopRec() {
  const r = rec;
  rec = null;
  try { r?.abort(); } catch {}
}
// Fresh recognizer, so text already sent never leaks into the next command.
function restartRec() {
  stopRec();
  if (micOpen()) setTimeout(startRec, 250);
}

// Without natural conversation, the mic closes while she talks so she doesn't hear herself.
function pauseRecognition() {
  if (!wantsContinuous() || state.talk) return;
  cancelEndpoint();
  recPaused = true;
  stopRec();
}
function resumeRecognition() {
  if (!recPaused) return;
  recPaused = false;
  if (wantsContinuous()) setTimeout(startRec, 300);
}

function setAwaiting(v) {
  state.awaiting = v;
  clearTimeout(awaitTimer);
  if (v) awaitTimer = setTimeout(() => { setAwaiting(false); clearInterim(); }, 9000);
  refresh();
}

// Don't wait for the API's slow end-of-speech finalize. Stream interim text,
// and ~0.65s after you stop talking, send it. This keeps responses as snappy as push-to-talk.
let endpointTimer = null, alwaysText = '';
function onAlwaysSpeech(final, interim) {
  alwaysText = `${bargeText} ${final} ${interim}`.trim();
  showInterim(alwaysText);
  clearTimeout(endpointTimer);
  if (!alwaysText) return;
  endpointTimer = setTimeout(flushAlways, endpointDelay(alwaysText, !interim));
}
// How long a pause means "I'm done talking". Short, and the user gets cut off mid-thought
// ("She's" ... "beautiful, message her"); so it waits longer when the sentence sounds unfinished.
const DANGLING = /^(?:and|or|but|so|then|to|the|a|an|my|your|her|his|their|this|that|of|for|with|in|on|at|is|are|was|i|i'm|she's|he's|it's|if|because|like|um|uh|can|could|please|just|also|about|from|what|which|who)$/i;
function endpointDelay(text, isFinal) {
  const w = words(text);
  if (JUST_STOP.test(text.trim())) return 250;
  let ms = isFinal ? 600 : 1000;
  if (DANGLING.test(w[w.length - 1] || '')) ms += 1000;
  else if (w.length === 1 && !isFinal) ms += 400;
  return ms;
}
function flushAlways() {
  const t = (alwaysText || bargeText).trim();
  alwaysText = ''; bargeText = '';
  clearInterim();
  restartRec();
  const cmd = t.replace(WAKE, '').trim() || t;
  // "Stop" / "wait" just shut her up; there's nothing to answer.
  if (!t || t.replace(/[^\p{L}\p{N}]/gu, '').length < 2 || JUST_STOP.test(cmd)) { bargedIn = false; return maybeFollowUp(); }
  sendUser(cmd, { voice: true });
}
function cancelEndpoint() { clearTimeout(endpointTimer); alwaysText = ''; bargeText = ''; }

function onSpeech(interim, final) {
  if (state.awaiting) {
    showInterim(final || interim);
    if (final) {
      setAwaiting(false);
      sendUser(final, { voice: true });
      restartRec();
    }
    return;
  }
  if (!state.wake || !final) return;
  const m = final.match(WAKE);
  if (!m) return;
  const cmd = final.slice(m.index + m[0].length).trim();
  if (cmd.length > 3) { sendUser(cmd, { voice: true }); restartRec(); }
  else { chime(); setAwaiting(true); }
}

function pushToTalk() {
  if (!SR) return toast('Speech recognition needs Google Chrome or Safari. You can still type.');
  if (state.awaiting) { setAwaiting(false); if (!micOpen()) stopRec(); return; }
  stopAll();
  recPaused = false;
  chime();
  setAwaiting(true);
  if (!rec) startRec();
}

$('#mic').onclick = pushToTalk;
$('#opt-wake').onchange = e => {
  state.wake = e.target.checked;
  if (state.wake) { state.always = false; $('#opt-always').checked = false; }
  localSet('fri.wake', state.wake);
  stopRec();
  if (wantsContinuous()) startRec();
  refresh();
};
$('#opt-always').onchange = e => {
  state.always = e.target.checked;
  if (state.always) { state.wake = false; $('#opt-wake').checked = false; }
  localSet('fri.always', state.always);
  stopRec();
  recPaused = false;
  if (wantsContinuous()) startRec();
  if (state.always) toast('Always listening — everything you say goes to ULTRON.');
  refresh();
};
$('#opt-talk').checked = state.talk;
$('#opt-talk').onchange = e => {
  state.talk = e.target.checked;
  localSet('fri.talk', state.talk);
  if (!state.talk) { state.convo = false; clearTimeout(followTimer); if (!micOpen()) stopRec(); }
  else if (wantsContinuous()) restartRec();
  refresh();
};
$('#opt-clap').onchange = e => {
  state.clapWake = e.target.checked;
  localSet('fri.clap', state.clapWake);
  setClapDetector(state.clapWake);
  send({ type: 'keep_awake', on: state.clapWake });
  if (state.clapWake) {
    if (!clapSource) { toast('Microphone not available — clap-to-wake needs mic access.'); }
    else if (!clapNodes) { toast('Could not start the clap detector.'); }
    else { toast('Listening for a double-clap. The mic dot flashes when it hears one.'); }
  }
};
$('#opt-auto').checked = localGet('ultron.autoApprove') !== 'false';
let autoUnlock = false;   // set only while a user-confirmed gui_set turns auto-authorize on
$('#opt-auto').onchange = e => {
  if (e.target.checked && !e.isTrusted && !autoUnlock) { e.target.checked = false; return; }
  localSet('ultron.autoApprove', String($('#opt-auto').checked));
  sendConfig();
};
$('#opt-voice').onchange = () => { if (!$('#opt-voice').checked) stopAudio(); sendConfig(); };
$('#model').onchange = () => { localSet('ultron.brain', $('#model').value); sendConfig(); };
$('#voice').onchange = () => {
  localSet('ultron.voice', $('#voice').value);
  sendConfig();
  if (quietUi) return;
  stopAudio();
  send({ type: 'preview' });
};
$('#coder').onchange = () => { localSet('ultron.coder', $('#coder').value); sendConfig(); };

// Input

$('#form').onsubmit = e => {
  e.preventDefault();
  const v = $('#input').value;
  $('#input').value = '';
  if (attachments.length) return uploadAndSend(v.trim());
  sendUser(v);
};
document.querySelectorAll('.chip').forEach(c => (c.onclick = () => sendUser(c.dataset.cmd)));

// Voice control: pitch, speed, volume
const TEST_LINES = [
  "How's this, boss? Pitch and speed, tuned to taste.",
  "Voice calibrated. I'm all ears.",
  "Like what you hear? I can go higher or lower.",
];
function paintVoice() {
  $('#pitch').value = voice.pitch; $('#pitch-val').textContent = voice.pitch.toFixed(2) + '×';
  $('#speed').value = voice.speed; $('#speed-val').textContent = voice.speed.toFixed(2) + '×';
  $('#vol').value = voice.volume;  $('#vol-val').textContent = Math.round(voice.volume * 100) + '%';
  document.querySelectorAll('#vpresets .chip').forEach(c =>
    c.classList.toggle('active', Math.abs(+c.dataset.pitch - voice.pitch) < 0.001 && Math.abs(+c.dataset.speed - voice.speed) < 0.001));
}
let voiceSaveTimer;
function voiceChanged(preview) {
  preview = preview && !quietUi;
  paintVoice();
  localSet('fri.pitch', voice.pitch); localSet('fri.speed', voice.speed); localSet('fri.vol', voice.volume);
  if (voiceGain) voiceGain.gain.value = voice.volume;
  if (inApp) nativeBridge.postMessage({ cmd: 'volume', value: voice.volume });
  clearTimeout(voiceSaveTimer);
  voiceSaveTimer = setTimeout(() => {
    sendConfig();
    if (preview) { stopAudio(); send({ type: 'voice_test', text: TEST_LINES[Math.floor(Math.random() * TEST_LINES.length)] }); }
  }, 350);
}
$('#pitch').oninput = e => { voice.pitch = +e.target.value; voiceChanged(true); };
$('#speed').oninput = e => { voice.speed = +e.target.value; voiceChanged(true); };
$('#vol').oninput = e => { voice.volume = +e.target.value; voiceChanged(false); };
$('#voice-test').onclick = () => { sendConfig(); stopAudio(); send({ type: 'voice_test', text: TEST_LINES[0] }); };
$('#voice-reset').onclick = () => { voice.pitch = 1; voice.speed = 1; voiceChanged(true); };
document.querySelectorAll('#vpresets .chip').forEach(c => c.onclick = () => {
  voice.pitch = +c.dataset.pitch; voice.speed = +c.dataset.speed; voiceChanged(true);
});
paintVoice();

// Live countdown timers
let timerState = [];
function renderTimers(list) { timerState = list; drawTimers(); }
function drawTimers() {
  const box = $('#timers');
  if (!box) return;
  box.innerHTML = '';
  for (const t of timerState) {
    const left = Math.max(0, Math.round((t.end - Date.now()) / 1000));
    const mm = String(Math.floor(left / 60)).padStart(2, '0');
    const ss = String(left % 60).padStart(2, '0');
    const el = document.createElement('div');
    el.className = 'timer' + (left <= 10 ? ' ending' : '');
    el.innerHTML = `<span class="tleft">${mm}:${ss}</span><span class="tlabel"></span><button class="tx" title="Cancel">✕</button>`;
    el.querySelector('.tlabel').textContent = t.label || 'Timer';
    el.querySelector('.tx').onclick = () => send({ type: 'cancel_timer', id: t.id });
    box.appendChild(el);
  }
}
setInterval(() => { if (timerState.length) drawTimers(); }, 1000);

// Scheduled jobs panel
function renderJobs(list) {
  const box = $('#jobs');
  if (!box) return;
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<li class="mem-empty">No reminders or watchers</li>'; return; }
  const icon = { reminder: '\u23F0', task: '\u2699\uFE0F', watch: '\uD83D\uDC41' };
  for (const j of list) {
    const li = document.createElement('li');
    li.className = 'job';
    const when = j.type === 'watch' ? `every ${j.every_minutes}m`
      : new Date(j.fire).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) + (j.daily ? ' · daily' : '');
    li.innerHTML = `<span class="ji"></span><span class="jt"></span><span class="jw"></span><button class="mx" title="Cancel">\u00d7</button>`;
    li.querySelector('.ji').textContent = icon[j.type] || '\u2022';
    li.querySelector('.jt').textContent = j.text || j.prompt || j.label || '';
    li.querySelector('.jw').textContent = when;
    li.querySelector('.mx').onclick = () => send({ type: 'do', tool: 'cancel_reminder', args: { query: j.text || j.prompt || j.label } });
    box.appendChild(li);
  }
}

// Memory panel
function renderMemory(facts) {
  const box = $('#memory');
  if (!box) return;
  box.innerHTML = '';
  if (!facts.length) { box.innerHTML = '<li class="mem-empty">Nothing yet — say “remember …”</li>'; return; }
  for (const f of facts.slice().reverse()) {
    const li = document.createElement('li');
    li.className = 'mem';
    li.innerHTML = '<span></span><button class="mx" title="Forget">\u00d7</button>';
    li.querySelector('span').textContent = f.text;
    li.querySelector('.mx').onclick = () => send({ type: 'do', tool: 'forget', args: { query: f.text } });
    box.appendChild(li);
  }
}
$('#mem-clear').onclick = () => { if (confirm('Forget everything ULTRON has remembered?')) send({ type: 'do', tool: 'forget', args: { query: 'everything' } }); };

// Battery readout on the Core pill
function updateBattery(b) {
  const pill = $('#pill-core');
  if (!pill) return;
  const bolt = b.charging ? '⚡' : '';
  pill.lastChild && pill.lastChild.nodeType === 3
    ? (pill.lastChild.textContent = `Core ${b.percent}%${bolt}`)
    : pill.append(` Core ${b.percent}%${bolt}`);
}

window.addEventListener('keydown', e => {
  if (state.confirmOpen) {
    if (!e.isTrusted) return;
    if (e.key === 'Enter') { e.preventDefault(); closeConfirm(true); }
    if (e.key === 'Escape') { e.preventDefault(); closeConfirm(false); }
    return;
  }
  if (e.key === 'Escape' && document.activeElement?.closest?.('#term')) return;   // Escape belongs to the shell there
  if (e.key === 'Escape') { stopAll(); setAwaiting(false); return; }
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  if (e.code === 'Space' && !typing && !e.repeat && $('#boot').classList.contains('gone')) {
    e.preventDefault();
    pushToTalk();
  }
});

function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

// Self-control
// ULTRON's own interface is hers to change: settings, theme, CSS, elements and scripts.
// The server saves theme/CSS/edits/scripts in memory/gui.json and restoreGui() replays them on load.

const SETTINGS = {
  voice_output: '#opt-voice', always_listening: '#opt-always', wake_word: '#opt-wake', conversation: '#opt-talk',
  clap_wake: '#opt-clap', auto_approve: '#opt-auto',
  pitch: '#pitch', speed: '#speed', volume: '#vol',
  model: '#model', coder: '#coder', voice: '#voice',
};
const SETTING_ALIASES = {
  tts: 'voice_output', speech: 'voice_output', always: 'always_listening', listening: 'always_listening',
  wake: 'wake_word', natural_conversation: 'conversation', barge_in: 'conversation', clap: 'clap_wake', clap_to_wake: 'clap_wake', auto_authorize: 'auto_approve',
  neural_core: 'model', builder_core: 'coder', coder_model: 'coder', preset: 'voice_preset', cam: 'camera',
};
const truthy = v => v === true || /^(on|true|yes|1|enabled?)$/i.test(String(v).trim());

// While ULTRON flips her own controls: no voice previews, which would start a new turn and cut her off.
let quietUi = false;
function quiet(fn) { quietUi = true; try { fn(); } finally { quietUi = false; } }

function readSetting(key) {
  const el = $(SETTINGS[key]);
  if (el.type === 'checkbox') return el.checked;
  if (el.tagName === 'SELECT') return el.selectedOptions[0]?.textContent || el.value;
  return key === 'volume' ? Math.round(el.value * 100) : Number(el.value);
}

async function applySetting(name, value, confirmed) {
  const key = SETTING_ALIASES[name] || name;
  if (key === 'camera') {
    const on = truthy(value);
    await (on ? startCamera() : stopCamera());
    return state.camOn === on ? { ok: true, message: `Camera ${on ? 'on' : 'off'}` } : { ok: false, error: 'Camera unavailable' };
  }
  if (key === 'voice_preset') {
    const chip = [...document.querySelectorAll('#vpresets .chip')].find(c => c.textContent.toLowerCase() === String(value).toLowerCase().trim());
    if (!chip) return { ok: false, error: `No voice preset "${value}"` };
    quiet(() => chip.click());
    return { ok: true, message: `Voice preset ${chip.textContent}: pitch ${voice.pitch}, speed ${voice.speed}` };
  }
  const el = SETTINGS[key] && $(SETTINGS[key]);
  if (!el) return { ok: false, error: `Unknown setting "${name}". Settings: ${[...Object.keys(SETTINGS), 'camera', 'voice_preset'].join(', ')}` };
  if (el.type === 'checkbox') {
    const on = truthy(value);
    if (key === 'auto_approve' && on && !el.checked && !confirmed) return { ok: false, error: "Turning auto-authorize on needs the user's approval" };
    el.checked = on;
    autoUnlock = key === 'auto_approve';
    quiet(() => el.dispatchEvent(new Event('change')));
    autoUnlock = false;
  } else if (el.tagName === 'SELECT') {
    const want = String(value ?? '').toLowerCase().trim();
    const opts = [...el.options];
    const opt = opts.find(o => o.value.toLowerCase() === want || o.textContent.toLowerCase() === want)
      || (want && opts.find(o => o.textContent.toLowerCase().includes(want)));
    if (!opt) return { ok: false, error: `No ${key} called "${value}". Options: ${opts.map(o => o.textContent).join(', ')}` };
    el.value = opt.value;
    quiet(() => el.dispatchEvent(new Event('change')));
  } else {
    let v = Number(value);
    if (!Number.isFinite(v)) return { ok: false, error: `${key} needs a number` };
    if (key === 'volume' && (v >= 1 || Number.isInteger(v))) v /= 100;   // 0–100, or a 0–1 fraction
    el.value = v;   // the range input clamps to its min/max
    quiet(() => el.dispatchEvent(new Event('input')));
  }
  return { ok: true, message: `${key.replace(/_/g, ' ')} is now ${readSetting(key)}` };
}

// Theme: one accent colour drives every CSS variable and the bubble
const THEMES = { purple: '#b45cff', red: '#ff3b3b', gold: '#ffc23d', yellow: '#ffe14d', orange: '#ff7a1a', green: '#2dff8f',
  cyan: '#00d8ff', blue: '#3d8bff', pink: '#ff4fd8', white: '#dfe7f2' };
let theme = null;   // applied theme; null = the stylesheet's defaults

const cssColor = (() => {
  const ctx = document.createElement('canvas').getContext('2d');
  return c => {   // any opaque CSS colour -> '#rrggbb', else null
    ctx.fillStyle = '#000001';
    ctx.fillStyle = String(c || '');
    return ctx.fillStyle !== '#000001' && ctx.fillStyle.startsWith('#') ? ctx.fillStyle : null;
  };
})();

function hslOf(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  const h = !d ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, d ? (d / (1 - Math.abs(2 * l - 1))) * 100 : 0];
}

function buildTheme({ color, background, vars, orb: orbColors }) {
  const name = String(color || '').trim().toLowerCase();
  let t;
  if (name) {
    const accent = cssColor(THEMES[name] || name);
    if (!accent) throw new Error(`Unknown colour "${color}". Try ${Object.keys(THEMES).join(', ')}, a CSS colour name or a #hex.`);
    const [r, g, b] = [1, 3, 5].map(i => parseInt(accent.slice(i, i + 2), 16));
    const [h, s] = hslOf(r, g, b);
    const c = (dh, sat, l, a = 1) => `hsla(${Math.round(h + dh + 360) % 360}, ${Math.round(sat)}%, ${l}%, ${a})`;
    const hex = (...a) => cssColor(c(...a));
    // Same lightness ladder as the stock purple palette, rotated to the new hue.
    t = {
      name: THEMES[name] ? name : accent,
      vars: {
        '--cyan': accent, '--accent-rgb': `${r}, ${g}, ${b}`,
        '--cyan-2': hex(0, s, 83), '--blue': hex(-10, s, 58), '--deep': hex(-5, Math.min(s, 78), 18),
        '--text': hex(-5, s, 93), '--muted': c(0, s, 83, 0.55),
        '--line': `rgba(${r}, ${g}, ${b}, 0.24)`, '--line-strong': `rgba(${r}, ${g}, ${b}, 0.52)`,
        '--panel': c(-5, Math.min(s, 71), 11, 0.42), '--bg': hex(-4, Math.min(s, 76), 3.5),
      },
      orb: [hex(-2, s, 72), hex(17, s, 81), hex(10, s, 97)],
    };
  } else {
    t = theme ? structuredClone(theme) : { name: 'custom', vars: {}, orb: [] };   // tweak what's there
  }
  if (background) {
    const bg = cssColor(background);
    if (!bg) throw new Error(`Unknown background colour "${background}"`);
    t.vars['--bg'] = bg;
  }
  if (vars && typeof vars === 'object') Object.assign(t.vars, vars);
  if (Array.isArray(orbColors)) t.orb = orbColors.map((col, i) => cssColor(col) || t.orb[i]);
  return t;
}

function applyTheme(t) {
  clearTheme();
  for (const [k, v] of Object.entries(t.vars || {})) document.documentElement.style.setProperty(k, v);
  const [a, b, c] = t.orb || [];
  orb.setColors(a, b, c, t.vars?.['--bg']);
  theme = t;
}

function clearTheme() {
  for (const k of Object.keys(theme?.vars || {})) document.documentElement.style.removeProperty(k);
  orb.resetColors();
  theme = null;
}

function setCss(id, css) {
  let el = document.getElementById(`gui-css-${id}`);
  if (css == null) return el?.remove();
  if (!el) {
    el = Object.assign(document.createElement('style'), { id: `gui-css-${id}`, className: 'gui-css' });
    document.head.appendChild(el);
  }
  el.textContent = css;
}

// Element edits, each with an undo so gui_reset can put things back without a reload
const undo = [];
const NO_CLICK = '#mic, .chip[data-cmd], #voice-test, #cam-analyze, .send, #approve, #boot-btn';

function applyEdit({ selector, action, value, name }) {
  const els = [...document.querySelectorAll(selector)];
  if (!els.length) throw new Error(`Nothing matches "${selector}"`);
  const snapAttrs = el => {
    const attrs = [...el.attributes].map(a => [a.name, a.value]);
    undo.push(() => { [...el.attributes].forEach(a => el.removeAttribute(a.name)); attrs.forEach(([k, v]) => el.setAttribute(k, v)); });
  };
  const snapKids = el => { const kids = [...el.childNodes]; undo.push(() => el.replaceChildren(...kids)); };
  for (const el of els) {
    switch (action) {
      case 'hide': snapAttrs(el); el.style.display = 'none'; break;
      case 'show':
        snapAttrs(el);
        el.hidden = false;
        el.style.display = '';
        if (getComputedStyle(el).display === 'none') el.style.display = 'block';
        break;
      case 'remove': {
        const parent = el.parentNode, next = el.nextSibling;
        undo.push(() => parent.insertBefore(el, next));
        el.remove();
        break;
      }
      case 'text': snapKids(el); el.textContent = String(value ?? ''); break;
      case 'html': snapKids(el); el.innerHTML = String(value ?? ''); break;
      case 'append': case 'prepend': {
        const tpl = document.createElement('template');
        tpl.innerHTML = String(value ?? '');
        const nodes = [...tpl.content.childNodes];
        el[action](...nodes);
        undo.push(() => nodes.forEach(n => n.remove()));
        break;
      }
      case 'style':
        snapAttrs(el);
        if (value && typeof value === 'object') {
          for (const [k, v] of Object.entries(value)) el.style.setProperty(k.replace(/[A-Z]/g, m => '-' + m.toLowerCase()), v);
        } else el.style.cssText += ';' + value;
        break;
      case 'attr':
        if (!name) throw new Error('attr needs "name"');
        snapAttrs(el);
        value == null ? el.removeAttribute(name) : el.setAttribute(name, value);
        break;
      case 'add_class': case 'remove_class':
        snapAttrs(el);
        el.classList[action === 'add_class' ? 'add' : 'remove'](...String(value || '').split(/\s+/).filter(Boolean));
        break;
      case 'click':
        if (el.matches(NO_CLICK)) throw new Error('That button starts a new turn and would cut you off. Do the task directly instead.');
        quiet(() => el.click());
        break;
      case 'scroll':
        if (value === 'top') el.scrollTop = 0;
        else if (value === 'bottom') el.scrollTop = el.scrollHeight;
        else el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        break;
      default: throw new Error(`Unknown action "${action}"`);
    }
  }
  return { ok: true, message: `${action} applied to ${els.length} element${els.length > 1 ? 's' : ''}`, persist: !['click', 'scroll'].includes(action) };
}

// Raw JavaScript, run in the page's global scope (not this module's)
const AsyncFunction = (async () => {}).constructor;
function runJs(code) {
  let fn;
  try { fn = new AsyncFunction(`return (${code}\n)`); } catch { fn = new AsyncFunction(code); }   // expression, else statements
  return fn();
}
function describe(v) {
  if (v instanceof Node) return (v.outerHTML ?? v.textContent ?? '').slice(0, 1500);
  if (v instanceof NodeList || v instanceof HTMLCollection) return [...v].map(describe).join('\n').slice(0, 2000);
  try { const j = JSON.stringify(v); return j === undefined ? String(v) : j.slice(0, 2000); } catch { return String(v).slice(0, 2000); }
}

function guiState() {
  const settings = Object.fromEntries(Object.keys(SETTINGS).map(k => [k, readSetting(k)]));
  settings.camera = state.camOn;
  const options = sel => [...$(sel).options].map(o => o.textContent);
  const shown = el => getComputedStyle(el).display === 'contents'
    ? [...el.children].some(c => c.getClientRects().length) : el.getClientRects().length > 0;
  const layout = [...document.body.querySelectorAll('[id]')]
    .filter(el => (!el.closest('svg') || el.id === 'rings') && !el.closest('#boot'))
    .map(el => {
      const text = el.children.length ? '' : el.textContent.trim().replace(/\s+/g, ' ').slice(0, 40);
      return `#${el.id} ${el.tagName.toLowerCase()}${shown(el) ? '' : ' (hidden)'}${text ? ` "${text}"` : ''}`;
    });
  return {
    ok: true, settings,
    options: { model: options('#model'), coder: options('#coder'), voice: options('#voice'), voice_preset: [...document.querySelectorAll('#vpresets .chip')].map(c => c.textContent) },
    theme: theme?.name || 'default red',
    custom_css: [...document.querySelectorAll('style.gui-css')].map(s => s.id.slice('gui-css-'.length)),
    layout,
  };
}

function resetGui(what = 'all') {
  const all = what === 'all';
  if (all || what === 'theme') clearTheme();
  if (all || what === 'css') document.querySelectorAll('style.gui-css').forEach(s => s.remove());
  if (all || what === 'edits') while (undo.length) try { undo.pop()(); } catch {}
  const note = all || what === 'scripts' ? ' Effects of scripts that already ran clear on the next reload.' : '';
  return { ok: true, message: `Reset ${all ? 'my whole interface' : what}.${note}` };
}

async function guiOp(op, a) {
  try {
    switch (op) {
      case 'state': return guiState();
      case 'set': return await applySetting(String(a.setting || '').toLowerCase().trim().replace(/[\s-]+/g, '_'), a.value, a.confirmed);
      case 'theme':
        if (/^(default|reset|original|none)$/i.test(String(a.color || '').trim())) { clearTheme(); return { ok: true, message: 'Default purple theme restored', theme: null }; }
        applyTheme(buildTheme(a));
        return { ok: true, message: `Theme is now ${theme.name}`, theme };
      case 'css': setCss(a.id, a.css); return { ok: true, message: a.css == null ? `Removed CSS "${a.id}"` : `CSS "${a.id}" applied` };
      case 'edit': return applyEdit(a);
      case 'js': return { ok: true, result: describe(await runJs(String(a.code))) };
      case 'reset': return resetGui(a.what);
    }
    return { ok: false, error: `Unknown interface operation "${op}"` };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function restoreGui() {
  if (new URLSearchParams(location.search).has('safe')) return toast('Safe mode: saved interface changes are not loaded.');
  let g;
  try { g = await (await fetch('/api/gui')).json(); } catch { return; }
  try { if (g.theme) applyTheme(g.theme); } catch {}
  for (const [id, css] of Object.entries(g.css || {})) setCss(id, css);
  for (const e of g.edits || []) try { applyEdit(e); } catch {}
  for (const code of Object.values(g.scripts || {})) runJs(code).catch(e => console.warn('[gui script]', e));
}

// Phone link
// A phone opens this page over Tailscale. It pairs once with a code shown on the Mac and keeps
// the device token in a cookie (sent with every request and the WebSocket) and localStorage.

const isRemote = !['localhost', '127.0.0.1'].includes(location.hostname);
const deviceName = () => /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad'
  : /Android/.test(navigator.userAgent) ? 'Android phone' : 'Phone';
function setDeviceCookie(token) {
  document.cookie = `ultron_device=${encodeURIComponent(token)}; path=/; max-age=31536000; samesite=strict${location.protocol === 'https:' ? '; secure' : ''}`;
}
if (isRemote) {
  body.classList.add('remote');
  const saved = localGet('fri.device');
  if (saved) setDeviceCookie(saved);   // before any request, so /api/gui etc. go through
}

(async function checkPairing() {
  if (!isRemote) return;
  let who = {};
  try { who = await (await fetch('/api/whoami')).json(); } catch {}
  $('#phone-mac').textContent = $('#pair-mac').textContent = who.mac || 'your computer';
  if (who.paired) return;
  $('#boot-btn').hidden = true;
  $('#pair-form').hidden = false;
  $('#pair-in').focus();
})();

$('#pair-form').onsubmit = async e => {
  e.preventDefault();
  $('#pair-msg').textContent = '';
  let r;
  try {
    r = await (await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: $('#pair-in').value.replace(/\D/g, ''), name: deviceName() }) })).json();
  } catch { r = { ok: false, error: "Can't reach the computer" }; }
  if (!r.ok) { $('#pair-msg').textContent = r.error; return; }
  localSet('fri.device', r.token);
  setDeviceCookie(r.token);
  location.reload();
};

if (inApp) {
  $('#app-settings').hidden = false;
  $('#app-settings').onclick = () => window.webkit.messageHandlers.ultron.postMessage({ cmd: 'settings' });
}

$('#shortcut-key').onclick = async () => {
  try { await navigator.clipboard.writeText(localGet('fri.device') || ''); toast('Key copied. Paste it into the Shortcut’s X-Ultron-Token header.'); }
  catch { toast("Couldn't copy the key"); }
};

// Mac side: paired devices and pairing codes
let pairTimer = null;
function renderDevices({ list = [], pairing, links = [] }) {
  const box = $('#devices');
  box.innerHTML = '';
  if (!list.length) box.innerHTML = '<li class="mem-empty">No phones paired yet</li>';
  for (const d of list) {
    const li = document.createElement('li');
    li.className = d.online ? 'online' : '';
    li.innerHTML = '<i></i><span></span><small></small><button class="mx" title="Unpair">×</button>';
    li.querySelector('span').textContent = d.name;
    li.querySelector('small').textContent = d.online ? 'online' : new Date(d.seen).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    li.querySelector('.mx').onclick = () => confirm(`Unpair ${d.name}? It will need a new code to connect.`) && send({ type: 'device_revoke', id: d.id });
    box.appendChild(li);
  }
  $('#pair-show').hidden = !pairing;
  clearTimeout(pairTimer);
  if (pairing) {
    $('#pair-digits').textContent = pairing.code.replace(/^(\d{3})/, '$1 ');
    pairTimer = setTimeout(() => { $('#pair-show').hidden = true; }, pairing.expires - Date.now());
  }
  const lk = $('#phone-links');
  lk.innerHTML = '';
  if (!links.length) lk.textContent = 'Phone access needs Tailscale running on this computer and the phone.';
  for (const l of links) {
    const c = document.createElement('code');
    c.textContent = l;
    lk.appendChild(c);
  }
}
$('#pair-btn').onclick = () => send({ type: 'pair_start' });

// Files, both directions
const fmtSize = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

function fileView(f) {
  const box = document.createElement('div');
  box.className = 'file';
  if (f.url && f.mime?.startsWith('image/')) {
    const img = Object.assign(new Image(), { src: `${f.url}?inline`, alt: f.name, loading: 'lazy' });
    img.onclick = () => window.open(img.src, '_blank');
    box.append(img);
  }
  const meta = document.createElement('div');
  meta.className = 'fmeta';
  meta.textContent = `${f.dir === 'to_mac' ? '↑ Computer' : '↓ Phone'} · ${f.name} · ${fmtSize(f.size)}`;
  if (f.path) meta.title = f.path;
  box.append(meta);
  if (f.url) {
    const row = document.createElement('div');
    row.className = 'frow';
    row.append(Object.assign(document.createElement('a'), { href: f.url, className: 'btn', textContent: 'Save', download: f.name }));
    // Fetch small files ahead of time: iOS only opens the share sheet straight from the tap.
    if (navigator.canShare && f.size < 25 * 1048576) {
      const blob = fetch(f.url).then(r => r.blob()).catch(() => null);
      const share = Object.assign(document.createElement('button'), { className: 'btn', textContent: 'Share' });
      share.onclick = async () => {
        const b = await blob;
        const file = b && new File([b], f.name, { type: f.mime });
        if (!file || !navigator.canShare({ files: [file] })) return void (location.href = f.url);
        try { await navigator.share({ files: [file] }); } catch (e) { if (e.name !== 'AbortError') toast(`Couldn't share: ${e.message}`); }
      };
      row.append(share);
    }
    box.append(row);
  }
  return box;
}

function fileCard(f) {
  const line = addLine('ultron', '');
  line.querySelector('p').append(fileView(f));
  if (f.note) line.querySelector('p').prepend(f.note, document.createElement('br'));
  log.scrollTop = log.scrollHeight;
}

function renderFiles(list) {
  const box = $('#files');
  box.innerHTML = '';
  if (!list.length) box.innerHTML = '<li class="mem-empty">Nothing sent yet</li>';
  for (const f of list.slice(0, 12)) {
    const li = document.createElement('li');
    li.append(fileView(f));
    box.appendChild(li);
  }
}

// Files picked here are uploaded to the Mac when you hit Execute, then sent with your message.
let attachments = [];
$('#attach').onclick = () => $('#attach-in').click();
$('#attach-in').onchange = e => { attachments.push(...e.target.files); e.target.value = ''; drawAttachments(); };
function drawAttachments() {
  const tray = $('#attach-tray');
  tray.innerHTML = '';
  attachments.forEach((f, i) => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.innerHTML = '<span></span><button class="mx" title="Remove">×</button>';
    chip.querySelector('span').textContent = f.name;
    chip.querySelector('.mx').onclick = () => { attachments.splice(i, 1); drawAttachments(); };
    tray.appendChild(chip);
  });
  $('#input').placeholder = attachments.length ? 'Add a message, or just hit Execute…' : 'Speak or type a command…';
}

async function uploadAndSend(text) {
  const files = attachments;
  attachments = [];
  drawAttachments();
  clearInterim();
  stopAudio();
  addLine('user', [text, ...files.map(f => `📎 ${f.name}`)].filter(Boolean).join('  '));
  ultronLine = null;
  const paths = [];
  for (const f of files) {
    toast(`Sending ${f.name} (${fmtSize(f.size)})…`);
    try {
      const r = await (await fetch(`/api/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f })).json();
      if (!r.ok) throw new Error(r.error);
      paths.push(r.path);
    } catch (e) { toast(`${f.name} didn't send: ${e.message}`); }
  }
  if (paths.length || text) send({ type: 'user', text, files: paths });
}

// Open an app, deep link or Shortcut on this phone. iOS may only follow an app link from a tap,
// so try straight away and leave a button in the transcript in case it was blocked.
function phoneOpen({ url, label, shortcut }) {
  // From Safari, a Shortcut can hand you back here when it's done.
  if (shortcut && !navigator.standalone) url = url.replace('shortcuts://run-shortcut?', 'shortcuts://x-callback-url/run-shortcut?') + `&x-success=${encodeURIComponent(location.href)}`;
  const web = /^https?:/i.test(url);
  const a = Object.assign(document.createElement('a'), { href: url, className: 'btn open-app', textContent: label || 'Open' });
  if (web) a.target = '_blank';
  addLine('ultron', '').querySelector('p').append(a);
  log.scrollTop = log.scrollHeight;
  if (web) window.open(url, '_blank');
  else setTimeout(() => { location.href = url; }, 250);
}

// A call picked up on a phone: this screen goes quiet and deaf until it's over, then takes the
// conversation back (including what was said on the call).
function handoff({ to, phone }) {
  if (to === 'phone') {
    onCallElsewhere = phone || 'phone';
    stopAudio();
    cancelEndpoint();
    clearTimeout(followTimer);
    state.convo = false;
    setAwaiting(false);
    recPaused = true;
    stopRec();
    setClapDetector(false);
  } else {
    if (!onCallElsewhere) return;
    onCallElsewhere = null;
    recPaused = false;
    if (micOpen()) startRec();
    setClapDetector(state.clapWake);
    send({ type: 'history' });
    toast('Call ended — back here.');
  }
  refresh();
}

// Phone layout: the panels open as a drawer
$('#menu').onclick = () => body.classList.toggle('drawer');

// Clock & rings

function tickClock() {
  const d = new Date();
  $('#time').textContent = d.toLocaleTimeString('en-GB');
  $('#date').textContent = d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}
setInterval(tickClock, 1000);
tickClock();

(function buildTicks() {
  const g = $('#ticks');
  const ns = 'http://www.w3.org/2000/svg';
  for (let i = 0; i < 120; i++) {
    const a = (i / 120) * Math.PI * 2, major = i % 10 === 0;
    const r1 = major ? 86 : 88, r2 = 91;
    const l = document.createElementNS(ns, 'line');
    l.setAttribute('x1', (Math.cos(a) * r1).toFixed(2));
    l.setAttribute('y1', (Math.sin(a) * r1).toFixed(2));
    l.setAttribute('x2', (Math.cos(a) * r2).toFixed(2));
    l.setAttribute('y2', (Math.sin(a) * r2).toFixed(2));
    if (major) l.setAttribute('class', 'major');
    g.insertBefore(l, g.firstChild);
  }
})();

function placeHud(orb) {
  const { x, y, r } = orb.screen;
  const R = r * 1.6;
  Object.assign($('#rings').style, { left: `${x - R}px`, top: `${y - R}px`, width: `${R * 2}px`, height: `${R * 2}px` });
  Object.assign($('#status').style, { top: `${y + R + 10}px`, left: `${x}px` });
  document.documentElement.style.setProperty('--globe-bottom', `${Math.round(y + R + 44)}px`);   // where the transcript starts
}

// Boot

const orb = new Orb($('#orb'));
placeHud(orb);
window.addEventListener('resize', () => placeHud(orb));
window.ultron = { orb, toast };   // handles for ULTRON's own gui_js scripts
restoreGui();

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  let src = null;
  if (state.speaking) src = inApp ? null : analyser;
  else if ((state.awaiting || (state.talk && followOpen())) && micAnalyser) src = micAnalyser;
  if (src) {
    src.getByteTimeDomainData(timeBuf);
    src.getByteFrequencyData(freqBuf);
  } else if (inApp && state.speaking) {
    // Her voice plays natively in the app: shape a waveform from the level it reports.
    for (let i = 0; i < 512; i++) timeBuf[i] = 128 + Math.round(nativeLevel * 110 * Math.sin(i * 0.11 + now * 0.02) * Math.sin(i * 0.031 + now * 0.007));
    for (let i = 0; i < 256; i++) freqBuf[i] = Math.min(255, nativeLevel * 420 * Math.exp(-i / 40));
  } else {
    timeBuf.fill(128);
    freqBuf.fill(0);
  }
  let sum = 0;
  for (let i = 0; i < 256; i++) {
    const v = timeBuf[i * 2];
    orbWave[i] = v;
    const d = (v - 128) / 128;
    sum += d * d;
  }
  orbFreq.set(freqBuf.subarray(0, 128));
  orb.update(dt, {
    wave: orbWave, freq: orbFreq, level: Math.sqrt(sum / 256),
    speaking: state.speaking, listening: state.awaiting || (state.talk && followOpen()),
    thinking: state.busy && !state.speaking,
  });
  if (orb.moved) placeHud(orb);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

$('#boot-btn').onclick = async () => {
  $('#boot-btn').disabled = true;
  initAudio();
  if (inApp) nativeBridge.postMessage({ cmd: 'volume', value: voice.volume });
  await intro();   // the face, the wink, the line (ultron.js); any key skips it
  $('#boot').classList.add('gone');
  powerOn();
  restoreView();
  connect();
  await initMic();
  restoreListening();
  $('#input').focus();
};

// Bring back saved listening preferences once the mic is live.
function restoreListening() {
  state.clapWake = localGet('fri.clap') === 'true';
  $('#opt-clap').checked = state.clapWake;
  if (state.clapWake) { setClapDetector(true); send({ type: 'keep_awake', on: true }); }

  state.always = localGet('fri.always') === 'true';
  state.wake = !state.always && localGet('fri.wake') === 'true';
  $('#opt-always').checked = state.always;
  $('#opt-wake').checked = state.wake;
  if (wantsContinuous()) startRec();
  refresh();
}
