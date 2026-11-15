// The working side of the interface: a real terminal, a file browser that follows it,
// the network readout, and the switch between the Ultron view (globe + conversation)
// and the Terminal view (shell + files, with the globe parked in the Network module).

import { sfx } from './sfx.js';

const $ = s => document.querySelector(s);
const body = document.body;
const isRemote = !['localhost', '127.0.0.1'].includes(location.hostname);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Quote a path for the shell: zsh on the Mac, PowerShell on Windows (where '' escapes a quote).
const isWinPath = p => /^[a-z]:\\/i.test(p || '');
const shq = p => isWinPath(p) ? `'${p.replace(/'/g, "''")}'` : `'${p.replace(/'/g, `'\\''`)}'`;

/** Machine details for the start-up log and the Network module (null if they can't be read). */
export const sysinfo = fetch('/api/sysinfo').then(r => (r.ok ? r.json() : null)).catch(() => null);

// Network module

const tailnet = ip => { const [a, b] = ip.split('.').map(Number); return a === 100 && b >= 64 && b <= 127; };
sysinfo.then(s => {
  if (!s) return;
  $('#net-host').textContent = s.host;
  $('#net-ips').innerHTML = s.nets.map(n =>
    `<div class="kv"><span>${esc(n.name)}${tailnet(n.address) ? ' · tailnet' : ''}</span><b>${esc(n.address)}</b></div>`).join('')
    || '<div class="kv"><span>No network</span><b>offline</b></div>';
});

// Terminal

let term = null, fit = null, sock = null, cwd = '';
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function send(o) { if (sock?.readyState === 1) sock.send(JSON.stringify(o)); }

function connect() {
  sock = new WebSocket(`ws://${location.host}/term`);
  sock.binaryType = 'arraybuffer';
  sock.onopen = () => { send({ t: 'r', rows: term.rows, cols: term.cols }); term.focus(); };
  sock.onmessage = e => {
    if (typeof e.data !== 'string') return term.write(new Uint8Array(e.data));
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.cwd) { cwd = m.cwd; $('#term-cwd').textContent = pretty(cwd); browse(cwd, false); }
    if (m.error) term.writeln(`\r\n\x1b[31m${m.error}\x1b[0m`);
  };
  sock.onclose = () => { sock = null; term.writeln('\r\n\x1b[2m[shell closed · press Enter to open a new one]\x1b[0m'); };
}

function openTerminal() {
  if (term || !window.Terminal) return;
  term = new window.Terminal({
    fontFamily: `'JetBrains Mono', ui-monospace, Menlo, monospace`, fontSize: 13, lineHeight: 1.25, cursorBlink: true,
    allowTransparency: true, scrollback: 5000, macOptionIsMeta: true,
    theme: {
      background: 'rgba(0,0,0,0)', foreground: '#dfe5ea', cursor: css('--cyan') || '#ff2d2d', cursorAccent: '#040506',
      selectionBackground: 'rgba(255,45,45,0.35)',
      black: '#0b0d10', red: '#ff4d4d', green: '#7fe0a8', yellow: '#ffb347', blue: '#7fb2ff', magenta: '#ff7ab8', cyan: '#5ef2ff', white: '#c9d2db',
      brightBlack: '#5d6975', brightRed: '#ff7a6b', brightGreen: '#a5f0c5', brightYellow: '#ffd08a', brightBlue: '#a8caff', brightMagenta: '#ffa3cf', brightCyan: '#9ff7ff', brightWhite: '#ffffff',
    },
  });
  fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('#term'));
  fit.fit();
  term.onData(d => {
    if (!sock) { if (d === '\r') { term.reset(); connect(); } return; }
    send({ t: 'i', d });
  });
  term.onKey(() => sfx('key'));
  term.onResize(({ rows, cols }) => send({ t: 'r', rows, cols }));
  new ResizeObserver(() => { if (body.classList.contains('term')) try { fit.fit(); } catch {} }).observe($('#term'));
  connect();
}

/** Type text into the shell (used by the file browser). */
function typeInShell(text) {
  if (!sock) return false;
  send({ t: 'i', d: text });
  term.focus();
  return true;
}

// File browser

const KIND = {
  code: 'js mjs cjs ts tsx jsx py rb go rs c h cpp hpp cs java kt swift php sh zsh bash html css scss json yml yaml toml xml sql md ipynb vue svelte lua',
  image: 'png jpg jpeg gif webp svg heic ico bmp tiff psd',
  music: 'mp3 wav m4a flac aac ogg aiff',
  film: 'mp4 mov mkv avi webm m4v',
  archive: 'zip tar gz tgz bz2 xz 7z rar dmg pkg iso',
};
const EXT = new Map(Object.entries(KIND).flatMap(([kind, list]) => list.split(' ').map(x => [x, kind])));
function iconFor(e) {
  if (e.dir) return e.name.endsWith('.app') ? 'app' : 'folder';
  return EXT.get(e.name.split('.').pop().toLowerCase()) || 'file';
}
let home = '', here = '', parent = '';
const sepOf = p => (isWinPath(p) ? '\\' : '/');
const pretty = p => (home && (p === home || p.startsWith(home + sepOf(home))) ? '~' + p.slice(home.length) : p);

async function browse(dir, click = true) {
  if (isRemote) return;
  let r;
  try { r = await (await fetch('/api/fs' + (dir ? `?path=${encodeURIComponent(dir)}` : ''))).json(); } catch { return; }
  home = r.home; here = r.path; parent = r.parent;
  $('#fs-path').textContent = pretty(here);
  const grid = $('#fs-grid');
  if (!r.ok) { grid.innerHTML = `<p class="fs-note">${esc(r.error)}</p>`; return; }
  grid.innerHTML = r.entries.map((e, i) => {
    const icon = iconFor(e);
    return `<button class="fs-item${e.dir ? ' dir' : ''} k-${icon}" data-i="${i}" title="${esc(e.name)}"><svg class="ico"><use href="#i-${icon}"/></svg><span>${esc(e.name)}</span></button>`;
  }).join('') || '<p class="fs-note">This folder is empty</p>';
  grid.scrollTop = 0;
  grid.onclick = ev => {
    const b = ev.target.closest('.fs-item');
    if (!b) return;
    const e = r.entries[b.dataset.i], full = here.endsWith(sepOf(here)) ? here + e.name : here + sepOf(here) + e.name;
    // Like eDEX: a folder takes the shell there (the browser then follows the shell); a file drops its path at the cursor.
    if (e.dir && !e.name.endsWith('.app')) { if (!typeInShell(` cd ${shq(full)}\r`)) browse(full); }
    else typeInShell(shq(full) + ' ');
  };
  if (click) sfx('tick');
}
$('#fs-up').onclick = () => { if (!typeInShell(` cd ${shq(parent)}\r`)) browse(parent); };
$('#fs-home').onclick = () => { if (!typeInShell(' cd ~\r')) browse(home); };

// Ultron view / Terminal view

const canDeck = () => !isRemote && innerWidth > 860;
function setMode(mode, quiet = false) {
  const on = mode === 'term' && canDeck();
  body.classList.toggle('term', on);
  $('#mode-term').setAttribute('aria-pressed', on);
  $('#mode-chat').setAttribute('aria-pressed', !on);
  try { localStorage.setItem('fri.view', on ? 'term' : 'ultron'); } catch {}
  if (on) {
    openTerminal();
    if (!here) browse('');
    requestAnimationFrame(() => { try { fit?.fit(); } catch {} term?.focus(); });
  } else if (document.activeElement?.closest?.('#deck')) $('#input').focus();
  if (!quiet) sfx('panel');
}
$('#mode-term').onclick = () => setMode('term');
$('#mode-chat').onclick = () => setMode('ultron');
addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === '`') { e.preventDefault(); setMode(body.classList.contains('term') ? 'ultron' : 'term'); }
}, true);
addEventListener('resize', () => { if (body.classList.contains('term') && !canDeck()) setMode('ultron', true); });
if (isRemote) body.classList.add('no-deck');

// In Terminal view the globe parks in the Network module: tell the globe where that is, every frame.
(function track() {
  const orb = window.ultron?.orb;
  if (orb) {
    if (body.classList.contains('term')) {
      const r = $('#globe-slot').getBoundingClientRect();
      orb.slot = r.height > 20 ? { x: r.left + r.width / 2, y: r.top + (r.height - 26) / 2, r: Math.min(r.width, r.height - 26) / 2 / 1.6 } : null;
    } else orb.slot = null;
  }
  requestAnimationFrame(track);
})();

/** Called once the interface has powered on: reopen the view you were in last time. */
export function restoreView() {
  let last = 'ultron';
  try { last = localStorage.getItem('fri.view') || 'ultron'; } catch {}
  if (last === 'term') setMode('term', true);
}

window.deck = { setMode, browse };
