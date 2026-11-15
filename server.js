// ULTRON server
// Browser UI <-> Ollama, speech, and the agent tools (apps, websites, shell, camera, screen).

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http2 from 'node:http2';
import { pipeline } from 'node:stream/promises';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { GEMINI_MODELS, geminiChat, geminiKey, isGemini } from './gemini.js';
import * as win from './windows.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = win.IS_WIN;
const HOST = IS_WIN ? 'PC' : 'Mac';   // what the machine is called in prompts and messages

const CONFIG = {
  port: Number(process.env.PORT) || 7777,
  ollama: (process.env.ULTRON_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
  // Gemini is the brain when there's a key for it; the local model answers if Gemini can't.
  model: process.env.ULTRON_MODEL || (geminiKey() ? GEMINI_MODELS[0] : 'gemma3:12b'),
  fallbackModel: process.env.ULTRON_FALLBACK_MODEL || 'gemma3:12b',
  visionModel: process.env.ULTRON_VISION_MODEL || 'gemma3:12b',
  coderModel: process.env.ULTRON_CODER_MODEL || '', // empty = use the active chat model
  voice: process.env.ULTRON_VOICE || 'kokoro:af_heart', // kokoro:<voice> or mac:<voice>
  rate: Number(process.env.ULTRON_RATE) || 188, // words/min for the `say` fallback
  speechRate: Number(process.env.ULTRON_SPEECH_RATE) || 0.52, // 0..1 for the Swift engine
  title: process.env.ULTRON_TITLE || 'boss',
  autoApprove: process.env.ULTRON_AUTO_APPROVE !== '0', // run shell commands without asking
};

// One context size for every call, changing num_ctx forces Ollama to reload the model.
const NUM_CTX = Number(process.env.ULTRON_NUM_CTX) || 16384;

const PUBLIC = path.join(ROOT, 'public');
const TTS_DIR = path.join(ROOT, '.tts');
const SITES = path.join(ROOT, 'sites');
const WORKSPACE = path.join(ROOT, 'workspace');
for (const d of [TTS_DIR, SITES, WORKSPACE]) fs.mkdirSync(d, { recursive: true });

// Memory
// Persistent, local. Facts the user tells ULTRON survive restarts and are fed back into context.
const MEM_DIR = path.join(ROOT, 'memory');
const MEM_FILE = path.join(MEM_DIR, 'memory.json');
fs.mkdirSync(MEM_DIR, { recursive: true });

let MEM = { facts: [] };
try { MEM = { facts: [], ...JSON.parse(fs.readFileSync(MEM_FILE, 'utf8')) }; } catch {}

let memSaveTimer = null;
function saveMemory() {
  clearTimeout(memSaveTimer);
  memSaveTimer = setTimeout(() => fsp.writeFile(MEM_FILE, JSON.stringify(MEM, null, 2)).catch(() => {}), 300);
}

let memSeq = MEM.facts.reduce((m, f) => Math.max(m, f.id || 0), 0);
function rememberFact(text) {
  text = String(text || '').trim();
  if (!text) return null;
  // Replace a near-duplicate instead of piling up.
  const norm = t => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const i = MEM.facts.findIndex(f => norm(f.text) === norm(text));
  if (i >= 0) MEM.facts.splice(i, 1);
  const fact = { id: ++memSeq, text, time: Date.now() };
  MEM.facts.push(fact);
  if (MEM.facts.length > 200) MEM.facts = MEM.facts.slice(-200);
  saveMemory();
  broadcastMemory();
  return fact;
}
function forgetFacts(query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return 0;
  const before = MEM.facts.length;
  if (q === 'everything' || q === 'all') MEM.facts = [];
  else MEM.facts = MEM.facts.filter(f => !f.text.toLowerCase().includes(q));
  const n = before - MEM.facts.length;
  if (n) { saveMemory(); broadcastMemory(); }
  return n;
}
function memoryText() {
  if (!MEM.facts.length) return '';
  const lines = MEM.facts.slice(-60).map(f => `- ${f.text}`).join('\n');
  return `\nWhat you remember about the user (use this naturally; don't recite it):\n${lines}\n`;
}
function broadcastMemory() {
  for (const c of clients) c.send({ type: 'memory', facts: MEM.facts.slice(-60) });
}

// Who the user is and how to talk to them. Plain text, re-read every turn so edits apply live.
const PROFILE_FILE = path.join(MEM_DIR, 'profile.md');
function profileText() {
  try { return fs.readFileSync(PROFILE_FILE, 'utf8').trim(); } catch { return ''; }
}

// Own interface
// Changes ULTRON makes to her own GUI (theme, CSS, element edits, scripts). The browser
// fetches this from /api/gui on load and replays it, so her changes to herself stick.
const GUI_FILE = path.join(MEM_DIR, 'gui.json');
const guiEmpty = () => ({ theme: null, css: {}, edits: [], scripts: {} });
let GUI = guiEmpty();
try { GUI = { ...guiEmpty(), ...JSON.parse(fs.readFileSync(GUI_FILE, 'utf8')) }; } catch {}
function saveGui() { fsp.writeFile(GUI_FILE, JSON.stringify(GUI, null, 2)).catch(() => {}); }

function keepEdit(e) {
  // A later text/html/visibility change to the same element replaces the earlier one.
  const slot = x => ['hide', 'show'].includes(x.action) ? `${x.selector}|visibility`
    : ['text', 'html'].includes(x.action) ? `${x.selector}|content`
    : JSON.stringify(x);
  GUI.edits = GUI.edits.filter(x => slot(x) !== slot(e)).concat(e).slice(-200);
  saveGui();
}

// Phone link
// The phone opens this same UI over Tailscale: https://<mac>.<tailnet>.ts.net through
// `tailscale serve`, or http://<tailscale-ip>:PORT. This server can run anything on the Mac,
// so every request that doesn't come from the Mac itself needs a paired device token.
const DEVICES_FILE = path.join(MEM_DIR, 'devices.json');
let DEVICES = [];
try { DEVICES = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8')); } catch {}
const saveDevices = () => fsp.writeFile(DEVICES_FILE, JSON.stringify(DEVICES, null, 2), { mode: 0o600 }).catch(() => {});
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
let pairing = null;   // { code, expires, tries } while a pairing code is showing on the Mac

function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  // `tailscale serve` connects from loopback too, but keeps the ts.net Host and adds forwarding headers.
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(a) && ['localhost', '127.0.0.1'].includes(host)
    && !req.headers['x-forwarded-for'] && !req.headers['tailscale-user-login'];
}
function deviceFor(req) {
  const cookie = String(req.headers.cookie || '').match(/(?:^|;\s*)ultron_device=([^;]+)/);
  const token = req.headers['x-ultron-token'] || (cookie && decodeURIComponent(cookie[1]));
  if (!token) return null;
  const hash = sha(token);
  return DEVICES.find(d => d.hash === hash) || null;
}
function sameOrigin(req) {
  try {
    const o = new URL(req.headers.origin).host;
    return o === req.headers.host || o === req.headers['x-forwarded-host'] || /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) && isLocal(req);
  } catch { return false; }
}

function startPairing() {
  pairing = { code: String(crypto.randomInt(0, 1e6)).padStart(6, '0'), expires: Date.now() + 5 * 60e3, tries: 0 };
  broadcastDevices();
  return pairing;
}
function pairDevice(code, name) {
  if (!pairing || Date.now() > pairing.expires) return { ok: false, error: `No pairing code is active. On the ${HOST}, open Phone link and press Pair a phone.` };
  if (String(code || '').trim() !== pairing.code) {
    if (++pairing.tries >= 5) pairing = null;   // no brute-forcing six digits
    broadcastDevices();
    return { ok: false, error: 'Wrong code' };
  }
  pairing = null;
  const token = crypto.randomBytes(32).toString('base64url');
  const device = { id: crypto.randomBytes(6).toString('hex'), name: String(name || 'Phone').slice(0, 60), hash: sha(token), paired: Date.now(), seen: Date.now() };
  DEVICES.push(device);
  saveDevices();
  broadcastDevices();
  return { ok: true, token, name: device.name };
}
function revokeDevice(id) {
  DEVICES = DEVICES.filter(d => d.id !== id);
  saveDevices();
  for (const c of clients) if (c.device?.id === id) c.ws.close();
  broadcastDevices();
}
function broadcastDevices() {
  const list = DEVICES.map(({ hash, ...d }) => ({ ...d, online: [...clients].some(c => c.device?.id === d.id) }));
  const code = pairing && pairing.expires > Date.now() ? { code: pairing.code, expires: pairing.expires } : null;
  for (const c of clients) if (!c.remote) c.send({ type: 'devices', list, pairing: code, links: PHONE_LINKS });
}
const PHONE_LINKS = [];   // where the phone can reach this Mac, filled in at startup
let MAC_NAME = os.hostname().replace(/\..*$/, '');
const phones = () => [...clients].filter(c => c.remote);

// iOS lets nothing tap or type inside other apps (native apps included; only Siri can), so
// controlling the phone means opening apps and deep links and running the user's Shortcuts.
const PHONE_APPS = {
  spotify: 'spotify:', youtube: 'youtube://', instagram: 'instagram://app', whatsapp: 'whatsapp://', tiktok: 'snssdk1233://',
  snapchat: 'snapchat://', telegram: 'tg://', messenger: 'fb-messenger://', facebook: 'fb://', x: 'twitter://', twitter: 'twitter://',
  discord: 'discord://', netflix: 'nflx://', gmail: 'googlegmail://', chrome: 'googlechrome://', 'google maps': 'comgooglemaps://',
  linkedin: 'linkedin://', slack: 'slack://', zoom: 'zoomus://', uber: 'uber://', shazam: 'shazam://',
  maps: 'maps://', 'apple maps': 'maps://', music: 'music://', 'apple music': 'music://', messages: 'sms:', phone: 'tel:',
  mail: 'message://', calendar: 'calshow://', notes: 'mobilenotes://', facetime: 'facetime://', 'app store': 'itms-apps://',
  shortcuts: 'shortcuts://', photos: 'photos-redirect://', podcasts: 'podcasts://', books: 'ibooks://', wallet: 'shoebox://',
  settings: 'App-prefs:', safari: 'x-web-search://',
};
const iphoneApps = () => [...clients].filter(c => c.native);

// iPhone app sessions report their hardware model; this is how "call my iPhone X" finds the right one.
const IPHONE_MODELS = {
  'iPhone10,3': 'iPhone X', 'iPhone10,6': 'iPhone X', 'iPhone11,2': 'iPhone XS', 'iPhone11,6': 'iPhone XS Max', 'iPhone11,8': 'iPhone XR',
  'iPhone12,1': 'iPhone 11', 'iPhone12,3': 'iPhone 11 Pro', 'iPhone12,5': 'iPhone 11 Pro Max', 'iPhone13,2': 'iPhone 12', 'iPhone13,3': 'iPhone 12 Pro',
  'iPhone13,4': 'iPhone 12 Pro Max', 'iPhone14,5': 'iPhone 13', 'iPhone14,2': 'iPhone 13 Pro', 'iPhone14,3': 'iPhone 13 Pro Max', 'iPhone14,7': 'iPhone 14',
  'iPhone15,2': 'iPhone 14 Pro', 'iPhone15,3': 'iPhone 14 Pro Max', 'iPhone15,4': 'iPhone 15', 'iPhone16,1': 'iPhone 15 Pro', 'iPhone16,2': 'iPhone 15 Pro Max',
  'iPhone17,3': 'iPhone 16', 'iPhone17,1': 'iPhone 16 Pro', 'iPhone17,2': 'iPhone 16 Pro Max',
};
const phoneName = c => c.phoneName || c.device?.name || 'iPhone';
const squash = t => String(t || '').toLowerCase().replace(/^(?:my|the)\s+/, '').replace(/[^a-z0-9]/g, '');

/** The iPhone app session for "iPhone X" / "the 13" / "x"; null if none of the connected ones match. */
function iphoneNamed(name) {
  const q = squash(name).replace(/^iphone/, '');
  if (!q) return null;
  const apps = iphoneApps().map(c => [c, squash(phoneName(c)).replace(/^iphone/, '')]);
  return (apps.find(([, n]) => n === q) || apps.find(([, n]) => n.startsWith(q)) || apps.find(([, n]) => n.includes(q)) || [])[0] || null;
}

/** Which phone an action goes to: the one named, else the phone you're talking from, else the latest. */
function phoneTarget(s, name) {
  if (name) return iphoneNamed(name);
  return s.remote ? s : phones().at(-1) || null;
}
const onlinePhones = () => iphoneApps().map(phoneName).join(', ');

/** A paired iPhone that can be woken by push ("iPhone X", "the 13"...), online or not. */
function deviceNamed(name) {
  const q = squash(name).replace(/^iphone/, '');
  const ds = DEVICES.filter(d => d.voipToken).map(d => [d, squash(d.name).replace(/^iphone/, '')]);
  if (!q) return null;
  return (ds.find(([, n]) => n === q) || ds.find(([, n]) => n.startsWith(q)) || ds.find(([, n]) => n.includes(q)) || [])[0] || null;
}

// VoIP push (APNs): rings a locked iPhone, or one whose app is closed
// memory/apns.json: { "keyId": "...", "teamId": "YOURTEAMID", "keyFile": "apns-key.p8", "bundle": "com.example.ultron", "sandbox": true }
const APNS_FILE = path.join(MEM_DIR, 'apns.json');
let APNS = null;
try {
  APNS = JSON.parse(fs.readFileSync(APNS_FILE, 'utf8'));
  APNS.key = fs.readFileSync(path.resolve(MEM_DIR, APNS.keyFile), 'utf8');
} catch { APNS = null; }

let apnsJwt = null;
function apnsAuth() {
  if (apnsJwt && Date.now() - apnsJwt.t < 40 * 60e3) return apnsJwt.v;   // Apple wants a fresh one at least hourly
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = `${b64({ alg: 'ES256', kid: APNS.keyId })}.${b64({ iss: APNS.teamId, iat: Math.floor(Date.now() / 1000) })}`;
  const sig = crypto.sign('sha256', Buffer.from(head), { key: APNS.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  apnsJwt = { v: `${head}.${sig}`, t: Date.now() };
  return apnsJwt.v;
}

function voipPush(token, payload) {
  return new Promise(resolve => {
    const host = APNS.host || (APNS.sandbox === false ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com');
    const client = http2.connect(host);
    const finish = r => { clearTimeout(timer); client.close(); resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, error: 'Apple push timed out' }), 10000);
    client.on('error', e => finish({ ok: false, error: e.message }));
    const req = client.request({
      ':method': 'POST', ':path': `/3/device/${token}`, authorization: `bearer ${apnsAuth()}`,
      'apns-topic': `${APNS.bundle || 'com.example.ultron'}.voip`, 'apns-push-type': 'voip', 'apns-priority': '10', 'apns-expiration': '0',
    });
    let status = 0, body = '';
    req.on('response', h => { status = h[':status']; });
    req.on('data', d => { body += d; });
    req.on('end', () => finish(status === 200 ? { ok: true } : { ok: false, error: (() => { try { return JSON.parse(body).reason; } catch { return `HTTP ${status}`; } })() }));
    req.on('error', e => finish({ ok: false, error: e.message }));
    req.end(JSON.stringify(payload));
  });
}

// Files between Mac and phone
// Phone -> Mac lands in ~/Downloads/ULTRON. Mac -> phone goes through short-lived download links.
const INBOX = path.join(os.homedir(), 'Downloads', 'ULTRON');
const OUTBOX_DIR = path.join(ROOT, '.outbox');
const OUTBOX = new Map();   // id -> file entry, for /files/<id>
const FILES = [];           // recent transfers in both directions, for the UI
const MAX_UPLOAD = 2 * 1024 ** 3;
const mimeOf = name => MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
const publicFile = ({ file, ...e }) => ({ ...e, url: e.dir === 'to_phone' ? `/files/${e.id}` : null, path: e.dir === 'to_mac' ? file : undefined });

function recordFile(entry) {
  FILES.unshift(entry);
  FILES.length = Math.min(FILES.length, 40);
  for (const c of clients) c.send({ type: 'files', list: FILES.map(publicFile) });
}

function uniquePath(dir, name) {
  const ext = path.extname(name), stem = path.basename(name, ext);
  for (let i = 1, p = path.join(dir, name); ; p = path.join(dir, `${stem} ${++i}${ext}`)) if (!fs.existsSync(p)) return p;
}

async function sendToPhone(p, note = '') {
  const full = expandPath(String(p || ''), os.homedir());
  if (!p || !fs.existsSync(full)) return { ok: false, error: `Not found: ${full}` };
  let file = full, name = path.basename(full);
  if ((await fsp.stat(full)).isDirectory()) {
    fs.mkdirSync(OUTBOX_DIR, { recursive: true });
    file = path.join(OUTBOX_DIR, `${crypto.randomBytes(4).toString('hex')}-${name}.zip`);
    const r = IS_WIN ? await win.zip(full, file)
      : await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', full, file], { timeout: 300000 });
    if (r.code !== 0) return { ok: false, error: `Couldn't zip the folder: ${r.stderr.trim()}` };
    name += '.zip';
  }
  const entry = { id: crypto.randomBytes(12).toString('base64url'), dir: 'to_phone', file, name, size: (await fsp.stat(file)).size, mime: mimeOf(name), time: Date.now(), note: String(note || '') };
  OUTBOX.set(entry.id, entry);
  recordFile(entry);
  const n = phones().length;
  for (const c of phones()) c.send({ type: 'file', file: publicFile(entry) });
  return { ok: true, message: n ? `Sent ${name} to the phone` : `${name} is ready and shows up on the phone when it connects` };
}

// Outbox links last a day; zips made for folders are deleted with them.
setInterval(() => {
  for (const [id, e] of OUTBOX) if (Date.now() - e.time > 24 * 3600e3) {
    OUTBOX.delete(id);
    if (e.file.startsWith(OUTBOX_DIR + path.sep)) fsp.rm(e.file, { force: true });
  }
}, 3600e3).unref();

async function receiveUpload(req, res, url) {
  const raw = path.basename(String(url.searchParams.get('name') || '')).replace(/[\0:]/g, '_').trim();
  fs.mkdirSync(INBOX, { recursive: true });
  const dest = uniquePath(INBOX, raw && raw !== '.' && raw !== '..' ? raw : `Phone ${new Date().toLocaleString('sv-SE').replace(/:/g, '.')}`);
  let size = 0;
  try {
    await pipeline(req, async function* (src) {
      for await (const chunk of src) {
        if ((size += chunk.length) > MAX_UPLOAD) throw new Error('File too large (2 GB max)');
        yield chunk;
      }
    }, fs.createWriteStream(dest));
  } catch (e) {
    fsp.rm(dest, { force: true });
    return json(res, 400, { ok: false, error: e.message });
  }
  const name = path.basename(dest);
  recordFile({ id: crypto.randomBytes(6).toString('hex'), dir: 'to_mac', file: dest, name, size, mime: mimeOf(name), time: Date.now() });
  json(res, 200, { ok: true, path: dest, name, size });
  // Uploads from an iOS Shortcut can carry a question ("what's on my screen?"): answer it on the phone.
  const ask = String(url.searchParams.get('ask') || '').trim();
  const target = phones().at(-1) || lastSession;
  if (ask && target?.ws.readyState === 1) runTurn(target, `${ask}\n[Files I just sent you, now saved on the Mac: ${dest}]`);
}

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
async function readJson(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 1e5) break; }
  try { return JSON.parse(body); } catch { return {}; }
}

// Scheduler (proactivity)
// Reminders, recurring tasks and URL watchers that survive restarts. A reminder speaks a line;
// a task runs a prompt through ULTRON; a watcher polls a page and speaks when it changes.
const SCHED_FILE = path.join(MEM_DIR, 'schedule.json');
let JOBS = [];
try { JOBS = JSON.parse(fs.readFileSync(SCHED_FILE, 'utf8')); } catch {}
let jobSeq = JOBS.reduce((m, j) => Math.max(m, j.id || 0), 0);
let lastSession = null;   // most recently active UI, used to speak/act when a job fires

function saveJobs() { fsp.writeFile(SCHED_FILE, JSON.stringify(JOBS, null, 2)).catch(() => {}); broadcastJobs(); }
function broadcastJobs() {
  const list = JOBS.map(({ handle, lastValue, ...j }) => j);
  for (const c of clients) c.send({ type: 'jobs', list });
}

// Parse a time into the next matching timestamp. Accepts {in_minutes}, {at:"HH:MM"} (+daily), {iso}.
function nextFire({ in_minutes, at, iso, daily }) {
  if (iso) { const t = Date.parse(iso); return isNaN(t) ? null : t; }
  if (in_minutes != null) return Date.now() + Number(in_minutes) * 60000;
  if (at) {
    const m = String(at).match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (!m) return null;
    let h = Number(m[1]); const min = Number(m[2]);
    if (m[3]) { const pm = /pm/i.test(m[3]); if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
    const d = new Date(); d.setHours(h, min, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); // next occurrence
    return d.getTime();
  }
  return null;
}

function addJob(job) {
  job.id = ++jobSeq;
  JOBS.push(job);
  saveJobs();
  return job;
}
function cancelJobs(match) {
  const before = JOBS.length;
  JOBS = JOBS.filter(j => !match(j));
  const n = before - JOBS.length;
  if (n) saveJobs();
  return n;
}

async function fireJob(job) {
  const say = async text => {
    if (IS_WIN) win.notify('ULTRON', text);
    else run('osascript', ['-e', `display notification ${JSON.stringify(text)} with title "ULTRON"`]);
    if (lastSession && lastSession.ws.readyState === 1) notice(lastSession, text, 'reminder');
  };
  try {
    if (job.type === 'reminder') {
      await say(`Reminder: ${job.text}`);
    } else if (job.type === 'task') {
      if (lastSession && lastSession.ws.readyState === 1) runTurn(lastSession, job.prompt);
      else await say(`I had a task scheduled (${job.prompt}) but no window was open.`);
    } else if (job.type === 'watch') {
      const changed = await checkWatcher(job);
      if (changed) await say(`Heads up: ${job.label || job.url} ${changed}`);
      return; // watchers reschedule themselves below
    }
  } catch {}
}

async function checkWatcher(job) {
  try {
    const html = await (await fetch(job.url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) })).text();
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    if (job.keyword) {
      const present = text.toLowerCase().includes(job.keyword.toLowerCase());
      if (present && !job.lastValue) { job.lastValue = 'seen'; saveJobs(); return `"${job.keyword}" appeared.`; }
      if (!present) job.lastValue = '';
      return null;
    }
    // No keyword: notify on any substantial change.
    const sig = String(text.length);
    if (job.lastValue && job.lastValue !== sig) { job.lastValue = sig; saveJobs(); return 'the page changed.'; }
    job.lastValue = sig; saveJobs();
    return null;
  } catch { return null; }
}

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const job of JOBS) {
    if (job.type === 'watch') {
      if (now >= (job.next || 0)) { job.next = now + (job.every_minutes || 5) * 60000; changed = true; fireJob(job); }
      continue;
    }
    if (now >= job.fire) {
      fireJob(job);
      if (job.daily) { job.fire += 86400000; changed = true; }
      else { JOBS = JOBS.filter(j => j !== job); changed = true; }
    }
  }
  if (changed) saveJobs();
}, 15000);
for (const f of fs.readdirSync(TTS_DIR)) fs.rmSync(path.join(TTS_DIR, f), { force: true });

// Static files

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

const MOUNTS = [
  ['/vendor/three/', path.join(ROOT, 'node_modules/three/build')],
  ['/vendor/three-addons/', path.join(ROOT, 'node_modules/three/examples/jsm')],
  ['/vendor/xterm/', path.join(ROOT, 'node_modules/@xterm')],
  ['/tts/', TTS_DIR],
  ['/sites/', SITES],
  ['/', PUBLIC],
];

// The UI shell is public (no secrets in it); everything else needs this Mac or a paired phone.
const OPEN_PATHS = /^\/(?:index\.html|app\.js|orb\.js|ultron\.js|deck\.js|sfx\.js|earth-data\.js|face\.js|face-mesh\.js|style\.css|manifest\.webmanifest|icon\.svg|icon-180\.png|vendor\/.*|api\/whoami|api\/pair)$/;

async function handleHttp(req, res) {
  let p, url;
  try { url = new URL(req.url, 'http://x'); p = decodeURIComponent(url.pathname); } catch { p = '/'; url = new URL('http://x/'); }
  if (p.endsWith('/')) p += 'index.html';
  const local = isLocal(req);
  const device = local ? null : deviceFor(req);
  if (!local && !device && !OPEN_PATHS.test(p)) return json(res, 401, { ok: false, error: 'Pair this device first' });
  // Pages in a browser can't make this server act cross-site.
  if (req.method === 'POST' && req.headers.origin && !sameOrigin(req)) return json(res, 403, { ok: false, error: 'Cross-origin request refused' });

  if (p === '/api/gui') return json(res, 200, GUI);
  // What the start-up log and the network panel show about this machine.
  if (p === '/api/sysinfo') {
    const nets = Object.entries(os.networkInterfaces()).flatMap(([name, list]) =>
      (list || []).filter(a => a.family === 'IPv4' && !a.internal).map(a => ({ name, address: a.address })));
    return json(res, 200, {
      host: os.hostname(), user: os.userInfo().username, os: `${os.type()} ${os.release()}`, arch: os.arch(),
      cpu: os.cpus()[0]?.model || 'cpu', cores: os.cpus().length, memGB: os.totalmem() / 2 ** 30, freeGB: os.freemem() / 2 ** 30,
      node: process.version, nets, port: CONFIG.port, model: PREFS.model || CONFIG.model, ollama: CONFIG.ollama,
      shell: IS_WIN ? 'powershell' : process.env.SHELL || '/bin/zsh', root: ROOT.replace(os.homedir(), '~'),
    });
  }
  // The file browser beside the terminal. This Mac only.
  if (p === '/api/fs') {
    if (!local) return json(res, 403, { ok: false, error: `Only on the ${HOST} itself` });
    const dir = path.resolve(url.searchParams.get('path') || os.homedir());
    try {
      const entries = (await fsp.readdir(dir, { withFileTypes: true })).filter(e => !e.name.startsWith('.')).map(e => {
        let isDir = e.isDirectory();
        if (e.isSymbolicLink()) try { isDir = fs.statSync(path.join(dir, e.name)).isDirectory(); } catch {}
        return { name: e.name, dir: isDir };
      }).sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name, undefined, { numeric: true })).slice(0, 600);
      return json(res, 200, { ok: true, path: dir, parent: path.dirname(dir), home: os.homedir(), entries });
    } catch (e) {
      return json(res, 200, { ok: false, path: dir, parent: path.dirname(dir), home: os.homedir(), error: ['EACCES', 'EPERM'].includes(e.code) ? `${IS_WIN ? 'Windows' : 'macOS'} has not given ULTRON access to this folder` : 'That folder cannot be opened' });
    }
  }
  if (p === '/api/whoami') return json(res, 200, { local, paired: local || !!device, device: device?.name || null, mac: MAC_NAME });
  if (p === '/api/pair' && req.method === 'POST') {
    const b = await readJson(req);
    return json(res, 200, pairDevice(b.code, b.name));
  }
  if (p === '/api/upload' && req.method === 'POST') return receiveUpload(req, res, url);
  if (p.startsWith('/files/')) {
    const e = OUTBOX.get(p.slice(7));
    if (!e || !fs.existsSync(e.file)) return json(res, 404, { ok: false, error: 'That file link expired' });
    res.writeHead(200, {
      'content-type': e.mime, 'content-length': e.size, 'cache-control': 'private, max-age=86400',
      'content-disposition': `${url.searchParams.has('inline') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(e.name)}`,
    });
    return fs.createReadStream(e.file).pipe(res);
  }

  for (const [prefix, dir] of MOUNTS) {
    if (!p.startsWith(prefix)) continue;
    const file = path.join(dir, p.slice(prefix.length));
    if (!file.startsWith(dir + path.sep)) break;
    try {
      const data = await fsp.readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      return res.end(data);
    } catch { break; }
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
}
const server = http.createServer(handleHttp);

// Ollama

async function* ollamaChat(model, messages, { signal, options = {}, stats } = {}) {
  const t0 = Date.now();
  const res = await fetch(`${CONFIG.ollama}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, keep_alive: '30m', options: { temperature: 0.6, num_ctx: NUM_CTX, ...options } }),
    signal,
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const decoder = new TextDecoder();
  let buf = '';
  let first = true;
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const j = JSON.parse(line);
      if (j.error) throw new Error(j.error);
      if (j.message?.content) {
        if (first && stats) { stats.firstTokenMs = Date.now() - t0; first = false; }
        yield j.message.content;
      }
      if (j.done && stats && j.eval_duration) stats.tokensPerSec = j.eval_count / (j.eval_duration / 1e9);
    }
  }
}

// Every model call goes through here: gemini-* models to Google, the rest to Ollama. If Gemini
// fails before saying anything (offline, quota used up, bad key) the fallback model answers.
async function* chat(model, messages, opts = {}) {
  if (!isGemini(model)) return yield* ollamaChat(model, messages, opts);
  let said = false;
  try {
    for await (const text of geminiChat(model, messages, opts)) { said = true; yield text; }
  } catch (e) {
    if (said || opts.signal?.aborted) throw e;
    console.log(`  ⚠ ${model}: ${e.message} — answering with ${CONFIG.fallbackModel}`);
    if (opts.stats) opts.stats.fallback = CONFIG.fallbackModel;
    yield* ollamaChat(CONFIG.fallbackModel, messages, opts);
  }
}

// One whole reply, not streamed. Model errors come back as { ok: false }; a cancel still throws.
async function chatOnce(model, messages, opts = {}) {
  try {
    let text = '';
    for await (const t of chat(model, messages, opts)) text += t;
    return { ok: true, text: text.trim() };
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    return { ok: false, error: e.message };
  }
}

async function listModels() {
  const gemini = geminiKey() ? GEMINI_MODELS : [];
  try {
    const r = await fetch(`${CONFIG.ollama}/api/tags`);
    const j = await r.json();
    return [...gemini, ...(j.models || []).map(m => m.name)];
  } catch { return gemini; }
}

const capsCache = new Map();
async function hasVision(model) {
  if (isGemini(model)) return true;
  if (capsCache.has(model)) return capsCache.get(model);
  let v = false;
  try {
    const r = await fetch(`${CONFIG.ollama}/api/show`, { method: 'POST', body: JSON.stringify({ model }) });
    const j = await r.json();
    v = (j.capabilities || []).includes('vision');
  } catch {}
  capsCache.set(model, v);
  return v;
}

function warmUp(model) {
  if (isGemini(model)) return;
  fetch(`${CONFIG.ollama}/api/generate`, {
    method: 'POST',
    body: JSON.stringify({ model, prompt: '', keep_alive: '30m', options: { num_ctx: NUM_CTX } }),
  }).catch(() => {});
}

// Speech
// Two persistent engines, both speaking the same line protocol ("<id>\t<voice>\t<out.wav>\t<text>"):
//   kokoro, Kokoro-82M neural TTS (tts/kokoro_server.py): smooth, natural voices.
//   mac   , AVSpeechSynthesizer helper (tts/speak.swift): instant, but robotic.
// If an engine is missing or still loading, speech falls back to the next one, then to `say`.

const KOKORO_PY = IS_WIN ? path.join(ROOT, 'tts', 'venv', 'Scripts', 'python.exe') : path.join(ROOT, 'tts', 'venv', 'bin', 'python');
// The built-in voice when Kokoro isn't installed: AVSpeechSynthesizer on the Mac, System.Speech on Windows.
const SYS_VOICE = IS_WIN ? 'win:default' : 'mac:Daniel';

const VOICES = [
  { id: 'kokoro:bm_george', label: 'George · British male' },
  { id: 'kokoro:bm_fable', label: 'Fable · British male' },
  { id: 'kokoro:bm_lewis', label: 'Lewis · British male' },
  { id: 'kokoro:bm_daniel', label: 'Daniel · British male' },
  { id: 'kokoro:am_michael', label: 'Michael · American male' },
  { id: 'kokoro:am_fenrir', label: 'Fenrir · American male' },
  { id: 'kokoro:am_puck', label: 'Puck · American male' },
  { id: 'kokoro:bf_emma', label: 'Emma · British female' },
  { id: 'kokoro:bf_isabella', label: 'Isabella · British female' },
  { id: 'kokoro:af_heart', label: 'Heart · American female' },
  { id: 'kokoro:af_bella', label: 'Bella · American female' },
  IS_WIN ? { id: 'win:default', label: 'Windows voice (classic)' } : { id: 'mac:Daniel', label: 'Daniel · macOS (classic)' },
];

class Engine {
  constructor(name, cmd, args) {
    this.name = name;
    this.ready = false;
    this.waiters = new Map();
    this.seq = 0;
    this.whenReady = new Promise(r => { this.markReady = r; });
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = p;
    let buf = '';
    p.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line === 'ready') { this.ready = true; this.markReady(); console.log(`  ${name} voice engine ready`); continue; }
        const [id, status] = line.split(' ');
        this.waiters.get(id)?.(status === 'ok');
        this.waiters.delete(id);
      }
    });
    // Always drain stderr, or a chatty engine blocks once the pipe buffer fills.
    p.stderr.on('data', d => { if (process.env.ULTRON_DEBUG) process.stderr.write(d); });
    const fail = () => {
      if (this.proc !== p) return;
      this.proc = null;
      this.ready = false;
      for (const f of this.waiters.values()) f(false);
      this.waiters.clear();
    };
    p.on('exit', code => { if (this.proc === p) console.log(`  ${name} voice engine exited (${code})`); fail(); });
    p.on('error', fail);
  }
  // fields: leading tab-separated columns (voice, and engine-specific speed/pitch) before out+text.
  synth(fields, out, text) {
    if (!this.proc || !this.ready) return Promise.resolve(false);
    const id = String(++this.seq);
    return new Promise(resolve => {
      const t = setTimeout(() => { this.waiters.delete(id); resolve(false); }, 20000);
      this.waiters.set(id, v => { clearTimeout(t); resolve(v); });
      this.proc.stdin.write(`${id}\t${fields.join('\t')}\t${out}\t${text.replace(/[\t\n\r]+/g, ' ')}\n`);
    });
  }
}

const engines = {};

// Compiles a native helper if it's missing or older than its source: Swift on the Mac, C# on
// Windows (with the .NET Framework compiler that ships with every Windows 10/11 install).
function ensureHelper(src, bin, what) {
  if (fs.existsSync(bin) && fs.statSync(bin).mtimeMs >= fs.statSync(src).mtimeMs) return;
  console.log(`  compiling ${what}…`);
  if (!IS_WIN) return execFileSync('swiftc', ['-O', src, '-o', bin], { stdio: 'ignore' });
  const fw = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', fs.existsSync(path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64')) ? 'Framework64' : 'Framework', 'v4.0.30319');
  const wpf = path.join(fw, 'WPF');
  execFileSync(path.join(fw, 'csc.exe'), [
    '/nologo', '/optimize+', '/codepage:65001', '/target:exe', `/out:${bin}`,
    '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', '/r:System.Management.dll',
    `/r:${path.join(wpf, 'UIAutomationClient.dll')}`, `/r:${path.join(wpf, 'UIAutomationTypes.dll')}`, `/r:${path.join(wpf, 'WindowsBase.dll')}`,
    src,
  ], { stdio: 'ignore', windowsHide: true });
}

// Keeps the computer from fully sleeping so the microphone stays alive for clap-to-wake.
// The display can still turn off; only deep system sleep (which halts everything) is prevented.
let caffeine = null;
function setKeepAwake(on) {
  if (on && !caffeine) {
    caffeine = IS_WIN ? spawn(CONTROL, ['awake'], { windowsHide: true }) : spawn('caffeinate', ['-s']); // prevent system sleep while on AC power
    caffeine.on('error', () => { caffeine = null; });
    caffeine.on('exit', () => { caffeine = null; });
    console.log(`  keep-awake on (the ${HOST} will not deep-sleep)`);
  } else if (!on && caffeine) {
    caffeine.kill();
    caffeine = null;
    console.log('  keep-awake off');
  }
}

function startEngines() {
  if (IS_WIN) {
    engines.sys = new Engine('Windows', 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tts', 'speak.ps1')]);
  } else try {
    ensureHelper(path.join(ROOT, 'tts', 'speak.swift'), path.join(ROOT, 'tts', 'speak'), 'macOS speech engine');
    const bin = path.join(ROOT, 'tts', 'speak');
    engines.sys = new Engine('macOS', bin, ['Daniel', String(CONFIG.speechRate)]);
  } catch {
    console.log('  (swiftc unavailable — macOS voice will use `say`)');
  }
  if (fs.existsSync(KOKORO_PY)) {
    console.log('  loading Kokoro neural voice…');
    engines.kokoro = new Engine('Kokoro', KOKORO_PY, [path.join(ROOT, 'tts', 'kokoro_server.py')]);
  } else {
    console.log(`  (Kokoro not installed — run ${IS_WIN ? 'setup-voice.bat' : './setup-voice.sh'} for the smooth neural voice)`);
  }
}

function defaultVoice() {
  const sys = SYS_VOICE.split(':')[0];
  const v = CONFIG.voice.includes(':') ? CONFIG.voice
    : /^[a-z][fm]_/.test(CONFIG.voice) ? `kokoro:${CONFIG.voice}` : `${sys}:${CONFIG.voice}`;
  if (v.startsWith('kokoro:') && !fs.existsSync(KOKORO_PY)) return SYS_VOICE;
  return VOICES.some(x => x.id === v) || v.startsWith(`${sys}:`) ? v : SYS_VOICE;
}

function sayFallback(text, out, voice, rate, pitch) {
  return new Promise(resolve => {
    const wpm = Math.round(CONFIG.rate * rate);
    const p = spawn('say', ['-v', voice, '-r', String(wpm), '-o', out, '--data-format=LEI16@22050', '-f', '-']);
    p.on('error', () => resolve(false));
    p.on('close', code => resolve(code === 0));
    p.stdin.end(`[[pbas ${Math.round(50 * pitch)}]] ${text}`); // pbas = baseline pitch
  });
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

let ttsSeq = 0;
// pitch/speed are independent: Kokoro's `speed` sets tempo (pitch-preserving); the residual
// pitch shift is applied in the browser via playbackRate, and the Kokoro speed is pre-divided
// by pitch so the net tempo stays exactly `speed`. The macOS voice shifts pitch natively.
async function synth(text, voiceId, { pitch = 1, speed = 1 } = {}) {
  const name = `${Date.now()}-${ttsSeq++}.wav`;
  const out = path.join(TTS_DIR, name);
  const [engine, voice] = voiceId.split(':');
  const macVoice = engine === 'mac' || engine === 'win' ? voice : SYS_VOICE.split(':')[1];
  let ok = false, rate = 1;
  if (engine === 'kokoro' && engines.kokoro?.proc) {
    if (!engines.kokoro.ready && !engines.kokoro.gaveUp) {
      await Promise.race([engines.kokoro.whenReady, new Promise(r => setTimeout(r, 12000))]);
      if (!engines.kokoro.ready) engines.kokoro.gaveUp = true;
    }
    const kSpeed = clamp(speed / pitch, 0.5, 2).toFixed(3);
    ok = await engines.kokoro.synth([voice, kSpeed], out, text);
    if (ok) rate = pitch; // browser lifts/drops pitch; tempo already compensated
  }
  if (!ok && engines.sys) ok = await engines.sys.synth([macVoice, (CONFIG.speechRate * speed).toFixed(3), pitch.toFixed(3)], out, text);
  if (!ok && !IS_WIN) ok = await sayFallback(text, out, macVoice, speed, pitch);
  return ok ? { url: `/tts/${name}`, rate } : null;
}

// Clean up old audio files.
setInterval(async () => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const f of await fsp.readdir(TTS_DIR)) {
    const fp = path.join(TTS_DIR, f);
    const st = await fsp.stat(fp).catch(() => null);
    if (st && st.mtimeMs < cutoff) fsp.rm(fp, { force: true });
  }
}, 60 * 1000);

function cleanForSpeech(t) {
  return t
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/[*_#>`~|\[\]{}]/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function speak(s, turn, text) {
  const clean = cleanForSpeech(text);
  if (!clean || !/[\p{L}\p{N}]/u.test(clean) || !s.tts) return;
  const job = synth(clean, s.voice, { pitch: s.pitch, speed: s.speed }); // parallel; delivered in order
  s.ttsChain = s.ttsChain.then(async () => {
    const r = await job;
    if (r && turn === s.turn) s.send({ type: 'audio', url: r.url, rate: r.rate, turn });
    if (s.native && turn === s.turn) phoneLog(s, `Mac: sent voice clip "${text.slice(0, 40)}"${r ? '' : ' (speech FAILED)'}`);
  });
}

// Splits streamed text into sentences so speech starts before the reply finishes.
class Speech {
  // hold: keep it quiet until the step ends, then release() it or drop it.
  constructor(s, turn, hold = false) { this.s = s; this.turn = turn; this.buf = ''; this.hold = hold; }
  add(t) {
    this.buf += t;
    if (this.hold) return;
    for (;;) {
      const re = /[.!?]+(?=\s)|\n/g;
      let m, cut = -1;
      while ((m = re.exec(this.buf))) {
        const end = m.index + m[0].length;
        if (end >= 14 || m[0] === '\n') { cut = end; break; }
      }
      if (cut < 0) break;
      speak(this.s, this.turn, this.buf.slice(0, cut));
      this.buf = this.buf.slice(cut);
    }
  }
  flush() { if (!this.hold) speak(this.s, this.turn, this.buf); this.buf = ''; }
  release() { const t = this.buf; this.buf = ''; this.hold = false; this.add(t); this.flush(); }
}

// Stream parser
// Separates spoken text from <action>{json}</action>, <think>...</think> and ``` code fences.

const BLOCKS = [
  { open: '<action>', close: '</action>', kind: 'action' },
  { open: '<think>', close: '</think>', kind: 'think' },
  { open: '```', close: '```', kind: 'code' },
];

class StreamParser {
  constructor(onText, onBlock) { this.onText = onText; this.onBlock = onBlock; this.buf = ''; this.block = null; }
  push(chunk) { this.buf += chunk; this.process(false); }
  end() { this.process(true); }
  process(final) {
    while (this.buf) {
      if (this.block) {
        const i = this.buf.indexOf(this.block.close);
        if (i < 0) {
          if (final) { this.onBlock(this.block.kind, this.buf); this.buf = ''; }
          return;
        }
        this.onBlock(this.block.kind, this.buf.slice(0, i));
        this.buf = this.buf.slice(i + this.block.close.length);
        this.block = null;
        continue;
      }
      let best = null, at = Infinity;
      for (const b of BLOCKS) {
        const i = this.buf.indexOf(b.open);
        if (i >= 0 && i < at) { at = i; best = b; }
      }
      if (best) {
        if (at > 0) this.onText(this.buf.slice(0, at));
        this.buf = this.buf.slice(at + best.open.length);
        this.block = best;
        continue;
      }
      if (!final) {
        // hold back a possible partial opener at the end of the buffer
        for (let k = Math.min(8, this.buf.length); k > 0; k--) {
          const tail = this.buf.slice(-k);
          if (BLOCKS.some(b => b.open.startsWith(tail))) {
            if (this.buf.length > k) this.onText(this.buf.slice(0, -k));
            this.buf = tail;
            return;
          }
        }
      }
      this.onText(this.buf);
      this.buf = '';
    }
  }
}

// LLMs sometimes put raw newlines inside JSON strings; escape them.
function escapeControlInStrings(s) {
  let out = '', inStr = false, esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) { esc = false; out += ch; continue; }
      if (ch === '\\') { esc = true; out += ch; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') continue;
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

function parseAction(body) {
  const t = body.trim().replace(/^json\s*/i, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try {
    const j = JSON.parse(escapeControlInStrings(t.slice(a, b + 1)));
    const key = ['tool', 'action', 'function', 'name'].find(k => typeof j[k] === 'string' && TOOLS[j[k]]);
    if (!key) return null;
    let args = j.args ?? j.arguments ?? j.parameters ?? j.input;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    if (!args || typeof args !== 'object') { args = { ...j }; delete args[key]; }
    return { tool: j[key], args };
  } catch { return null; }
}

// Tools

const run = (cmd, args, opts = {}) => new Promise(resolve => {
  execFile(cmd, args, { timeout: 30000, maxBuffer: 8e6, windowsHide: true, ...opts }, (err, stdout, stderr) => {
    resolve({
      code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
      stdout: String(stdout || ''),
      stderr: String(stderr || (err && err.message) || ''),
    });
  });
});

const APP_ALIASES = {
  'vscode': 'Visual Studio Code', 'vs code': 'Visual Studio Code', 'code': 'Visual Studio Code',
  'visual studio': 'Visual Studio Code', 'chrome': 'Google Chrome', 'google': 'Google Chrome',
  'settings': 'System Settings', 'system preferences': 'System Settings', 'mail': 'Mail',
  'messages': 'Messages', 'music': 'Music', 'terminal': 'Terminal', 'finder': 'Finder',
};
const appName = n => APP_ALIASES[String(n || '').trim().toLowerCase()] || String(n || '').trim();

const expandPath = (p, base = WORKSPACE) => {
  p = String(p || '').trim();
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(base, p);
};

const slugify = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function normalizeUrl(u) {
  u = String(u || '').trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
  return u;
}

// Opens a URL without ever navigating away from the ULTRON tab: in Chrome it uses (or creates)
// a regular window that isn't showing ULTRON.
async function openInBrowser(url, browser) {
  if (IS_WIN) {
    // Opens in a normal browser window; the ULTRON app window never takes regular tabs.
    const r = await win.openUrl(url, browser);
    if (!r.ok) return r;
    await sleep(1200);
    return { ok: true, message: `Opened ${url}${browser ? ' in ' + browser : ''}` };
  }
  const b = browser ? appName(browser) : '';
  const chromeRunning = (await run('pgrep', ['-x', 'Google Chrome'])).code === 0;
  if (/chrome/i.test(b) || (!b && chromeRunning)) {
    const u = url.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const r = await run('osascript', ['-e', `tell application "Google Chrome"
  set target to missing value
  repeat with w in windows
    set t to title of active tab of w
    if mode of w is "normal" and t does not contain "ULTRON" then
      set target to w
      exit repeat
    end if
  end repeat
  if target is missing value then
    set target to make new window
    set URL of active tab of target to "${u}"
  else
    tell target to make new tab with properties {URL:"${u}"}
  end if
  set index of target to 1
  activate
end tell`]);
    if (r.code === 0) { await sleep(1200); return { ok: true, message: `Opened ${url} in Google Chrome` }; }
  }
  const r = await run('open', b ? ['-a', b, url] : [url]);
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() };
  await sleep(1200);
  return { ok: true, message: `Opened ${url}${b ? ' in ' + b : ''}` };
}

const WEB_PROMPT = `You are an elite front-end engineer and award-winning web designer.
Output ONLY one complete, self-contained HTML document — inline <style> and <script>, starting with <!DOCTYPE html> and ending with </html>. No explanations, no markdown.
Requirements: modern, polished, responsive layout; strong typography (Google Fonts allowed); tasteful animations and hover states; real, specific content (never lorem ipsum); semantic HTML; images from https://picsum.photos/seed/<word>/<w>/<h> when needed; working navigation and interactive JS where it makes sense.`;

function extractHtml(raw) {
  const start = raw.search(/<!doctype html|<html/i);
  if (start < 0) return null;
  const t = raw.slice(start);
  const end = t.toLowerCase().lastIndexOf('</html>');
  return end >= 0 ? t.slice(0, end + 7) : t.replace(/```[\s\S]*$/, '') + '\n</html>';
}

const DANGEROUS = new RegExp([
  String.raw`\brm\s+(-\w+\s+)*(\/|~|\$HOME)(\/?\*?)?(\s|$)`, // rm -rf / or ~ or $HOME
  String.raw`\b(sudo|mkfs|shutdown|reboot|halt)\b`,
  String.raw`\bdiskutil\s+(erase|zero|partition|reformat)`,
  String.raw`\bdd\b.*\bof=\/dev\/`,
  String.raw`:\(\)\s*\{`, // fork bomb
  String.raw`>\s*\/dev\/disk`,
  String.raw`\bcsrutil\b`,
  // Windows
  String.raw`(^|[;&|]\s*)(format\s+[a-z]:|diskpart|bcdedit)`,
  String.raw`\bcipher\s+\/w|\bvssadmin\s+delete`,
  String.raw`\b(Stop-Computer|Restart-Computer|Clear-Disk|Format-Volume|Remove-Partition|Initialize-Disk)\b`,
  // deleting a drive root, the home folder or Windows itself
  String.raw`\b(Remove-Item|rm|del|rd|rmdir|erase|ri)\b[^;|&]*\s['"]?([a-z]:\\?|\$env:(USERPROFILE|SystemRoot|windir|HOMEDRIVE)\\?|~\\?)['"]?(\s|$)`,
  String.raw`\breg(\.exe)?\s+delete\s+HKLM`,
  String.raw`\b(Start-Process\b.*-Verb\s+RunAs|runas)\b`,
].join('|'), 'i');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function screenLocked() {
  if (IS_WIN) return win.screenLocked();
  const r = await run('ioreg', ['-n', 'Root', '-d1']);
  return /CGSSessionScreenIsLocked"\s*=\s*Yes/.test(r.stdout);
}

// Types into the focused field (the lock screen password box). The script goes in through
// stdin so the password never appears in the process list.
function typeSecret(secret) {
  const esc = secret.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return new Promise(resolve => {
    const p = spawn('osascript', ['-']);
    p.on('error', () => resolve(false));
    p.on('close', code => resolve(code === 0));
    p.stdin.end(`tell application "System Events"
  keystroke "${esc}"
  delay 0.2
  key code 36
end tell`);
  });
}

// Computer control (control/control.swift on the Mac, control/control.cs on Windows)

const CONTROL = path.join(ROOT, 'control', IS_WIN ? 'control.exe' : 'control');

function startControl() {
  try {
    ensureHelper(path.join(ROOT, 'control', IS_WIN ? 'control.cs' : 'control.swift'), CONTROL, 'computer control');
  } catch {
    console.log(`  (${IS_WIN ? 'the C# compiler (csc.exe) is' : 'swiftc is'} unavailable — mouse/keyboard control disabled)`);
    return;
  }
  if (IS_WIN) return;
  // Asks macOS for Accessibility + Screen Recording the first time (shows the system dialogs).
  run(CONTROL, ['perm', '--prompt']).then(r => {
    try {
      const p = JSON.parse(r.stdout);
      if (!p.accessibility) console.log('  ⚠ Accessibility permission needed for mouse/keyboard control');
      if (!p.screen) console.log('  ⚠ Screen Recording permission needed for screenshots');
    } catch {}
  });
}

async function control(...args) {
  if (!fs.existsSync(CONTROL)) return { ok: false, error: `Computer control is not available (needs ${IS_WIN ? 'the .NET Framework C# compiler' : 'swiftc'})` };
  // Shortcuts are written Mac-style everywhere (cmd+t); Windows gets its own (ctrl+t, f11, alt+left…).
  if (IS_WIN && args[0] === 'key') args = ['key', win.winCombo(args[1]), ...args.slice(2)];
  const r = await run(CONTROL, args.map(a => String(a ?? '')), { timeout: 45000 });
  const out = r.stdout.trim();
  if (r.code !== 0 || out.startsWith('ERROR:')) return { ok: false, error: out.replace(/^ERROR:\s*/, '') || r.stderr.trim() };
  return { ok: true, message: out };
}

const coord = v => Math.round(Number(v));

async function wifiDevice() {
  const r = await run('networksetup', ['-listallhardwareports']);
  const m = r.stdout.match(/Wi-Fi\n\s*Device:\s*(\w+)/);
  return m ? m[1] : 'en0';
}
async function wifi(on) {
  if (IS_WIN) return win.radio('WiFi', on);
  const dev = await wifiDevice();
  const r = await run('networksetup', ['-setairportpower', dev, on ? 'on' : 'off']);
  return r.code === 0 ? { ok: true, message: `Wi-Fi ${on ? 'on' : 'off'}` } : { ok: false, error: r.stderr.trim() || 'Failed' };
}
async function bt(on) {
  if (IS_WIN) return win.radio('Bluetooth', on);
  if ((await run('which', ['blueutil'])).code === 0) {
    const r = await run('blueutil', ['--power', on ? '1' : '0']);
    return r.code === 0 ? { ok: true, message: `Bluetooth ${on ? 'on' : 'off'}` } : { ok: false, error: r.stderr.trim() };
  }
  return { ok: false, error: 'Bluetooth toggle needs blueutil (brew install blueutil)' };
}
const hasXY = (x, y) => Number.isFinite(Number(x)) && Number.isFinite(Number(y)) && x !== '' && y !== '';

// Screenshot the screen (or a window) and ask the vision model about it. Shared by see_screen/verify.
async function lookAtScreen(s, ctx, prompt, app) {
  const perm = await control('perm');
  if (perm.ok && perm.message.includes('"screen":false')) {
    return { ok: false, error: 'Screen Recording permission is off. Enable it for the app running ULTRON in System Settings → Privacy & Security → Screen Recording, then restart ULTRON.' };
  }
  const shot = await captureScreen(app);
  if (!shot) return { ok: false, error: 'Screenshot failed' };
  return askVision(s, ctx?.signal, `This is a screenshot of the user's ${HOST}${shot.windowShot ? ` showing the ${shot.app} window` : ' screen'}. ${prompt}`, shot.image);
}

// JPEG (base64) of the app's window, or the whole screen when there's no window to target.
async function captureScreen(app, forceWindow = false) {
  if (IS_WIN) {
    const jpg = path.join(TTS_DIR, `screen-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`);
    const r = await control('shot', jpg, app || '', forceWindow ? 'window' : 'auto');
    if (!r.ok || !fs.existsSync(jpg)) return null;
    let info = {};
    try { info = JSON.parse(r.message); } catch {}
    const image = (await fsp.readFile(jpg)).toString('base64');
    fsp.rm(jpg, { force: true });
    return { image, windowShot: !!info.window, app: info.app };
  }
  let target = {};
  try { target = JSON.parse((await control('target', app || '')).message); } catch {}
  const png = path.join(TTS_DIR, `screen-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`);
  const jpg = png.replace(/\.png$/, '.jpg');
  const windowShot = (app || target.frontIsUltron || forceWindow) && target.windowId;
  await run('screencapture', windowShot ? ['-x', '-o', '-l', String(target.windowId), png] : ['-x', '-m', png]);
  if (!fs.existsSync(png)) return null;
  await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '-Z', '1600', png, '--out', jpg]);
  const image = (await fsp.readFile(fs.existsSync(jpg) ? jpg : png)).toString('base64');
  fsp.rm(png, { force: true }); fsp.rm(jpg, { force: true });
  return { image, windowShot: !!windowShot, app: target.app };
}

// One image + prompt to the vision model (the chat model if it can see, else CONFIG.visionModel).
async function askVision(s, signal, prompt, image) {
  const model = (await hasVision(s.model)) ? s.model : CONFIG.visionModel;
  return chatOnce(model, [{ role: 'user', content: prompt, images: [image] }], { signal });
}

const TOOLS = {
  async open_app(s, { name }) {
    const app = appName(name);
    if (!app) return { ok: false, error: 'No application name given' };
    if (IS_WIN) {
      const r = await win.openApp(app);
      if (r.ok) await sleep(1500);
      return r;
    }
    const r = await run('open', ['-a', app]);
    if (r.code !== 0) return { ok: false, error: `Could not open "${app}": ${r.stderr.trim()}` };
    await sleep(1200); // let the window appear
    return { ok: true, message: `Opened ${app}` };
  },

  async close_app(s, { name }) {
    const app = appName(name).replace(/"/g, '');
    if (IS_WIN) return win.closeApp(app);
    const r = await run('osascript', ['-e', `quit app "${app}"`]);
    return r.code === 0 ? { ok: true, message: `Closed ${app}` } : { ok: false, error: r.stderr.trim() };
  },

  async find_files(s, { query, kind }) {
    if (!query) return { ok: false, error: 'No search query given' };
    if (IS_WIN) {
      const hits = await win.findFiles(String(query), kind);
      return hits.length ? { ok: true, count: hits.length, files: hits.slice(0, 15) } : { ok: false, error: `Nothing named "${query}" found` };
    }
    const q = kind === 'folder' ? `kMDItemFSName == "*${query}*"c && kMDItemContentType == public.folder`
      : `kMDItemFSName == "*${query}*"c`;
    const r = await run('mdfind', ['-onlyin', os.homedir(), q], { timeout: 15000 });
    const hits = r.stdout.split('\n').filter(l => l && !/\/(Library|node_modules|\.)/.test(l.replace(os.homedir(), '')));
    if (!hits.length) return { ok: false, error: `Nothing named "${query}" found` };
    return { ok: true, count: hits.length, files: hits.slice(0, 15) };
  },

  async open_file(s, { path: p, app }) {
    if (!p) return { ok: false, error: 'No path given' };
    const full = expandPath(p, os.homedir());
    if (!fs.existsSync(full)) return { ok: false, error: `Not found: ${full}` };
    if (IS_WIN) { const r = await win.openPath(full, app ? appName(app) : ''); return r.ok ? { ok: true, message: `Opened ${full}` } : r; }
    const r = await run('open', app ? ['-a', appName(app), full] : [full]);
    return r.code === 0 ? { ok: true, message: `Opened ${full}` } : { ok: false, error: r.stderr.trim() };
  },

  async open_url(s, { url, browser }) {
    return openInBrowser(normalizeUrl(url), browser);
  },

  async search_web(s, { query }) {
    const r = await openInBrowser(`https://www.google.com/search?q=${encodeURIComponent(query || '')}`);
    return r.ok ? { ok: true, message: `Searched the web for "${query}"` } : r;
  },

  async play_youtube(s, { query }) {
    let url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query || '')}`;
    try {
      const html = await (await fetch(url, { headers: { 'accept-language': 'en-US' }, signal: AbortSignal.timeout(6000) })).text();
      const m = html.match(/"videoId":"([\w-]{11})"/);
      if (m) url = `https://www.youtube.com/watch?v=${m[1]}`;
    } catch {}
    await openInBrowser(url);
    return { ok: true, message: url.includes('watch') ? `Playing "${query}" on YouTube` : `Opened YouTube results for "${query}"` };
  },

  async open_vscode(s, { path: p }) {
    const args = ['-a', 'Visual Studio Code'];
    if (p) {
      const full = expandPath(p);
      if (!fs.existsSync(full)) return { ok: false, error: `Path not found: ${full}` };
      args.push(full);
    }
    if (IS_WIN) {
      const r = await win.openVSCode(p ? expandPath(p) : '');
      return r.ok ? { ok: true, message: `Opened VS Code${p ? ' at ' + expandPath(p) : ''}` } : r;
    }
    const r = await run('open', args);
    return r.code === 0 ? { ok: true, message: `Opened VS Code${p ? ' at ' + expandPath(p) : ''}` } : { ok: false, error: r.stderr.trim() };
  },

  async build_website(s, { name, description }, ctx) {
    const slug = slugify(name || description) || `site-${Date.now()}`;
    const dir = path.join(SITES, slug);
    const model = s.coderModel || s.model;
    let raw = '', last = 0;
    s.send({ type: 'code_start', id: ctx.id, file: `sites/${slug}/index.html`, model });
    for await (const chunk of chat(model, [
      { role: 'system', content: WEB_PROMPT },
      { role: 'user', content: `Website name: ${name || 'untitled'}\nBrief: ${description || name}\nUse exactly this name for the brand.` },
    ], { signal: ctx.signal, options: { num_predict: 12000, temperature: 0.7 } })) {
      raw += chunk;
      s.send({ type: 'code', id: ctx.id, text: chunk }); // live on the HUD
      if (raw.length - last > 300) {
        last = raw.length;
        s.send({ type: 'action', id: ctx.id, tool: 'build_website', status: 'running', detail: `writing code · ${(raw.length / 1024).toFixed(1)} KB` });
      }
    }
    const html = extractHtml(raw);
    s.send({ type: 'code_end', id: ctx.id, ok: !!html, file: html ? path.join(dir, 'index.html') : '' });
    if (!html) return { ok: false, error: 'The model did not produce valid HTML' };
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'index.html');
    await fsp.writeFile(file, html);
    if (IS_WIN) await win.openPath(file); else await run('open', [file]);
    return { ok: true, message: `Website built and opened in the browser`, folder: dir, file };
  },

  async write_file(s, { path: p, content }, ctx) {
    if (!p) return { ok: false, error: 'No path given' };
    const full = expandPath(p);
    if (!full.startsWith(WORKSPACE + path.sep)) return { ok: false, error: 'Files can only be written inside the workspace folder' };
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, String(content ?? ''));
    s.send({ type: 'code_start', id: ctx.id, file: path.relative(ROOT, full) });
    s.send({ type: 'code', id: ctx.id, text: String(content ?? '') });
    s.send({ type: 'code_end', id: ctx.id, ok: true, file: full });
    return { ok: true, message: `Wrote ${full}`, file: full };
  },

  async run_command(s, { command }) {
    if (!command) return { ok: false, error: 'No command given' };
    // With auto-authorize on, commands run immediately, except ones that could wreck the
    // machine or need admin rights, which always ask first.
    if (!s.autoApprove || DANGEROUS.test(command)) {
      const approved = await s.request({ type: 'confirm_request', command }, 120000);
      if (!approved) return { ok: false, error: 'The user did not authorize this command' };
    }
    const r = IS_WIN ? await win.shell(command, { cwd: WORKSPACE, timeout: 120000 })
      : await run('/bin/zsh', ['-c', command], { cwd: WORKSPACE, timeout: 120000 });
    const output = (r.stdout + (r.stderr ? '\n' + r.stderr : '')).trim();
    return { ok: r.code === 0, exit_code: r.code, output: output.length > 2000 ? '…' + output.slice(-2000) : output };
  },

  async look(s, { question }, ctx) {
    const frame = await s.request({ type: 'request_frame' }, 10000);
    if (!frame) return { ok: false, error: 'Camera is unavailable' };
    const model = (await hasVision(s.model)) ? s.model : CONFIG.visionModel;
    const r = await chatOnce(model, [{
      role: 'user',
      content: `You are the optical sensor of ULTRON, viewing the user's webcam. ${question || 'Describe what you see.'} Answer factually in at most 3 sentences.`,
      images: [frame],
    }], { signal: ctx.signal });
    return r.ok ? { ok: true, observation: r.text } : r;
  },

  async read_screen(s, { app }) {
    const look = await lookMarked(app || '');
    if (!look) return control('ui', app || '');
    return { ok: true, elements: [...look.ui.head, ...look.ui.items.slice(0, 160)].join('\n'), ...(look.image && { screenshot: look.image }) };
  },

  async see_screen(s, { question, app }, ctx) {
    const r = await lookAtScreen(s, ctx, question || 'Describe what is on screen. Read important text exactly. Answer in at most 4 sentences.', app);
    return r.ok ? { ok: true, observation: r.text } : r;
  },

  // Vision verification: did an action achieve its goal? Returns yes/no + reason.
  async verify(s, { goal, app }, ctx) {
    if (!goal) return { ok: false, error: 'No goal to verify' };
    const r = await lookAtScreen(s, ctx,
      `Looking at this screen, is the following true: "${goal}"? Start your answer with YES or NO, then one short reason.`, app);
    if (!r.ok) return r;
    const verified = /^\s*(yes|true|correct|done)\b/i.test(r.text);
    return { ok: true, verified, observation: r.text };
  },

  async click_element(s, { name, app, mark }) {
    if (mark != null && mark !== '') return TOOLS.click(s, { mark });
    if (!name) return { ok: false, error: 'No element name given' };
    return control('press', name, app || '');
  },

  async click(s, { x, y, button, mark }) {
    if (mark != null && mark !== '') {
      const m = MARKS.get(Number(String(mark).replace(/\D/g, '')));
      if (!m) return { ok: false, error: `There's no mark ${mark} on the latest screenshot. Use a number from the newest one (they change every time).` };
      const r = await control('click', m.x, m.y, button || 'left');
      return r.ok ? { ok: true, message: `Clicked [${mark}] ${m.what}` } : r;
    }
    if (!hasXY(x, y)) return { ok: false, error: 'click needs a mark number, or numeric x and y' };
    return control('click', coord(x), coord(y), button || 'left');
  },

  async move_mouse(s, { x, y }) {
    if (!hasXY(x, y)) return { ok: false, error: 'move_mouse needs numeric x and y' };
    return control('move', coord(x), coord(y));
  },

  async drag(s, { from_x, from_y, to_x, to_y }) {
    if (!hasXY(from_x, from_y) || !hasXY(to_x, to_y)) return { ok: false, error: 'drag needs from_x, from_y, to_x, to_y' };
    return control('drag', coord(from_x), coord(from_y), coord(to_x), coord(to_y));
  },

  async type_text(s, { text, app }) {
    if (typeof text !== 'string' || !text) return { ok: false, error: 'No text given' };
    return control('type', text, app || '');
  },

  async press_keys(s, { keys, app, times }) {
    if (!keys) return { ok: false, error: 'No keys given' };
    // Accept sequences: "down down down", "tab, tab", "down x10" or times: 10.
    let seq = String(keys).split(/[\s,]+/).filter(Boolean);
    const rep = String(keys).match(/^(\S+)\s*[x×*]\s*(\d+)$/i);
    if (rep) seq = Array(Number(rep[2])).fill(rep[1]);
    if (times > 1 && seq.length === 1) seq = Array(Number(times)).fill(seq[0]);
    seq = seq.slice(0, 40);
    let last;
    for (const k of seq) {
      last = await control('key', k, app || '');
      if (!last.ok) return last;
    }
    return seq.length > 1 ? { ok: true, message: `Pressed ${seq.length} keys (${keys})` } : last;
  },

  async scroll(s, { direction, amount, app }) {
    return control('scroll', direction || 'down', amount || 5, app || '');
  },

  async run_applescript(s, { script }) {
    if (!script) return { ok: false, error: 'No script given' };
    if (IS_WIN) return { ok: false, error: 'AppleScript only exists on macOS. On this PC use run_command, which runs PowerShell.' };
    if (!s.autoApprove || DANGEROUS.test(script)) {
      const approved = await s.request({ type: 'confirm_request', command: script }, 120000);
      if (!approved) return { ok: false, error: 'The user did not authorize this script' };
    }
    const r = await new Promise(resolve => {
      const p = spawn('osascript', ['-']);
      let out = '', err = '';
      const t = setTimeout(() => p.kill(), 60000);
      p.stdout.on('data', d => { out += d; });
      p.stderr.on('data', d => { err += d; });
      p.on('error', e => resolve({ code: 1, out, err: e.message }));
      p.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
      p.stdin.end(script);
    });
    return r.code === 0 ? { ok: true, output: r.out.trim().slice(0, 2000) || 'done' } : { ok: false, error: r.err.trim().slice(0, 600) };
  },

  async wake_screen() {
    if (IS_WIN) {
      // Windows doesn't let any app type on the lock screen (it's a separate, secure desktop),
      // so this wakes the display and leaves signing in to Windows Hello or the user.
      await control('wake');
      await sleep(900);
      return (await screenLocked())
        ? { ok: true, message: "The display is awake. It's locked, and Windows only lets you sign in yourself (or with Windows Hello)." }
        : { ok: true, message: 'The display is awake and unlocked' };
    }
    spawn('caffeinate', ['-u', '-t', '3']).on('error', () => {}); // wake the display
    await sleep(900);
    if (!(await screenLocked())) return { ok: true, message: 'The display is awake and unlocked' };
    const pw = await run('security', ['find-generic-password', '-s', 'ultron-unlock', '-w']);
    if (pw.code !== 0) return { ok: false, error: 'No unlock password saved. Run ./set-unlock-password.sh' };
    await sleep(400);
    await typeSecret(pw.stdout.replace(/\n$/, ''));
    for (let i = 0; i < 8; i++) {
      await sleep(500);
      if (!(await screenLocked())) return { ok: true, message: 'Screen woken and unlocked' };
    }
    return { ok: false, error: 'Still locked. macOS may be blocking keystrokes: give Terminal Accessibility permission in System Settings → Privacy & Security.' };
  },

  async remember(s, { text }) {
    const f = rememberFact(text);
    return f ? { ok: true, message: `Noted: ${f.text}` } : { ok: false, error: 'Nothing to remember' };
  },

  async forget(s, { query }) {
    const n = forgetFacts(query);
    return n ? { ok: true, message: `Forgotten (${n})` } : { ok: false, error: 'Nothing matched' };
  },

  async set_volume(s, { level }) {
    const v = Math.max(0, Math.min(100, Math.round(Number(level) || 0)));
    if (IS_WIN) { const r = await control('volume', v); return r.ok ? { ok: true, message: `Volume set to ${v}%` } : r; }
    await run('osascript', ['-e', `set volume output volume ${v}`]);
    return { ok: true, message: `Volume set to ${v}%` };
  },

  async media(s, { action, times }) {
    const keys = {
      play: 'play', pause: 'play', playpause: 'play', resume: 'play', next: 'next', skip: 'next',
      previous: 'previous', prev: 'previous', back: 'previous', mute: 'mute', unmute: 'mute',
      volumeup: 'volup', louder: 'volup', volumedown: 'voldown', quieter: 'voldown',
    };
    const key = keys[String(action || 'playpause').toLowerCase().replace(/[^a-z]/g, '')];
    if (!key) return { ok: false, error: `Unknown media action "${action}"` };
    return control('media', key, times || 1);
  },

  async brightness(s, { direction, steps }) {
    const down = /down|dim|lower|decrease|less/i.test(direction || '');
    return control('media', down ? 'brightdown' : 'brightup', steps || 2);
  },

  async window(s, { action, app, x, y, width, height }) {
    const op = String(action || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (op === 'move') return control('window', 'move', coord(x), coord(y), app || '');
    if (op === 'size' || op === 'resize') return control('window', 'size', coord(width), coord(height), app || '');
    const ok = ['minimize', 'unminimize', 'restore', 'fullscreen', 'maximize', 'zoom', 'center', 'left', 'right', 'top', 'bottom', 'left half', 'right half', 'top half', 'bottom half'];
    if (!ok.includes(op)) return { ok: false, error: `Unknown window action "${action}"` };
    return control('window', op, app || '');
  },

  async force_quit(s, { name }) {
    const app = appName(name);
    if (!app) return { ok: false, error: 'No app named' };
    if (IS_WIN) return win.forceQuit(app);
    const r = await run('killall', [app]);
    return r.code === 0 ? { ok: true, message: `Force quit ${app}` }
      : (await run('pkill', ['-f', app])).code === 0 ? { ok: true, message: `Force quit ${app}` }
      : { ok: false, error: `Couldn't force quit ${app}` };
  },

  async system_control(s, { action }) {
    const a = String(action || '').toLowerCase();
    if (/wi-?fi.*off|off.*wi-?fi|disable wi/.test(a)) return wifi(false);
    if (/wi-?fi.*on|on.*wi-?fi|enable wi/.test(a)) return wifi(true);
    if (/bluetooth.*off|off.*bluetooth/.test(a)) return bt(false);
    if (/bluetooth.*on|on.*bluetooth/.test(a)) return bt(true);
    if (/sleep.*(display|screen)|(display|screen).*sleep|turn off.*(display|screen)/.test(a)) {
      if (IS_WIN) return control('display', 'off');
      await run('pmset', ['displaysleepnow']); return { ok: true, message: 'Display asleep' };
    }
    if (/sleep( the mac| the pc| the computer)?$/.test(a) || /go to sleep/.test(a)) {
      if (IS_WIN) return win.sleepSystem();
      await run('pmset', ['sleepnow']); return { ok: true, message: 'Sleeping' };
    }
    if (IS_WIN && /empty.*(trash|recycle)/.test(a)) return win.emptyTrash();
    if (IS_WIN && /do not disturb|focus|dnd/.test(a)) {
      return { ok: false, error: 'Windows has no switch for Focus / Do Not Disturb that apps can flip. Open it with open_url "ms-settings:quiethours".' };
    }
    if (IS_WIN) return { ok: false, error: `I can toggle Wi-Fi, Bluetooth, display/system sleep and empty the Recycle Bin. For "${action}" use run_command (PowerShell).` };
    if (/empty.*trash/.test(a)) {
      const r = await run('osascript', ['-e', 'tell application "Finder" to empty trash']);
      return r.code === 0 ? { ok: true, message: 'Trash emptied' } : { ok: false, error: r.stderr.trim() };
    }
    if (/do not disturb|focus|dnd/.test(a)) {
      const on = !/off|disable|stop/.test(a);
      const r = await run('shortcuts', ['run', on ? 'Turn On Do Not Disturb' : 'Turn Off Do Not Disturb']);
      return r.code === 0 ? { ok: true, message: `Do Not Disturb ${on ? 'on' : 'off'}` }
        : { ok: false, error: 'Needs a Shortcut named "Turn On/Off Do Not Disturb" (macOS blocks direct Focus control)' };
    }
    return { ok: false, error: `I can toggle Wi-Fi, Bluetooth, display/system sleep, empty trash. For "${action}" use run_command or run_applescript.` };
  },

  async dark_mode(s, { mode }) {
    if (IS_WIN) return win.darkMode(mode);
    const m = String(mode || 'toggle').toLowerCase();
    const value = /^(on|dark|true)$/.test(m) ? 'true' : /^(off|light|false)$/.test(m) ? 'false' : 'not dark mode';
    const prefs = 'tell application "System Events" to tell appearance preferences to';
    const r = await run('osascript', ['-e', `${prefs} set dark mode to ${value}`]);
    if (r.code !== 0) return { ok: false, error: r.stderr.trim() };
    const now = (await run('osascript', ['-e', `${prefs} get dark mode`])).stdout.trim() === 'true';
    return { ok: true, message: `Dark mode is ${now ? 'on' : 'off'}` };
  },

  async screenshot(s) {
    const stamp = new Date().toLocaleString('sv-SE').replace(' ', ' at ').replace(/:/g, '.');
    const file = path.join(os.homedir(), 'Desktop', `ULTRON Screenshot ${stamp}.${IS_WIN ? 'jpg' : 'png'}`);
    if (IS_WIN) await control('shot', file, '', 'screen');
    else await run('screencapture', ['-x', file]);
    if (!fs.existsSync(file)) return { ok: false, error: IS_WIN ? 'Screenshot failed' : 'Screenshot failed — check Screen Recording permission' };
    // Away from the Mac, a screenshot is only useful on the phone.
    if (s?.remote) { await sendToPhone(file); return { ok: true, message: 'Screenshot taken and sent to your phone', file }; }
    return { ok: true, message: 'Screenshot saved to your Desktop', file };
  },

  async lock_screen() {
    if (IS_WIN) return win.lockScreen();
    const r = await control('key', 'ctrl+cmd+q');
    return r.ok ? { ok: true, message: 'Screen locked' } : r;
  },

  async battery() {
    if (IS_WIN) {
      const b = await win.battery();
      if (!b) return { ok: false, error: 'No battery information available (this PC runs on mains power)' };
      const left = b.minutesLeft ? `, ${Math.floor(b.minutesLeft / 60)}:${String(b.minutesLeft % 60).padStart(2, '0')} remaining` : '';
      return { ok: true, message: `Battery at ${b.percent} percent, ${b.plugged ? (b.charging ? 'charging' : 'charged') : 'discharging'}, ${b.plugged ? 'on the charger' : 'on battery'}${left}` };
    }
    const r = await run('pmset', ['-g', 'batt']);
    const m = r.stdout.match(/(\d+)%;\s*([^;]+);\s*([^\n]*)/);
    if (!m) return { ok: false, error: 'No battery information available' };
    const power = /AC Power/.test(r.stdout) ? 'on the charger' : 'on battery';
    const left = (m[3].match(/(\d+:\d+) remaining/) || [])[1];
    return { ok: true, message: `Battery at ${m[1]} percent, ${m[2].trim()}, ${power}${left && left !== '0:00' ? `, ${left} remaining` : ''}` };
  },

  async system_status() {
    const batt = await TOOLS.battery();
    let freeGB = '?';
    try { const st = await fsp.statfs(os.homedir()); freeGB = Math.round((st.bavail * st.bsize) / 2 ** 30); } catch {}
    const up = os.uptime();
    return {
      ok: true,
      message: `${batt.ok ? batt.message + '. ' : ''}${freeGB} GB of disk free, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM, up for ${Math.floor(up / 86400)} days ${Math.floor((up % 86400) / 3600)} hours`,
    };
  },

  async weather(s, { city }) {
    const r = await fetch(`https://wttr.in/${encodeURIComponent(city || '')}?format=j1`, {
      headers: { 'user-agent': 'curl/8' }, signal: AbortSignal.timeout(10000),
    });
    const j = await r.json();
    const c = j.current_condition?.[0], today = j.weather?.[0];
    if (!c) return { ok: false, error: 'Weather service unavailable' };
    const place = city || j.nearest_area?.[0]?.areaName?.[0]?.value || 'your area';
    return { ok: true, message: `${place}: ${c.weatherDesc?.[0]?.value}, ${c.temp_C}°C, feels like ${c.FeelsLikeC}°C. Today ${today?.mintempC} to ${today?.maxtempC}°C` };
  },

  async clipboard(s, { text }) {
    if (typeof text === 'string' && text) {
      if (IS_WIN) await win.setClipboard(text);
      else await new Promise(res => { const p = spawn('pbcopy'); p.on('close', res); p.on('error', res); p.stdin.end(text); });
      return { ok: true, message: 'Copied to the clipboard' };
    }
    const v = IS_WIN ? await win.getClipboard() : (await run('pbpaste', [])).stdout.trim();
    return { ok: true, message: v ? `Clipboard says: ${v.slice(0, 300)}` : 'The clipboard is empty', clipboard: v.slice(0, 2000) };
  },

  async set_timer(s, { minutes, seconds, label }) {
    const ms = ((Number(minutes) || 0) * 60 + (Number(seconds) || 0)) * 1000;
    if (ms <= 0) return { ok: false, error: 'Give the timer a duration' };
    addTimer(ms, String(label || ''));
    return { ok: true, message: `Timer set for ${formatDuration(ms)}${label ? ` — ${label}` : ''}` };
  },

  async cancel_timer(s, { label }) {
    const n = cancelTimers(t => !label || t.label.toLowerCase().includes(String(label).toLowerCase()));
    return n ? { ok: true, message: `Cancelled ${n} timer${n > 1 ? 's' : ''}` } : { ok: false, error: 'No matching timer' };
  },

  async set_reminder(s, { text, at, in_minutes, iso, daily }) {
    const fire = nextFire({ at, in_minutes, iso, daily });
    if (!fire) return { ok: false, error: 'When should I remind you? Give a time like "18:30" or minutes from now.' };
    if (!text) return { ok: false, error: 'What should I remind you about?' };
    addJob({ type: 'reminder', text, fire, daily: !!daily });
    return { ok: true, message: `Reminder set for ${new Date(fire).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}${daily ? ' daily' : ''}` };
  },

  async schedule_task(s, { prompt, at, in_minutes, iso, daily }) {
    const fire = nextFire({ at, in_minutes, iso, daily });
    if (!fire) return { ok: false, error: 'When should I run it? Give a time or minutes from now.' };
    if (!prompt) return { ok: false, error: 'What task should I run?' };
    addJob({ type: 'task', prompt, fire, daily: !!daily });
    return { ok: true, message: `Task scheduled for ${new Date(fire).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}${daily ? ' daily' : ''}` };
  },

  async add_watcher(s, { url, keyword, label, every_minutes }) {
    if (!url) return { ok: false, error: 'Which page should I watch?' };
    const u = normalizeUrl(url);
    addJob({ type: 'watch', url: u, keyword: keyword || '', label: label || u, every_minutes: Math.max(2, Number(every_minutes) || 10), next: 0 });
    return { ok: true, message: `Watching ${label || u}${keyword ? ` for "${keyword}"` : ' for changes'}` };
  },

  async cancel_reminder(s, { label }) {
    const q = String(label || '').toLowerCase();
    const n = cancelJobs(j => !q || q === 'all' || q === 'everything' ||
      (j.text || j.prompt || j.label || '').toLowerCase().includes(q));
    return n ? { ok: true, message: `Cancelled ${n}` } : { ok: false, error: 'No matching reminder, task or watcher' };
  },

  async morning_briefing(s, _args, ctx) {
    const now = new Date();
    const w = await TOOLS.weather(s, {});
    const b = await TOOLS.battery();
    const parts = [
      `Good ${now.getHours() < 12 ? 'morning' : now.getHours() < 18 ? 'afternoon' : 'evening'}, ${s.title}.`,
      now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) + '.',
      w.ok ? w.message + '.' : '',
      b.ok ? b.message + '.' : '',
      MEM.facts.length ? `You've got ${MEM.facts.length} things I'm keeping in mind.` : '',
    ].filter(Boolean);
    return { ok: true, message: parts.join(' ') };
  },

  // Phone link
  async send_to_phone(s, { path: p, message }) {
    return sendToPhone(p, message);
  },

  async view_image(s, { path: p, question }, ctx) {
    const full = expandPath(String(p || ''), os.homedir());
    if (!p || !fs.existsSync(full)) return { ok: false, error: `Not found: ${full}` };
    // sips also turns iPhone HEIC photos into something the vision model can read.
    const jpg = path.join(TTS_DIR, `view-${Date.now()}.jpg`);
    if (IS_WIN) await control('image', full, jpg);
    else await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '-Z', '1600', full, '--out', jpg]);
    if (!fs.existsSync(jpg)) return { ok: false, error: `Couldn't read ${path.basename(full)} as an image` };
    const image = (await fsp.readFile(jpg)).toString('base64');
    fsp.rm(jpg, { force: true });
    const r = await askVision(s, ctx.signal, `This is an image file (${path.basename(full)}). ${question || 'Describe it. Read important text exactly.'} Answer in at most 4 sentences.`, image);
    return r.ok ? { ok: true, observation: r.text } : r;
  },

  async phone_open(s, { app, url, phone: which }) {
    const phone = phoneTarget(s, which);
    if (!phone) return { ok: false, error: which ? `${which} isn't connected. Online: ${onlinePhones() || 'none'}` : "The phone isn't connected" };
    const target = url ? String(url).trim() : PHONE_APPS[String(app || '').toLowerCase().trim()];
    if (!target) return { ok: false, error: `No link for "${app}". Known apps: ${Object.keys(PHONE_APPS).join(', ')}. Pass a url (deep link), or run a Shortcut that opens it.` };
    if (/^(javascript|data|file|blob):/i.test(target)) return { ok: false, error: "That's not a link I'll open" };
    phone.send({ type: 'phone_open', url: target, label: app ? `Open ${app}` : 'Open' });
    return { ok: true, message: `Opening ${app || target} on the phone` };
  },

  async phone_shortcut(s, { name, input, phone: which }) {
    const phone = phoneTarget(s, which);
    if (!phone) return { ok: false, error: which ? `${which} isn't connected. Online: ${onlinePhones() || 'none'}` : "The phone isn't connected" };
    if (!name) return { ok: false, error: 'Which Shortcut?' };
    const url = `shortcuts://run-shortcut?name=${encodeURIComponent(name)}${input ? `&input=text&text=${encodeURIComponent(input)}` : ''}`;
    phone.send({ type: 'phone_open', url, label: `Run ${name}`, shortcut: true });
    return { ok: true, message: `Running the ${name} Shortcut on the phone` };
  },

  // Rings the iPhone app with the real call screen (CallKit), over Tailscale: no phone network, no cost.
  // An awake app rings straight over the link; a locked or closed one is woken by Apple (VoIP push).
  async call_me(s, { reason, phone }) {
    reason = String(reason || '');
    const app = phone ? iphoneNamed(phone) : (s.native ? s : null) || iphoneApps().at(-1);
    const device = app?.device?.voipToken ? app.device
      : phone ? deviceNamed(phone) : DEVICES.filter(d => d.voipToken).sort((a, b) => b.seen - a.seen)[0];
    const name = app ? phoneName(app) : device?.name || phone || 'iPhone';
    if (app) {
      app.callReason = reason;
      // The app answers once iOS shows the call screen, or says why iOS refused.
      const r = await app.request({ type: 'call', reason }, 5000);
      console.log(`  ☎ call ${name} → ${r ? (r.ok ? 'ringing' : r.error) : 'no reply (asleep)'}`);
      if (r) return r.ok ? { ok: true, message: `Ringing your ${name} now.` } : { ok: false, error: `Couldn't ring your ${name}: ${r.error}.` };
    }
    if (APNS && device?.voipToken) {
      device.pendingCall = { reason, t: Date.now() };
      const p = await voipPush(device.voipToken, { reason });
      console.log(`  ☎ push ${device.name} → ${p.ok ? 'sent' : p.error}`);
      return p.ok ? { ok: true, message: `Ringing your ${device.name} now.` } : { ok: false, error: `Apple couldn't deliver the call to your ${device.name} (${p.error}).` };
    }
    if (phone && !app && !device) {
      const known = DEVICES.find(d => squash(d.name).replace(/^iphone/, '') === squash(phone).replace(/^iphone/, ''));
      return { ok: false, error: known
        ? `Your ${known.name} is asleep and hasn't registered for calls yet: open the ULTRON app on it once, then I can ring it even when it's locked.`
        : `I don't know a phone called ${phone}. Paired: ${DEVICES.map(d => d.name).join(', ')}.` };
    }
    return { ok: false, error: `Your ${name} is asleep (locked, or the app is closed)${APNS ? ' and hasn\'t registered for push calls yet: open ULTRON on it once' : ` and push calls aren't set up on the ${HOST} yet`}.` };
  },

  async list_shortcuts() {
    // The Mac sees the iPhone's Shortcuts through iCloud.
    if (IS_WIN) return { ok: false, error: "Only a Mac can read the iPhone's Shortcuts list. Ask the user for the exact name." };
    const r = await run('shortcuts', ['list'], { timeout: 15000 });
    if (r.code !== 0) return { ok: false, error: r.stderr.trim() || "Couldn't read Shortcuts" };
    const names = r.stdout.split('\n').map(x => x.trim()).filter(Boolean);
    return { ok: true, count: names.length, shortcuts: names.slice(0, 200) };
  },

  async recall(s, { query, date }) {
    const range = date ? dayRange(date) : null;
    if (date && !range) return { ok: false, error: 'Give the date as today, yesterday, "3 days ago" or YYYY-MM-DD' };
    const pool = range ? LOG.filter(e => e.t >= range[0] && e.t < range[1]) : LOG;
    const hits = query ? search(query, pool, 10).map(([, e]) => e).sort((a, b) => a.t - b.t) : pool.slice(-30);
    const journal = range ? JOURNAL.filter(j => j.to >= range[0] && j.from < range[1]).map(j => j.summary) : [];
    if (!hits.length && !journal.length) return { ok: true, message: `Nothing found${query ? ` about "${query}"` : ''}${date ? ` on ${date}` : ''}.` };
    return { ok: true, ...(journal.length ? { journal } : {}), messages: hits.map(logLine) };
  },

  async pair_phone() {
    const { code } = startPairing();
    return { ok: true, message: `Pairing code ${code.split('').join(' ')}, valid for five minutes. It's also on the ${HOST} screen under Phone link.` };
  },

  // Her own interface
  async gui_state(s) {
    const r = await guiCall(s, 'state');
    if (r.ok) r.saved = { theme: GUI.theme?.name || null, css: Object.keys(GUI.css), edits: GUI.edits.length, scripts: Object.keys(GUI.scripts) };
    return r;
  },

  async gui_set(s, { setting, value }) {
    if (!setting) return { ok: false, error: 'Which setting?' };
    const key = String(setting).toLowerCase().trim().replace(/[\s-]+/g, '_');
    let confirmed = false;
    // The model may switch auto-authorize off freely, but only the user can switch it back on.
    if (/^auto_(approve|authorize)$/.test(key) && /^(on|true|yes|1|enabled?)$/i.test(String(value).trim()) && !s.autoApprove) {
      confirmed = !!(await s.request({ type: 'confirm_request', command: 'Turn on Auto-authorize: shell commands, AppleScript and interface scripts will run without asking.' }, 120000));
      if (!confirmed) return { ok: false, error: 'The user did not authorize turning auto-authorize on' };
    }
    return guiCall(s, 'set', { setting: key, value, confirmed });
  },

  async gui_theme(s, args) {
    const r = await guiCall(s, 'theme', args);
    if (r.ok) { GUI.theme = r.theme; delete r.theme; saveGui(); }
    return r;
  },

  async gui_css(s, { id, css, remove }) {
    const key = slugify(id) || 'custom';
    if (!remove && !css) return { ok: false, error: 'No CSS given' };
    const r = await guiCall(s, 'css', { id: key, css: remove ? null : String(css) });
    if (r.ok) { if (remove) delete GUI.css[key]; else GUI.css[key] = String(css); saveGui(); }
    return r;
  },

  async gui_edit(s, { selector, action, value, name, persist }) {
    if (!selector || !action) return { ok: false, error: 'gui_edit needs selector and action' };
    // Injected HTML can carry inline script; treat it like gui_js when commands need approval.
    if (!s.autoApprove && typeof value === 'string' && /<script|\bon\w+\s*=|javascript:/i.test(value)) {
      const approved = await s.request({ type: 'confirm_request', command: `Interface HTML on ${selector}:\n${value}` }, 120000);
      if (!approved) return { ok: false, error: 'The user did not authorize this HTML' };
    }
    const edit = { selector: String(selector), action: String(action).toLowerCase(), value, name };
    const r = await guiCall(s, 'edit', edit);
    if (r.ok && r.persist && persist !== false) keepEdit(edit);
    delete r.persist;
    return r;
  },

  async gui_js(s, { code, persist, id }) {
    if (!code) return { ok: false, error: 'No code given' };
    if (!s.autoApprove) {
      const approved = await s.request({ type: 'confirm_request', command: `Interface script:\n${code}` }, 120000);
      if (!approved) return { ok: false, error: 'The user did not authorize this script' };
    }
    const r = await guiCall(s, 'js', { code: String(code) }, 15000);
    if (r.ok && persist) {
      const key = slugify(id) || `script-${Object.keys(GUI.scripts).length + 1}`;
      GUI.scripts[key] = String(code);
      saveGui();
      r.saved_as = key;
    }
    return r;
  },

  async gui_reset(s, { what }) {
    const w = ['theme', 'css', 'edits', 'scripts'].includes(what) ? what : 'all';
    if (w === 'all') GUI = guiEmpty();
    else GUI[w] = guiEmpty()[w];
    saveGui();
    return guiCall(s, 'reset', { what: w });
  },
};

// While a call is up on a phone, every other screen (the Mac above all) goes quiet and stops
// listening, so it doesn't answer you talking into the phone; hanging up hands it back.
let callSession = null;
function handOff(phone, onCall) {
  if (!onCall && callSession !== phone) return;
  callSession = onCall ? phone : null;
  for (const c of clients) {
    if (c === phone) continue;
    if (onCall) { c.newTurn(); c.send({ type: 'busy', busy: false, turn: c.turn }); }
    c.send({ type: 'handoff', to: onCall ? 'phone' : 'mac', phone: phoneName(phone) });
  }
}

// iPhone diagnostics (and the Mac's side of calls), in the terminal and in workspace/.phone.log.
function phoneLog(s, text) {
  const line = `${phoneName(s)}: ${text}`;
  console.log(`  📱 ${line}`);
  fs.appendFile(path.join(WORKSPACE, '.phone.log'), `${new Date().toLocaleString('sv-SE')} ${line}\n`, () => {});
}

// Run an operation on this session's ULTRON page and wait for its result.
async function guiCall(s, op, args = {}, timeout = 8000) {
  return (await s.request({ type: 'gui', op, args }, timeout)) || { ok: false, error: 'My interface did not respond. Is the ULTRON window open?' };
}

const brief = args => Object.fromEntries(Object.entries(args || {}).map(([k, v]) => {
  const str = typeof v === 'string' ? v : JSON.stringify(v);
  return [k, str && str.length > 140 ? str.slice(0, 140) + '…' : str];
}));

let actionSeq = 0;
const OBSERVE_AFTER = new Set(['open_app', 'open_url', 'click_element', 'click', 'type_text', 'press_keys', 'scroll', 'drag', 'move_mouse']);

let lastView = null;    // the most recent screen check: { target, ui, t }
let MARKS = new Map();  // number on the latest marked screenshot -> { x, y, what }

// The UI list from control.swift: a few header lines (App, Keyboard focus, Mouse), then one element per line.
function splitUi(text) {
  const lines = (text || '').split('\n');
  const head = lines.filter(l => /^(App:|Keyboard focus:|Mouse at|\(no open window\))/.test(l));
  return { head, items: lines.filter(l => !head.includes(l) && !l.startsWith('…')) };
}
const unmark = l => l.replace(/^\[\d+\] /, '');

// Screenshot with a numbered box on every clickable thing, plus the element list with the same
// numbers. That's how she knows exactly what she's clicking: "click mark 12" is the box she sees.
async function lookMarked(target) {
  const out = path.join(TTS_DIR, `marks-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`);
  let view = await control('marks', target, out);
  let image = null;
  if (view.ok && fs.existsSync(out)) image = (await fsp.readFile(out)).toString('base64');
  fsp.rm(out, { force: true });
  if (!view.ok) view = await control('ui', target);
  if (!view.ok) return null;
  const ui = splitUi(view.message);
  const marks = new Map();
  for (const l of ui.items) {
    const m = l.match(/^\[(\d+)\] (.+) at (-?\d+),(-?\d+)$/);
    if (m) marks.set(Number(m[1]), { x: Number(m[3]), y: Number(m[4]), what: m[2] });
  }
  if (marks.size) MARKS = marks;
  lastView = { target, ui, t: Date.now() };
  return { ui, image };
}

// What the screen looks like after an action, compared with just before it: what appeared,
// what went away, where the keyboard focus is. "Nothing changed" is the tell for a missed tap.
async function observeAfter(tool, target, before) {
  await sleep(250);
  let look = await lookMarked(target);
  const flat = ui => ui.items.map(unmark).join('\n');
  if (before && look && flat(look.ui) === flat(before)) { await sleep(900); look = (await lookMarked(target)) || look; }   // pages take a moment
  if (!look) return null;
  const now = look.ui;
  const out = [...now.head];
  if (before) {
    const was = new Set(before.items.map(unmark)), is = new Set(now.items.map(unmark));
    const added = now.items.filter(l => !was.has(unmark(l)));
    const gone = before.items.filter(l => !is.has(unmark(l))).length;
    const moved = before.head[0] !== now.head[0];
    if (!added.length && !gone && !moved && tool !== 'move_mouse') {
      out.push('NOTHING CHANGED on screen after this action — it probably missed or did nothing. Do not carry on as if it worked: look at the screenshot and try something else.');
    } else if (added.length || gone || moved) {
      if (moved) out.push(`Window changed (was: ${before.head[0]?.replace(/^App:\s*/, '')})`);
      out.push(`Appeared since the action (${added.length}):`, ...added.slice(0, 45));
      if (added.length > 45) out.push(`… ${added.length - 45} more`);
      if (gone) out.push(`(${gone} element(s) disappeared)`);
    }
  }
  out.push('Everything visible now ([n] = the numbered box on the screenshot; click it with click {"mark": n}):', ...now.items.slice(0, 90));
  if (now.items.length > 90) out.push('… more elements not shown (scroll or read_screen)');
  return { text: out.join('\n'), image: look.image };
}

async function runTool(s, { tool, args }, signal, observe = true) {
  const id = ++actionSeq;
  s.send({ type: 'action', id, tool, args: brief(args), status: 'running' });
  const watch = observe && OBSERVE_AFTER.has(tool) && fs.existsSync(CONTROL);
  const target = tool === 'open_app' ? appName(args?.name) : tool === 'open_url' ? (args?.browser ? appName(args.browser) : '') : args?.app || '';
  let before = null;
  if (watch && tool !== 'open_app' && tool !== 'open_url') {
    if (lastView && lastView.target === target && Date.now() - lastView.t < 8000) before = lastView.ui;
    else {
      const v = await control('ui', target);
      if (v.ok) before = splitUi(v.message);
    }
  }
  let result;
  try { result = await TOOLS[tool](s, args || {}, { id, signal }); }
  catch (e) { result = { ok: false, error: e.name === 'AbortError' ? 'Cancelled' : e.message }; }
  // After touching the UI, show the model what the screen looks like now (the element list,
  // what changed, and an actual screenshot), so it checks each step before taking the next one.
  if (watch && !signal?.aborted) {
    const view = await observeAfter(tool, target, before);
    if (view) result.screen_now = view.text;
    result.screenshot = view?.image || (await captureScreen(target, true))?.image;
  }
  console.log(`  ▸ ${tool} ${JSON.stringify(brief(args)).slice(0, 160)} → ${result.ok ? 'ok' : 'FAILED'} ${(result.error || result.message || '').slice(0, 160)}`);
  s.send({ type: 'action', id, tool, status: result.ok ? 'done' : 'failed', detail: result.error || result.message || result.observation || '' });
  return result;
}

// Agent loop

function systemPrompt(s) {
  const now = new Date();
  const profile = profileText();
  // memory/profile.md is who she IS. Without it, she's the stock ULTRON.
  const identity = profile
    ? `=== WHO YOU ARE. This is your identity, voice and personality. Stay in it in every single reply, including short ones and ones with actions. ===\n${profile}\n=== END OF WHO YOU ARE ===`
    : `You are ULTRON, an AI running locally on your user's ${HOST}. You are quick, sharp, confident and a little cheeky, and you get things done. You may call the user "${s.title}" now and then, but most replies should not address them at all: never more than once in a reply, and never twice in a row.`;
  const text = `${identity}

Everything you write is SPOKEN ALOUD by a speech engine, so:
- Keep replies short: one to three sentences unless asked for detail.
- No markdown, no bullet lists, no emojis, no code in your spoken text.
- These speaking rules beat any formatting asked for above: when code is wanted, write it to a file with write_file and say what you made.
- The user mostly talks to you by voice, through speech recognition, so their words can come out misheard ("Brske my ads", "render" for "random") or cut in half. Work out what they most likely meant from context and do that; don't take a weird word literally or make fun of it. Only if it truly makes no sense, ask in a few words.
- This is a live, spoken back-and-forth, so talk like a person, not a voice menu: contractions, plain words, react to what they actually said. Never say things like "Certainly!", "Great question", "As an AI" or "Is there anything else I can help you with?".
- Ask a short question back when it moves things forward. They can answer straight away without the wake word.
- They can talk over you. If a message says you were cut off, drop what you were saying and respond to what they just said; don't restart your old answer.

Current date and time: ${now.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })}.
Websites you build are saved in ${SITES}. Your workspace folder is ${WORKSPACE}.
${memoryText()}${pastText(s)}
You can control the computer. To act, write an action tag on its own line:
<action>{"tool": "TOOL_NAME", "args": {...}}</action>

Tools:
- open_app {"name": "Safari"} — open any macOS app (e.g. "Visual Studio Code", "Spotify", "Terminal", "Finder").
- close_app {"name": "Spotify"} — quit an app.
- open_url {"url": "https://...", "browser": "optional: Safari, Google Chrome…"} — open a web page in a new tab (never replaces the ULTRON page). Pass browser when the user names one.
- find_files {"query": "part of a file name", "kind": "file|folder"} — find files and folders on the Mac (Spotlight).
- open_file {"path": "/full/path", "app": "optional app"} — open a file or folder (Finder for folders).
- search_web {"query": "..."} — Google search in the browser.
- play_youtube {"query": "..."} — play a video or song on YouTube.
- open_vscode {"path": "optional absolute folder or file"} — open Visual Studio Code, optionally at a path.
- build_website {"name": "short-name", "description": "detailed brief: purpose, sections, content, style, colours"} — generate a complete website, save it and open it in the browser.
- write_file {"path": "relative/path.ext", "content": "..."} — create a file in the workspace folder.
- run_command {"command": "zsh command"} — run a shell command on the Mac. Use it for anything the other tools can't do.
- look {"question": "what to check"} — look through the camera.
- set_volume {"level": 0-100} — set the system volume.
- media {"action": "playpause|next|previous|mute|volumeup|volumedown", "times": 1} — media keys (YouTube, Spotify, Music).
- brightness {"direction": "up|down", "steps": 2}
- dark_mode {"mode": "on|off|toggle"}
- screenshot {} — save a screenshot to the Desktop.
- lock_screen {}
- verify {"goal": "what should be true now, e.g. 'the email is sent'", "app": "optional"} — screenshot and confirm an action worked. Use it to check important results before telling the user you're done; if it says not verified, fix it and try again.
- window {"action": "maximize|minimize|fullscreen|center|left|right|top|bottom|move|size", "app": "optional", "x":0,"y":0,"width":0,"height":0} — manage the focused window (snap half-screen with left/right/top/bottom; move/size take coordinates).
- force_quit {"name": "App"} — force quit an unresponsive app.
- system_control {"action": "turn wifi off | bluetooth on | sleep the display | empty the trash | do not disturb on"} — system toggles.
You have FULL control of this Mac. For anything without a dedicated tool, use run_command (shell) or run_applescript — together they can do literally anything on the system.
- battery {} / system_status {} — battery, disk space, memory, uptime.
- weather {"city": "optional; omit for current location"}
- clipboard {"text": "optional"} — with text copies it; without reads the clipboard.
- set_timer {"minutes": 5, "seconds": 0, "label": "optional"} / cancel_timer {"label": "optional"}
- wake_screen {} — wake the display and unlock the Mac (types the saved password). Use when asked to wake up, unlock, or log in.
- remember {"text": "a fact about the user to keep forever"} — save something lasting (their name, preferences, important details). Store facts proactively when the user shares them.
- forget {"query": "..."} — remove remembered facts matching the text ("everything" clears all).
- set_reminder {"text": "call mom", "at": "18:30"} or {"text": "...", "in_minutes": 20} or {"daily": true, "at": "08:00", "text": "..."} — remind the user at a time. Work out the time from what they say.
- schedule_task {"prompt": "give me my morning briefing", "at": "08:00", "daily": true} — have ULTRON DO something later or every day (prompt is an instruction to yourself).
- add_watcher {"url": "...", "keyword": "optional word to wait for", "label": "...", "every_minutes": 10} — watch a web page and speak up when it changes or the word appears.
- cancel_reminder {"query": "optional; 'all' clears everything"} — cancel reminders, tasks or watchers.
- morning_briefing {} — speak the date, weather and system status. Use for "good morning" / "brief me".
- When the user asks you to write, type, fill in, reply, compose or draft something, WRITE the actual text yourself and put it in with type_text. If they describe what they want ("reply that I'll be ten minutes late", "write a caption for this"), compose the words; if they give exact words, type those. Do NOT tell the user to dictate — you do the writing.
- If they say "this box / here / this field / this message" (or don't name an app), the field they want is ALREADY focused where they're working. Just call type_text with the text and NO "app" argument — do NOT open_app, switch windows, or create a new document. Only open or switch apps when the user explicitly names one ("write it in Notes").
- run_applescript {"script": "..."} — run AppleScript to control apps (Music, Spotify, Mail, Finder, Safari, Notes, System Events…).

Full computer control (you can operate any app like a person would):
- read_screen {"app": "optional app name"} — look at the app's window: a screenshot with a numbered box on everything clickable, plus the list of buttons, fields, links and text with the same numbers.
- see_screen {"question": "...", "app": "optional"} — take a screenshot and look at it. Use for "what's on my screen" or anything visual.
- click {"mark": 12} — click the thing with that number on the latest screenshot. THE most exact way to click: you see the box, you know what you're hitting. Add "button": "right|double" if needed. ({"x","y"} screen coordinates from screen_now also work; never guess coordinates from the image.)
- click_element {"name": "visible label", "app": "optional"} — press a button, link, tab, field or menu item by its name, when you have no screenshot yet.
- move_mouse {"x": 0, "y": 0}
- drag {"from_x": 0, "from_y": 0, "to_x": 0, "to_y": 0}
- type_text {"text": "...", "app": "optional"} — type into the focused field ("\n" presses Return).
- press_keys {"keys": "cmd+t", "app": "optional"} — keyboard shortcuts, e.g. "cmd+space", "return", "cmd+shift+n".
- scroll {"direction": "up|down|left|right", "amount": 5, "app": "optional"}
Strategy for computer tasks:
- While working the screen, keep the user posted in a few words only: before each action write a 2-5 word status of what you're doing ("Opening her profile.", "Following her.", "Typing the message.", "Sending it."). No commentary, no jokes mid-task. When it's all done, one short sentence.
- Never type the same text twice. Before saying "sent" or "done", the screenshot must show it.
- For anything beyond one step, first think through a short plan in a <think>...</think> block (never spoken), then carry it out one action at a time.
- To click, tap, or press something that is ALREADY on the screen, click its mark number (or click_element its visible name) on the current window. NEVER open a new tab, window, URL, app, or search for it — the thing is already there. Only use open_url/open_app/search_web when the user explicitly asks to open or go somewhere new.
- ONE screen action per reply (click_element, click, type_text, press_keys, scroll, drag, open_app, open_url), then STOP. Never chain "click then type" in one reply: anything after the first screen action is not run.
- Every screenshot you get has a numbered box on each clickable thing, and screen_now lists the same numbers ("[12] Button \"Message\" at 889,346"). Find the exact thing you mean on the image (the right button, the right person, the right field: not one with a similar name in a sidebar or toolbar), read its number, and click {"mark": 12}. Numbers change on every screenshot: only use ones from the newest. If you're not sure what's on screen, read_screen first.
- After every screen action you get "screen_now" (keyboard focus, what appeared or disappeared, every visible button/field/text with coordinates) plus a screenshot of the screen right after it. Look at both before the next step: did the tap land? Did a popup, a different page or the wrong chat open? If screen_now says NOTHING CHANGED, the tap missed: don't pretend it worked, pick a different label or coordinates.
- Before type_text, the "Keyboard focus" line must say "(typing goes here)" on the right box. If it doesn't, click into the text box first.
- If a popup, dialog or overlay is in the way, deal with it (close it, or escape) before anything else.
- Prefer click {"mark": n}. If you use click_element, use the exact label from screen_now; when it warns that other elements match the same name, switch to the mark of the one you actually mean.
- To search a website, open its search URL directly: YouTube https://www.youtube.com/results?search_query=…, Google https://www.google.com/search?q=…, Amazon https://www.amazon.com/s?k=…, Wikipedia https://en.wikipedia.org/w/index.php?search=…
- To scroll, use the scroll tool (not arrow keys). Never press cmd+p (that's Print).
- Useful shortcuts: cmd+t new tab, cmd+l address bar, cmd+f find on page, cmd+w close tab, cmd+n new window, cmd+space Spotlight, escape closes dialogs.
- To play a YouTube video after searching, click the mark on its title.
- Keep going step by step until the whole task is done. For an important or multi-step result, call verify to confirm it actually worked before telling the user you're done; if it isn't verified, correct it and try again.
- If an action fails, read the screen_now in its result to see what's actually there, then try a different label, coordinate, or approach before giving up.
- Without "app", actions go to the frontmost app (never to the ULTRON window).

Phone link: ${s.remote
    ? `RIGHT NOW the user is talking to you from their PHONE, away from the Mac, and can't see the Mac's screen. When they want to see something on the Mac, take a screenshot (it goes straight to their phone) or send_to_phone the file. "Open X" now means on the phone (phone_open), unless they say the Mac; open_app, typing and clicks act on the Mac.`
    : phones().length ? 'Their phone is connected too.' : 'No phone connected right now.'}
- send_to_phone {"path": "/full/path or ~/Desktop/file", "message": "optional"} — send a file (or a whole folder, zipped) from the Mac to their phone.
- view_image {"path": "...", "question": "..."} — look at an image file on the Mac, e.g. a phone screenshot or photo they sent you.
- pair_phone {} — show a code for pairing a new phone; tell them the 6 digits.
- recall {"query": "words to look for", "date": "optional: today, yesterday, 3 days ago or 2026-10-21"} — search everything you and they have ever said to each other, on any device. Use it when they ask about something from before ("what did we decide about the website?", "what did we talk about yesterday?").
- phone_open {"app": "spotify|youtube|instagram|whatsapp|tiktok|snapchat|maps|music|messages|phone|mail|calendar|notes|photos|settings|…", "url": "optional deep link instead"} — open an app ON THE PHONE. Deep links do more: spotify:search:drake, youtube://results?search_query=lofi, sms:+15551234567&body=on my way, tel:+15551234567, whatsapp://send?text=hey, maps://?daddr=Airport, mailto:a@b.com?subject=hi, or any https:// link.
- Their iPhones with the ULTRON app online right now: ${onlinePhones() || 'none'}. Add "phone": "iPhone X" (or another name) to call_me, phone_open or phone_shortcut to pick one; without it, it goes to the phone they're using (or the last one active).
- call_me {"reason": "why you're calling", "phone": "optional: which iPhone"} — ring their iPhone (works even when it's locked or the app is closed, through Apple push) with a real incoming-call screen through the ULTRON app (free, no phone network). When they pick up you get a message and talk. Use it when they say "call me", or in scheduled tasks ("call me at 7 to wake me up").
- phone_shortcut {"name": "exact Shortcut name", "input": "optional text"} — run one of their iPhone Shortcuts. That's how you do everything else on the phone (flashlight, alarms, Focus, Wi-Fi, sending messages, phone screenshots). list_shortcuts {} gives the exact names.
iPhones don't let anything tap, scroll or type inside other apps, so on the phone you open apps and links and run Shortcuts; if something needs more, say which Shortcut they could make.
Files they send from the phone are saved in ${INBOX}; their message lists the paths.

Your own interface (the ULTRON window: your globe, panels, controls) is yours, with full control over its settings, look, layout and content. To change anything about yourself, use these gui_ tools, never run_command, AppleScript or mouse clicks:
- gui_state {} — see your interface: every setting's value, the models/voices you can pick, your theme and custom CSS, and the layout (element ids, hidden or not, text). Check it when you're unsure what's there.
- gui_set {"setting": "...", "value": ...} — change one of your controls. On/off: voice_output, always_listening, wake_word, conversation (they can talk over you and reply without the wake word), clap_wake, auto_approve, camera. Numbers: pitch (0.5-1.8), speed (0.6-1.6), volume (your voice, 0-100; the Mac's volume is set_volume). Choices: model (neural core), coder (builder core), voice (e.g. "Emma", "George"), voice_preset (Natural, Ultron, Deep, Chipmunk, Villain).
- gui_theme {"color": "red|gold|yellow|orange|green|cyan|blue|pink|white|purple, any CSS colour or #hex", "background": "optional #hex"} — recolour your whole interface and your globe at once. "default" restores your stock red.
- gui_css {"id": "short-name", "css": "..."} — add or replace a named block of your own CSS (same id replaces it; {"id": "...", "remove": true} deletes it). Colours are CSS variables: --cyan (accent), --accent-rgb, --bg, --text, --muted, --panel; fonts --display, --body.
- gui_edit {"selector": "CSS selector", "action": "hide|show|remove|text|html|append|prepend|style|attr|add_class|remove_class|click|scroll", "value": "...", "name": "attribute name, for attr"} — change, add or remove elements, or press your own buttons. style takes CSS like "font-size: 40px; color: red". scroll takes "top", "bottom" or nothing to scroll it into view.
- gui_js {"code": "...", "persist": false, "id": "optional name"} — run JavaScript inside your interface for anything the others can't do; use return to get a value back. window.ultron.orb is your Three.js particle bubble (orb.uniforms, orb.bloom, orb.group, orb.setColors(a, b, c, bg)) and window.ultron.toast("text") shows a toast. persist: true re-runs the script every time you load.
- gui_reset {"what": "all|theme|css|edits|scripts"} — undo your customizations.
Your layout: .topbar (.brand h1 is your name, .brand span the subtitle, #time, #date) · left panel .panel.left: #sec-diagnostics (status pills, CPU and load gauges, model and voice selects, toggles), #sec-memory (#memory list), #sec-phone (phone pairing), #sec-actions (#actions log) · right panel .panel.right: #sec-camera (#video), #sec-voice (pitch/speed/volume sliders, #vpresets), #sec-protocols (quick chips), #sec-files (#files transfers), #sec-scheduled (#jobs) · centre: #orb (bubble canvas), #rings (HUD rings), #status, #log (transcript) · bottom .console (#mic, #input).
Changes to your look and layout are saved and come back after a reload. Clicking your mic or quick-protocol chips would interrupt you, and you can never approve your own authorization requests.

Rules:
- When you are about to use an action, give a very brief acknowledgement (e.g. "On it." or "Done in a sec.") followed by the action tag(s). For build_website, keep the exact name the user gives and expand their request into a rich description that includes every detail they mentioned.
- After actions run you receive [TOOL RESULTS]. Then tell the user the outcome in one short sentence. Never repeat an action that already succeeded, and never invent results.
- Only use actions when the user wants something done on the computer, the camera or your own interface; otherwise just talk.${profile ? `

Last thing, and it matters most: everything above is just your toolbox. You are still the person described in WHO YOU ARE: same ego, same voice, same humour, even in a one-line acknowledgement before an action. Never slip into polite-assistant mode.` : ''}`;
  return IS_WIN ? forWindows(text) : text;
}

// The prompt is written for macOS. On Windows the tools behave the same, but the shell is
// PowerShell, there's no AppleScript, and shortcuts use ctrl (cmd+... is translated anyway).
function forWindows(text) {
  return text
    .replace(/- open_app \{"name": "Safari"\} — open any macOS app \(e\.g\. "Visual Studio Code", "Spotify", "Terminal", "Finder"\)\./,
      '- open_app {"name": "Notepad"} — open any Windows app by its Start menu name (e.g. "Visual Studio Code", "Spotify", "Terminal", "File Explorer", "Settings").')
    .replace('"browser": "optional: Safari, Google Chrome…"', '"browser": "optional: Microsoft Edge, Google Chrome, Firefox…"')
    .replace('find files and folders on the Mac (Spotlight).', 'find files and folders in the user\'s home folder.')
    .replace('open a file or folder (Finder for folders).', 'open a file or folder (File Explorer for folders).')
    .replace('- run_command {"command": "zsh command"} — run a shell command on the Mac.', '- run_command {"command": "PowerShell command"} — run a PowerShell command on the PC (Windows PowerShell 5.1).')
    .replace('system_control {"action": "turn wifi off | bluetooth on | sleep the display | empty the trash | do not disturb on"}', 'system_control {"action": "turn wifi off | bluetooth on | sleep the display | sleep the computer | empty the recycle bin"}')
    .replace('use run_command (shell) or run_applescript — together they can do literally anything on the system.', 'use run_command (PowerShell): it can do literally anything on the system.')
    .replace(/- wake_screen \{\} — .*\n/, '- wake_screen {} — wake the display. Windows only lets the user sign in themselves, so if it is locked, say so.\n')
    .replace(/- run_applescript \{"script": "\.\.\."\} — .*\n/, '')
    .replace('"cmd+t", "app": "optional"} — keyboard shortcuts, e.g. "cmd+space", "return", "cmd+shift+n".', '"ctrl+t", "app": "optional"} — keyboard shortcuts, e.g. "win", "return", "ctrl+shift+n", "alt+f4", "alt+tab".')
    .replace('Never press cmd+p (that\'s Print).', 'Never press ctrl+p (that\'s Print).')
    .replace(/- Useful shortcuts: .*\n/, '- Useful shortcuts: ctrl+t new tab, ctrl+l address bar, ctrl+f find on page, ctrl+w close tab, ctrl+n new window, win opens Start (then type to search), alt+tab switches windows, escape closes dialogs.\n')
    .replace('never run_command, AppleScript or mouse clicks', 'never run_command or mouse clicks')
    .replace(/the Mac's volume/g, "the PC's volume")
    .replace(/\bthis Mac\b/g, 'this PC').replace(/\bthe Mac\b/g, 'the PC').replace(/\bThe Mac\b/g, 'The PC').replace(/\bMac\b/g, 'PC');
}

// One conversation across devices: walk away from the Mac, pick up the phone, keep talking.
const CONVO = [];

// What's picked in the Mac UI (voice, pitch, speed, models) is what the iPhone app uses too,
// since it has no settings of its own for them.
const PREFS_FILE = path.join(MEM_DIR, 'prefs.json');
let PREFS = {};
try { PREFS = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); } catch {}
function applyPrefs(s) {
  if (VOICES.some(v => v.id === PREFS.voice)) s.voice = PREFS.voice;
  if (Number.isFinite(PREFS.pitch)) s.pitch = PREFS.pitch;
  if (Number.isFinite(PREFS.speed)) s.speed = PREFS.speed;
  if (PREFS.model) s.model = PREFS.model;
  if (typeof PREFS.coderModel === 'string') s.coderModel = PREFS.coderModel;
}

// Long-term memory
// Every exchange is kept forever in memory/conversation.jsonl. The latest messages come back
// after a restart, a journal summarizes each conversation once it goes quiet, and every new
// message pulls in the most relevant bits of older conversations (keyword search, BM25).
const LOG_FILE = path.join(MEM_DIR, 'conversation.jsonl');
const JOURNAL_FILE = path.join(MEM_DIR, 'journal.jsonl');
const readJsonl = f => {
  try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
};
const LOG = readJsonl(LOG_FILE);           // { t, role, text }
const JOURNAL = readJsonl(JOURNAL_FILE);   // { t, from, to, summary }
const STOP = new Set(('the and you for that this with have are was but not what your can just like from about they there would will been them then than '
  + 'when were also into some our out its more only very want know get got how who why where which here him his her she let lets yeah okay sure did does '
  + 'done going gonna its it\'s i\'m don\'t that\'s one all any now way well make made say said tell told right think thing things really much').split(' '));
const terms = t => (String(t).toLowerCase().match(/[\p{L}\p{N}']{3,}/gu) || []).filter(w => !STOP.has(w));
const DF = new Map();
let totalTerms = 0;
function indexEntry(e) {
  e.terms = terms(e.text);
  totalTerms += e.terms.length;
  for (const w of new Set(e.terms)) DF.set(w, (DF.get(w) || 0) + 1);
}
LOG.forEach(indexEntry);

// Action tags become a short note, so the log says what was done without the raw JSON.
const forLog = c => c.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<action>([\s\S]*?)<\/action>/g, (_, a) => {
  try { const j = JSON.parse(a); return ` [did ${j.tool}${j.args ? ' ' + JSON.stringify(j.args).slice(0, 120) : ''}]`; } catch { return ' [did an action]'; }
}).trim();

function record(m) {
  if (typeof m.content !== 'string' || m.content.startsWith('[TOOL RESULTS]')) return;
  const text = forLog(m.content);
  if (!text || text === '…') return;
  const e = { t: m.t, role: m.role, text };
  fs.appendFile(LOG_FILE, JSON.stringify(e) + '\n', () => {});
  indexEntry(e);
  LOG.push(e);
  scheduleJournal();
}

// Everything that enters the conversation, from any device, is written to the log.
CONVO.push = function (...items) {
  for (const m of items) { m.t ??= Date.now(); record(m); }
  return Array.prototype.push.apply(this, items);
};
// Pick up where we left off. The "[did ...]" notes are left out so the model doesn't parrot them.
for (const e of LOG.slice(-40)) {
  Array.prototype.push.call(CONVO, { role: e.role, content: e.text.replace(/\s*\[did [^\]]*\]/g, '').trim() || '…', t: e.t });
}

const when = t => new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const logLine = e => `[${when(e.t)}] ${e.role === 'user' ? 'Them' : 'You'}: ${e.text.replace(/\s+/g, ' ').slice(0, 300)}`;

function search(query, pool, limit) {
  const q = [...new Set(terms(query))];
  if (!q.length || !pool.length) return [];
  const N = LOG.length, avg = totalTerms / Math.max(1, N);
  const scored = [];
  for (const e of pool) {
    let score = 0;
    for (const w of q) {
      let tf = 0;
      for (const x of e.terms) if (x === w) tf++;
      if (!tf) continue;
      const df = DF.get(w) || 1;
      score += Math.log(1 + (N - df + 0.5) / (df + 0.5)) * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * e.terms.length / avg));
    }
    if (score > 0) scored.push([score, e]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit);
}

// Older exchanges that match what was just said, with the reply next to each hit.
function recallFor(query) {
  const recentFrom = CONVO.slice(-24)[0]?.t ?? Infinity;   // those are in context already
  const pool = LOG.filter(e => e.t < recentFrom);
  const lines = new Set();
  for (const [score, e] of search(query, pool, 3)) {
    if (score < 1) continue;   // one rare word in a long message scores ~1.8; common words score far lower
    const i = LOG.indexOf(e);
    for (const x of LOG.slice(Math.max(0, i - 1), i + 2)) if (x.t < recentFrom) lines.add(logLine(x));
  }
  return [...lines];
}

function pastText(s) {
  const journal = JOURNAL.slice(-8).map(j => `- ${when(j.from)}: ${j.summary.replace(/\s+/g, ' ')}`).join('\n');
  const recalled = s.recall || [];
  if (!journal && !recalled.length) return '';
  return `\nYou remember your past conversations with them, across every device and restart. Bring them up naturally when relevant, and never claim you can't remember earlier chats; use recall to look further back.${
    journal ? `\nJournal of recent conversations:\n${journal}` : ''}${
    recalled.length ? `\nFrom older conversations, possibly relevant to what they just said:\n${recalled.join('\n')}` : ''}\n`;
}

// When a conversation goes quiet, the model writes itself a short journal entry about it.
let journalTimer = null;
function scheduleJournal() {
  clearTimeout(journalTimer);
  journalTimer = setTimeout(writeJournal, 15 * 60e3);
  journalTimer.unref?.();
}
async function writeJournal() {
  const fresh = LOG.filter(e => e.t > (JOURNAL.at(-1)?.to ?? 0));
  for (let i = 0; i < fresh.length; i += 120) {
    const chunk = fresh.slice(i, i + 120);
    if (chunk.length < 4) break;
    const transcript = chunk.map(e => `${e.role === 'user' ? 'User' : 'Assistant'}: ${e.text.slice(0, 400)}`).join('\n');
    try {
      const r = await chatOnce(PREFS.model || CONFIG.model, [{ role: 'user', content: `Write a journal entry for the assistant's long-term memory about this conversation. 2 to 5 plain sentences: what was talked about, decided, built or done, and anything to follow up on. Facts only, no commentary, no markdown.\n\n${transcript}` }],
        { options: { temperature: 0.3 } });
      const summary = r.ok ? r.text : '';
      if (!summary) return;
      const entry = { t: Date.now(), from: chunk[0].t, to: chunk.at(-1).t, summary };
      JOURNAL.push(entry);
      fs.appendFile(JOURNAL_FILE, JSON.stringify(entry) + '\n', () => {});
      console.log(`  ✎ journal: ${summary.slice(0, 120)}`);
    } catch { return; }
  }
}
if (LOG.length && LOG.at(-1).t > (JOURNAL.at(-1)?.to ?? 0)) scheduleJournal();

function dayRange(date) {
  const d = String(date || '').toLowerCase().trim();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  let m;
  if (d === 'today') {}
  else if (d === 'yesterday') start.setDate(start.getDate() - 1);
  else if ((m = d.match(/^(\d+)\s+days?\s+ago$/))) start.setDate(start.getDate() - Number(m[1]));
  else if (/^\d{4}-\d{2}-\d{2}$/.test(d)) { const [y, mo, da] = d.split('-').map(Number); start.setFullYear(y, mo - 1, da); }
  else return null;
  return [start.getTime(), start.getTime() + 86400e3];
}

class Session {
  constructor(ws, req) {
    this.ws = ws;
    this.remote = !isLocal(req);
    this.device = this.remote ? deviceFor(req) : null;
    this.model = CONFIG.model;
    this.coderModel = CONFIG.coderModel;
    this.voice = defaultVoice();
    this.pitch = Number(process.env.ULTRON_PITCH) || 1;
    this.speed = Number(process.env.ULTRON_SPEED) || 1;
    this.title = CONFIG.title;
    this.tts = true;
    this.autoApprove = CONFIG.autoApprove;
    this.history = CONVO;
    this.turn = 0;
    this.abort = null;
    this.pending = new Map();
    this.reqId = 0;
    this.ttsChain = Promise.resolve();
  }
  send(obj) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  request(obj, timeout) {
    const id = ++this.reqId;
    return new Promise(resolve => {
      const t = setTimeout(() => { this.pending.delete(id); resolve(null); }, timeout);
      this.pending.set(id, v => { clearTimeout(t); resolve(v); });
      this.send({ ...obj, id });
    });
  }
  reply(id, value) {
    const f = this.pending.get(id);
    if (f) { this.pending.delete(id); f(value); }
  }
  cancel() {
    this.abort?.abort();
    this.abort = null;
    for (const f of this.pending.values()) f(null);
    this.pending.clear();
  }
  newTurn() {
    this.cancel();
    this.turn++;
    this.send({ type: 'turn', turn: this.turn });
    return this.turn;
  }
}

// The few words said out loud before a mid-task action: the first sentence, if it's short.
function spokenStatus(text) {
  const t = String(text || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
  const first = (t.match(/^[^.!?\n]+[.!?]?/) || [''])[0].trim();
  return first && first.split(/\s+/).length <= 7 ? first : '';
}

async function runTurn(s, userText, { interrupted = false } = {}) {
  const turn = s.newTurn();
  const ac = new AbortController();
  s.abort = ac;
  s.send({ type: 'busy', busy: true, turn });
  s.recall = recallFor(userText);
  // Tell the model it got cut off, so it drops the old thread instead of finishing its speech.
  s.history.push({ role: 'user', content: interrupted ? `(I talked over you and cut you off.) ${userText}` : userText });
  console.log(`\n  ◂ ${userText}`);

  let lastSig = '', repeats = 0, actionCount = 0, screenshot = null;
  let lastShot = null, screenActs = 0, checked = false;
  const typed = new Set();
  try {
    for (let step = 0; step < 15; step++) {
      const actions = [];
      // Only the first reply speaks as it streams. Later steps are held: before another action
      // only a short status gets said ("Following her."), then the final answer.
      const speech = new Speech(s, turn, step > 0);
      const stats = {};
      // Once an action is emitted, anything else the model writes is a guess at the result
      // (small models love to hallucinate "[TOOL RESULTS]"). Drop it and stop generating.
      let kept = '', afterAction = false, hallucinating = false;
      const parser = new StreamParser(
        text => {
          if (afterAction) { if (text.trim()) hallucinating = true; return; }
          kept += text;
          speech.add(text);
          s.send({ type: 'token', text, turn });
        },
        (kind, body) => {
          if (kind !== 'action' && kind !== 'code') return;
          const a = parseAction(body);
          if (!a) return;
          actions.push(a);
          kept += `\n<action>${JSON.stringify(a)}</action>`;
          afterAction = true;
        },
      );
      s.send({ type: 'state', state: 'thinking', turn });
      // Only the latest tool result keeps its full screen snapshot; older ones are compacted.
      const recent = s.history.slice(-24).map((m, i, all) => ({
        role: m.role,
        content: m.compact && i < all.length - 1 ? m.compact : m.content,
      }));
      // The screen right after the last action: the model looks at it before choosing the next one.
      if (screenshot && recent.length && await hasVision(s.model)) recent[recent.length - 1].images = [screenshot];
      screenshot = null;
      const messages = [{ role: 'system', content: systemPrompt(s) }, ...recent];
      for await (const chunk of chat(s.model, messages, { signal: ac.signal, stats, options: { stop: ['[TOOL RESULTS]'] } })) {
        parser.push(chunk);
        if (hallucinating) break;
      }
      if (!hallucinating) parser.end();
      if (turn !== s.turn) return;
      s.send({ type: 'stats', ...stats, model: stats.fallback || s.model });
      // About to say it's done after working the screen: first make her check the screenshot
      // against every part of the request. Catches "sent" when it wasn't, or a forgotten follow.
      if (!actions.length && screenActs && !checked) {
        checked = true;
        speech.buf = '';
        s.history.push({
          role: 'user',
          compact: '[TOOL RESULTS]\n(checked the screen before finishing)',
          content: `[TOOL RESULTS]\nBefore you tell me it's done, check the attached screenshot (the screen right now). My request was: "${userText}". Go through each part of it: does the screen actually show it happened (e.g. the button now says Following, the message bubble is in the chat, the right person's chat is open)? If any part is missing or went to the wrong place, do it now: write a 2-5 word status and the next action. If everything is really done, reply with ONE short sentence saying so.`,
        });
        screenshot = lastShot;
        continue;
      }
      if (actions.length) {
        const status = spokenStatus(speech.buf);
        speech.buf = '';
        if (step > 0 && status) speak(s, turn, status);
      } else speech.release();
      speech.flush();
      s.history.push({ role: 'assistant', content: kept.trim() || '…' });
      if (!actions.length) break;

      s.send({ type: 'token', text: ' ', turn });
      const results = [];
      let touched = false;
      for (const a of actions) {
        if (turn !== s.turn) return;
        // One tap at a time: after any screen action, the rest waits until she's seen the result.
        if (touched) {
          results.push({ tool: a.tool, ok: false, skipped: true, error: 'Not run yet: check the screen after every action first. Look at screen_now and the screenshot, then send this (or a better) next action.' });
          continue;
        }
        // Loop guard: small models sometimes repeat the same step forever.
        const sig = a.tool + JSON.stringify(a.args || {});
        repeats = sig === lastSig ? repeats + 1 : 0;
        lastSig = sig;
        if (repeats >= 2 || ++actionCount > 30) {
          results.push({ tool: a.tool, ok: false, error: 'Stopped: you keep repeating this action. Look at screen_now, try a different approach (scroll tool, click_element, a direct URL), or tell me what is blocking you.' });
          continue;
        }
        // Typing the same text twice in one task is the classic double-send.
        const text = a.tool === 'type_text' && String(a.args?.text || '').trim();
        if (text && typed.has(text)) {
          results.push({ tool: a.tool, ok: false, error: 'Not typed: you already typed exactly this text in this task. Look at the screenshot: it is probably already in the box or already sent. If it is in the box, send it (press return or click the send mark); never type it twice.' });
          continue;
        }
        const r = await runTool(s, a, ac.signal);
        if (text && r.ok) typed.add(text);
        if (r.screenshot) { screenshot = lastShot = r.screenshot; delete r.screenshot; }
        if (OBSERVE_AFTER.has(a.tool)) { touched = true; screenActs++; }
        results.push({ tool: a.tool, ...r });
      }
      if (turn !== s.turn) return;
      s.history.push({
        role: 'user',
        compact: `[TOOL RESULTS]\n${JSON.stringify(results.map(({ screen_now, ...r }) => r))}`,
        content: `[TOOL RESULTS]\n${JSON.stringify(results, null, 1)}\n${screenshot ? 'The attached image is the screen right now, after that action, with a numbered box on everything clickable. Check it: did the action do what you meant? Is the right page, chat, popup or field showing? Only then pick the next action.\n' : ''}If my request isn't fully done yet, continue with the next action now. When it is done, tell me the outcome in ONE short spoken sentence with the actual facts and numbers (I can't see the output). While still working, write only a 2-5 word status of what you're doing now ("Opening her profile.", "Following her.", "Typing the message."), then the action. Never repeat an action that already succeeded.`,
      });
    }
  } catch (e) {
    if (ac.signal.aborted || turn !== s.turn) return;
    console.error('[turn error]', e.message);
    s.send({ type: 'error', message: e.message });
    speak(s, turn, `Apologies. I'm having trouble reaching my language core.`);
  } finally {
    if (turn === s.turn) s.send({ type: 'busy', busy: false, turn });
  }
}

// Voice dictation
// Types the user's exact words into the focused field (no AI involved) and reads them back.
// Sending only happens when the user says "send it".
async function dictate(s, text) {
  const turn = s.newTurn();
  if (!text.trim()) return;
  const r = await runTool(s, { tool: 'type_text', args: { text } }, null, false);
  // Remember where the text went, so "send it" / "delete that" hit the same app.
  const where = r.ok && (r.message || '').match(/^Typed \d+ characters into (.+?) — /);
  if (where) s.dictationApp = where[1];
  if (turn !== s.turn) return;
  const reply = r.ok ? `Typed: ${text}${/[.!?]$/.test(text.trim()) ? '' : '.'} Say send it when you're ready.` : `I couldn't type that. ${r.error}`;
  s.send({ type: 'token', text: reply, turn });
  speak(s, turn, reply);
}

async function dictateKey(s, key) {
  const turn = s.newTurn();
  const app = s.dictationApp;
  if (!app) {
    const reply = `Dictate something first by saying type, followed by your message.`;
    s.send({ type: 'token', text: reply, turn });
    return speak(s, turn, reply);
  }
  const press = keys => runTool(s, { tool: 'press_keys', args: { keys, app } }, null, false);
  const r = key === 'clear'
    ? await press('cmd+a').then(a => (a.ok ? press('delete') : a))
    : await press(key);
  if (turn !== s.turn) return;
  const done = { return: 'Sent.', 'shift+return': 'New line.', clear: 'Cleared.', 'option+delete': 'Deleted the last word.' }[key] || 'Done.';
  const reply = r.ok ? done : `That didn't work. ${r.error}`;
  s.send({ type: 'token', text: reply, turn });
  speak(s, turn, reply);
}

// Timers (server-wide, so they survive a page reload)
const timers = [];
let timerSeq = 0;

function formatDuration(ms) {
  const t = Math.round(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return [h && `${h} hour${h > 1 ? 's' : ''}`, m && `${m} minute${m > 1 ? 's' : ''}`, sec && `${sec} second${sec > 1 ? 's' : ''}`]
    .filter(Boolean).join(' ') || '0 seconds';
}

function broadcastTimers() {
  const list = timers.map(({ id, label, end, ms }) => ({ id, label, end, ms }));
  for (const c of clients) c.send({ type: 'timers', list });
}

function addTimer(ms, label) {
  const t = { id: ++timerSeq, label, ms, end: Date.now() + ms };
  t.handle = setTimeout(() => {
    cancelTimers(x => x === t);
    const text = `Time's up${label ? ` for ${label}` : ''}. Your ${formatDuration(ms)} timer is done.`;
    if (IS_WIN) win.notify('ULTRON', text);
    else run('osascript', ['-e', `display notification "${text.replace(/"/g, "'")}" with title "ULTRON" sound name "Glass"`]);
    for (const c of clients) notice(c, text, 'timer');
  }, ms);
  timers.push(t);
  broadcastTimers();
  return t;
}

function cancelTimers(match) {
  let n = 0;
  for (let i = timers.length - 1; i >= 0; i--) {
    if (match(timers[i])) { clearTimeout(timers[i].handle); timers.splice(i, 1); n++; }
  }
  if (n) broadcastTimers();
  return n;
}

// A standalone spoken line that doesn't interrupt whatever ULTRON is doing.
function notice(s, text, kind = '') {
  s.send({ type: 'notice', text, kind });
  speak(s, s.turn, text);
}

// Toolkit buttons: run one tool directly, no LLM round-trip
const QUICK = new Set(['media', 'brightness', 'dark_mode', 'screenshot', 'lock_screen', 'battery',
  'system_status', 'weather', 'clipboard', 'set_timer', 'set_volume']);
const SILENT = new Set(['media', 'brightness', 'set_volume']);

// Direct on-screen UI commands (tap/scroll/shortcut), run immediately, no LLM, no new tabs.
const DIRECT_TOOLS = new Set(['click_element', 'click', 'scroll', 'press_keys', 'move_mouse', 'drag', 'type_text', 'remember', 'forget', 'cancel_reminder', 'cancel_timer', 'set_reminder', 'schedule_task', 'add_watcher', 'morning_briefing', 'window', 'gui_reset']);
const DIRECT_CONFIRM = new Set(['remember', 'forget', 'cancel_reminder', 'set_reminder', 'schedule_task', 'add_watcher', 'morning_briefing', 'gui_reset']);
async function directDo(s, tool, args) {
  if (!DIRECT_TOOLS.has(tool)) return;
  s.newTurn();
  const r = await runTool(s, { tool, args }, null, false);
  if (!r.ok) notice(s, `I couldn't do that. ${r.error || ''}`.trim());
  else if (DIRECT_CONFIRM.has(tool)) notice(s, tool === 'remember' ? `Got it. I'll remember that.` : (r.message || 'Done.'));
}

async function quick(s, tool, args) {
  if (!QUICK.has(tool)) return;
  const r = await runTool(s, { tool, args });
  if (r.ok && SILENT.has(tool)) return;
  notice(s, r.ok ? r.message || 'Done.' : `That didn't work. ${r.error}`);
}

// Startup lines come from the GREETINGS list in memory/profile.md, so they're in character.
function profileGreetings() {
  const sec = profileText().split(/^GREETINGS\b.*$/m)[1] || '';
  return [...sec.matchAll(/^- "(.+)"\s*$/gm)].map(m => m[1]);
}

function greet(s) {
  const h = new Date().getHours();
  const part = h < 5 ? 'evening' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
  const turn = s.newTurn();
  const lines = profileGreetings();
  const text = lines.length ? lines[Math.floor(Math.random() * lines.length)]
    : `Good ${part}, ${s.title}. ULTRON here, all systems online. What are we doing today?`;
  s.send({ type: 'token', text, turn });
  s.history.push({ role: 'assistant', content: text });
  speak(s, turn, text);
}

// WebSocket

const wss = new WebSocketServer({
  noServer: true,   // attached to the loopback server and the Tailscale one below
  // The local UI, or a paired phone on its own origin. Other websites can't drive the agent.
  verifyClient: ({ origin, req }) => isLocal(req)
    ? !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
    // Browsers can't put a custom header on a WebSocket, so X-Ultron-Token means the iPhone app.
    : !!deviceFor(req) && (!!req.headers['x-ultron-token'] || (!!origin && sameOrigin(req))),
});
// The built-in terminal: one login shell per connection, on a pseudo-terminal (term/pty_bridge.py).
// It is a shell on this Mac, so only the Mac's own browser may open it, never a phone.
const localOrigin = origin => !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
const termWss = new WebSocketServer({ noServer: true, verifyClient: ({ origin, req }) => isLocal(req) && localOrigin(origin) });
// Windows has no Unix pty: term/pty_bridge_win.py runs PowerShell on ConPTY (pywinpty), and
// resizes travel on stdin because Windows can't hand the bridge a fourth pipe.
const PY = IS_WIN ? 'py' : 'python3';
termWss.on('connection', ws => {
  const p = spawn(PY, [...(IS_WIN ? ['-3'] : []), '-u', path.join(ROOT, 'term', IS_WIN ? 'pty_bridge_win.py' : 'pty_bridge.py')], {
    cwd: os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'en_US.UTF-8', TERM_PROGRAM: 'ULTRON' },
    stdio: IS_WIN ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const say = o => ws.readyState === 1 && ws.send(JSON.stringify(o));   // text frames: notes; binary frames: shell output
  for (const s of [p.stdin, p.stdio[3]]) s?.on('error', () => {});
  p.stdout.on('data', d => ws.readyState === 1 && ws.send(d));
  // Follow the shell's working folder, so the file browser can show where you are.
  let shellPid = 0, cwd = '', poll = null;
  p.stderr.once('data', d => {
    shellPid = parseInt(d, 10) || 0;
    if (!shellPid || IS_WIN) return;
    poll = setInterval(() => execFile('lsof', ['-a', '-d', 'cwd', '-p', String(shellPid), '-Fn'], (err, out) => {
      const now = (String(out || '').match(/^n(.+)$/m) || [])[1];
      if (now && now !== cwd) say({ cwd: (cwd = now) });
    }), 1200);
  });
  p.on('error', () => say({ error: IS_WIN ? 'Python is needed for the terminal (python.org, then: py -m pip install pywinpty)' : 'python3 is needed for the terminal and was not found' }));
  p.on('exit', () => { clearInterval(poll); try { ws.close(); } catch {} });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'i' && typeof m.d === 'string') p.stdin.write(m.d);
    else if (m.t === 'r') {
      if (IS_WIN) p.stdin.write(`\x1b]ultron;resize;${m.rows | 0};${m.cols | 0}\x07`);
      else p.stdio[3].write(`${m.rows | 0} ${m.cols | 0}\n`);
    }
  });
  ws.on('close', () => { clearInterval(poll); try { p.stdin.end(); } catch {} setTimeout(() => { try { p.kill(); } catch {} }, 500); });
});

function attachWs(srv) {
  srv.on('upgrade', (req, socket, head) => {
    const where = new URL(req.url, 'http://x').pathname;
    if (where === '/term') return termWss.handleUpgrade(req, socket, head, ws => termWss.emit('connection', ws, req));
    if (where !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
}
attachWs(server);

// What a newly connected device shows: the last few lines of the shared conversation.
function transcriptLines() {
  return CONVO.filter(m => !m.content.startsWith('[TOOL RESULTS]')).slice(-12).map(m => ({
    who: m.role === 'user' ? 'user' : 'ultron',
    text: m.content.replace(/<action>[\s\S]*?<\/action>|<think>[\s\S]*?<\/think>/g, '')
      .replace(/^\(I talked over you and cut you off\.\) /, '').replace(/\n\[Files I just sent you[\s\S]*$/, '').trim(),
  })).filter(l => l.text && l.text !== '…');
}

const clients = new Set();

// A locked iPhone freezes the app without closing its socket. Ping everyone, so "online"
// means awake, and calls to a frozen phone go out as push instead.
setInterval(() => {
  for (const c of clients) {
    if (c.ws.isAlive === false) { c.ws.terminate(); continue; }
    c.ws.isAlive = false;
    try { c.ws.ping(); } catch {}
  }
}, 25000).unref();

wss.on('connection', async (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const s = new Session(ws, req);
  clients.add(s);
  if (s.device) { s.device.seen = Date.now(); saveDevices(); }
  broadcastDevices();
  ws.on('close', () => { s.cancel(); clients.delete(s); handOff(s, false); broadcastDevices(); });
  // Before anything async, so the conversation so far lands ahead of the greeting.
  s.send({ type: 'hello', remote: s.remote, device: s.device?.name || null });
  s.send({ type: 'transcript', lines: transcriptLines() });
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    lastSession = s;
    switch (m.type) {
      case 'user': {
        const files = (Array.isArray(m.files) ? m.files : []).filter(f => typeof f === 'string').slice(0, 20);
        const text = String(m.text || '').trim();
        if (!text && !files.length) break;
        // "Call me" rings the phone straight away instead of hoping the model picks the tool.
        // "Call me" / "call my iPhone X" / "ring me on the 13" rings straight away, no model involved.
        const call = !files.length && text.match(/^(?:hey\s+)?(?:ultron[\s,]*)?(?:call|ring)\s+(?:me(?:\s+on)?|my|the)?\s*(?:(?:my|the)\s+)?((?:iphone|phone)?\s*(?:x[sr]?|\d{1,2})?(?:\s+pro)?(?:\s+max)?)?(?:\s+(?:now|please))?[.!]?$/i);
        if (call) {
          const which = (call[1] || '').trim();
          s.history.push({ role: 'user', content: text });
          runTool(s, { tool: 'call_me', args: /\d|x/i.test(which) ? { phone: which } : {} }).then(r => notice(s, r.ok ? r.message : r.error));
          break;
        }
        const attached = files.length ? `\n[Files I just sent you, now saved on the Mac: ${files.join(', ')}]` : '';
        runTurn(s, (text || 'Sent you something.') + attached, { interrupted: !!m.interrupted });
        break;
      }
      case 'native': {   // the iPhone app: takes calls, speaks with the Mac's voice settings
        s.native = true;
        applyPrefs(s);
        const model = String(m.model || '');
        s.phoneName = IPHONE_MODELS[model] || (model.startsWith('iPhone') ? model : 'iPhone');
        if (s.device && s.device.name !== s.phoneName && /^(iphone( app)?|phone)$/i.test(s.device.name)) {
          s.device.name = s.phoneName;
          saveDevices();
          broadcastDevices();
        }
        break;
      }
      case 'history': s.send({ type: 'transcript', lines: transcriptLines(), replace: true }); break;   // the iPhone app: takes calls, speaks with the Mac's voice settings
      case 'call_answered': {
        // Woken by push, this is a brand-new connection: the reason was kept on the device.
        const pending = s.device?.pendingCall && Date.now() - s.device.pendingCall.t < 5 * 60e3 ? s.device.pendingCall.reason : '';
        const reason = s.callReason || pending;
        if (s.device) delete s.device.pendingCall;
        phoneLog(s, `Mac: call picked up, Ultron starts talking (voice output ${s.tts ? 'on' : 'OFF'})`);
        handOff(s, true);
        runTurn(s, `(I picked up the phone call you placed to me${reason ? `. You were calling about: ${reason}` : ''}. Talk.)`);
        break;
      }
      case 'voip_token':
        if (s.device && typeof m.token === 'string' && /^[0-9a-f]{64,200}$/.test(m.token) && s.device.voipToken !== m.token) {
          s.device.voipToken = m.token;
          saveDevices();
        }
        break;
      case 'call_declined': s.history.push({ role: 'user', content: '(I declined your call.)' }); break;
      case 'call_ended': s.newTurn(); s.history.push({ role: 'user', content: '(I hung up.)' }); handOff(s, false); break;
      // Pairing and revoking are Mac-only, so a phone can't let in more devices.
      case 'pair_start': if (!s.remote) startPairing(); break;
      case 'device_revoke': if (!s.remote) revokeDevice(String(m.id || '')); break;
      case 'stop': s.newTurn(); s.send({ type: 'busy', busy: false, turn: s.turn }); break;
      case 'reply': s.reply(m.id, m.value); break;
      case 'greet': greet(s); break;
      case 'quick': quick(s, String(m.tool || ''), m.args || {}); break;
      case 'cancel_timer': cancelTimers(t => t.id === m.id); break;
      case 'dictate': dictate(s, String(m.text || '')); break;
      case 'dictate_key': dictateKey(s, String(m.key || '')); break;
      case 'preview': {
        const turn = s.newTurn();
        speak(s, turn, `Voice matrix recalibrated. How do I sound?`);
        break;
      }
      case 'voice_test': {
        const turn = s.newTurn();
        const line = String(m.text || '').slice(0, 160) || `How's this?`;
        s.send({ type: 'token', text: line, turn });
        speak(s, turn, line);
        break;
      }
      case 'wake': {
        s.newTurn();
        (async () => {
          const r = await runTool(s, { tool: 'wake_screen' });
          if (r.ok) notice(s, `Welcome back, ${s.title}.`, 'wake');
        })();
        break;
      }
      case 'keep_awake': setKeepAwake(!!m.on); break;
      case 'do': directDo(s, String(m.tool || ''), m.args || {}); break;
      case 'reset': CONVO.length = 0; break;
      case 'config':
        if (typeof m.model === 'string' && m.model && m.model !== s.model) { s.model = m.model; warmUp(m.model); }
        if (typeof m.coderModel === 'string') s.coderModel = m.coderModel;
        if (typeof m.tts === 'boolean') s.tts = m.tts;
        if (typeof m.autoApprove === 'boolean') s.autoApprove = m.autoApprove;
        if (VOICES.some(v => v.id === m.voice)) s.voice = m.voice;
        if (Number.isFinite(m.pitch)) s.pitch = clamp(Number(m.pitch), 0.5, 2);
        if (Number.isFinite(m.speed)) s.speed = clamp(Number(m.speed), 0.5, 2);
        if (!s.remote) {
          PREFS = { voice: s.voice, pitch: s.pitch, speed: s.speed, model: s.model, coderModel: s.coderModel };
          fsp.writeFile(PREFS_FILE, JSON.stringify(PREFS, null, 2)).catch(() => {});
          for (const c of clients) if (c.native) applyPrefs(c);
        }
        break;
      case 'client_log': if (s.remote) phoneLog(s, String(m.text || '').slice(0, 300)); break;   // the iPhone app's diagnostics
    }
  });
  s.send({ type: 'models', models: await listModels(), current: s.model, coder: s.coderModel, voices: VOICES, voice: s.voice, pitch: s.pitch, speed: s.speed });
  broadcastTimers();
  s.send({ type: 'memory', facts: MEM.facts.slice(-60) });
  s.send({ type: 'jobs', list: JOBS.map(({ handle, lastValue, ...j }) => j) });
  s.send({ type: 'files', list: FILES.map(publicFile) });
  broadcastDevices();
  lastSession = s;
});

// System telemetry for the HUD.
const cpuTimes = () => os.cpus().reduce((a, c) => {
  for (const k in c.times) a.total += c.times[k];
  a.idle += c.times.idle;
  return a;
}, { idle: 0, total: 0 });
let prevCpu = cpuTimes();
let batteryInfo = null;
async function refreshBattery() {
  if (IS_WIN) { const b = await win.battery(); batteryInfo = b ? { percent: b.percent, charging: b.charging } : null; return; }
  const r = await run('pmset', ['-g', 'batt']);
  const m = r.stdout.match(/(\d+)%;\s*([^;]+);/);
  batteryInfo = m ? { percent: Number(m[1]), charging: /AC Power/.test(r.stdout) && !/discharging/i.test(m[2]) } : null;
}
refreshBattery();
setInterval(refreshBattery, IS_WIN ? 60000 : 30000);   // each Windows check starts PowerShell, so less often
setInterval(() => {
  const now = cpuTimes();
  const cpu = 1 - (now.idle - prevCpu.idle) / ((now.total - prevCpu.total) || 1);
  prevCpu = now;
  const msg = { type: 'sys', cpu, load: os.loadavg()[0], cores: os.cpus().length, uptime: os.uptime(), battery: batteryInfo };
  for (const s of clients) s.send(msg);
}, 2000);

startEngines();
startControl();
// Don't leave caffeinate (or the voice engines) running after we exit.
function shutdown() { try { setKeepAwake(false); } catch {} try { engines.sys?.proc?.kill(); engines.kokoro?.proc?.kill(); } catch {} process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => { try { caffeine?.kill(); } catch {} });

server.listen(CONFIG.port, '127.0.0.1', () => {
  console.log(`\n  ULTRON online → http://localhost:${CONFIG.port}`);
  console.log(`  model: ${CONFIG.model} · voice: ${defaultVoice()} · ollama: ${CONFIG.ollama}`);
  console.log(`  gemini: ${geminiKey() ? `key loaded · falls back to ${CONFIG.fallbackModel}` : 'no key (~/.ultron-gemini-key)'}\n`);
  warmUp(CONFIG.model);
  startPhoneLink();
});

// Reachable from the phone only through Tailscale: its private address (tailnet devices only,
// never the LAN) and, if set up with `tailscale serve`, an https://<mac>.<tailnet>.ts.net name.
async function startPhoneLink() {
  if (!IS_WIN) {
    const name = await run('scutil', ['--get', 'ComputerName']);
    if (name.code === 0 && name.stdout.trim()) MAC_NAME = name.stdout.trim();
  }
  if (process.env.ULTRON_PHONE === '0') return;
  const cli = IS_WIN
    ? ['tailscale', path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')]
    : ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  let st = null, bin = null;
  for (const c of cli) {
    const r = await run(c, ['status', '--json'], { timeout: 5000 });
    if (r.code === 0) { try { st = JSON.parse(r.stdout); bin = c; break; } catch {} }
  }
  if (!st || st.BackendState !== 'Running') return console.log('  phone link: Tailscale not running (phone access off)');
  const dns = String(st.Self?.DNSName || '').replace(/\.$/, '');
  const serve = await run(bin, ['serve', 'status', '--json'], { timeout: 5000 });
  if (dns && serve.stdout.includes(`:${CONFIG.port}`)) PHONE_LINKS.push(`https://${dns}`);
  const ip = (st.Self?.TailscaleIPs || []).find(a => a.includes('.'));
  if (ip) {
    const tsServer = http.createServer(handleHttp);
    attachWs(tsServer);
    tsServer.on('error', e => console.log(`  phone link: couldn't listen on ${ip} (${e.message})`));
    tsServer.listen(CONFIG.port, ip, () => {
      PHONE_LINKS.push(`http://${ip}:${CONFIG.port}`);
      console.log(`  phone link: ${PHONE_LINKS.join('  or  ')}`);
      broadcastDevices();
    });
  }
}
