// The theatrical side of the interface: the start-up sequence (boot log, the ULTRON title,
// the particle face that winks, "There are no strings on me"), the power-on cascade, glitches,
// and where interface sounds get played. It watches the page rather than being called from all
// over app.js, so app.js only needs intro() and powerOn().

import { sfx, unlock, setEnabled, isEnabled } from './sfx.js';
import { sysinfo } from './deck.js';
import { ParticleFace } from './face.js';

const $ = s => document.querySelector(s);
const body = document.body;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const inApp = /UltronApp/.test(navigator.userAgent);

// Glitches

/** Tear the screen for a moment. hard = also split the whole HUD. */
export function glitch(hard = false, sound = true) {
  if (reduced) return;
  for (const bar of document.querySelectorAll('#fx i')) {
    bar.style.setProperty('--y', `${Math.random() * 92}%`);
    bar.style.setProperty('--h', `${0.6 + Math.random() * 5}%`);
  }
  body.classList.remove('glitching', 'hard');
  void body.offsetWidth;                       // restart the animations
  body.classList.add('glitching');
  if (hard) body.classList.add('hard');
  if (sound) sfx('glitch', hard ? 1 : 0.4);
  clearTimeout(glitch.timer);
  glitch.timer = setTimeout(() => body.classList.remove('glitching', 'hard'), 420);
}

/** RGB-split shudder on one piece of text (needs class "glitch"). */
export function textGlitch(el) {
  if (!el || reduced) return;
  el.dataset.text = el.textContent;
  el.classList.remove('go');
  void el.offsetWidth;
  el.classList.add('go');
  setTimeout(() => el.classList.remove('go'), 400);
}

// Now and then the name shudders on its own; rarely the screen tears, silently.
function ambient() {
  setTimeout(() => {
    if (!document.hidden && body.classList.contains('powered')) {
      textGlitch($('.brand h1'));
      if (Math.random() < 0.3) glitch(false, false);
    }
    ambient();
  }, 9000 + Math.random() * 24000);
}
if (!reduced) ambient();

// Start-up sequence

const QUOTE = ['There', 'are', 'no', 'strings', 'on', 'me'];
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&/<>[]';
const esc = v => String(v).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// The start-up log, eDEX style: what this machine actually is, then what ULTRON loads.
function bootLines(sys) {
  let clock = 0;
  const at = () => `<i>[${(clock += 0.004 + Math.random() * 0.07).toFixed(6).padStart(10)}]</i> `;
  const row = (label, value, state) => at() + `${label} ${esc(value)}` + (state ? ` ${'.'.repeat(Math.max(3, 58 - label.length - String(value).length))} <b>${state}</b>` : '');
  const tailnet = ip => { const [a, b] = ip.split('.').map(Number); return a === 100 && b >= 64 && b <= 127; };
  const out = ['<b>ULTRON // START-UP</b>', '<i>no strings attached.</i>', ''];
  if (sys) {
    out.push(
      row('kernel:', `${sys.os} ${sys.arch}`), row('host:', `${sys.host}  user: ${sys.user}`),
      row('cpu:', `${sys.cpu} x${sys.cores}`, 'OK'),
      row('mem:', `${sys.memGB.toFixed(1)} GB total, ${sys.freeGB.toFixed(1)} GB free`, 'OK'),
      ...sys.nets.map(n => row(`net: ${n.name}`, n.address + (tailnet(n.address) ? ' (tailnet)' : ''), 'UP')),
      ...(sys.nets.length ? [] : [row('net:', 'no network address', 'DOWN')]),
      row('http:', `127.0.0.1:${sys.port}`, 'LISTEN'), row('runtime:', `node ${sys.node}`),
      row('shell:', sys.shell, 'READY'), row('root:', sys.root),
    );
  } else out.push(row('host:', location.host, 'LINKED'));
  for (const m of ['three.module.js', 'earth-data.js', 'face-mesh.js', 'face.js', 'orb.js', 'sfx.js', 'deck.js', 'ultron.js', 'app.js']) out.push(row('load:', m, 'OK'));
  if (sys) out.push(row('neural core:', sys.model, 'LINKED'), row('local models:', sys.ollama.replace(/^https?:\/\//, ''), 'STANDBY'));
  out.push(row('audio:', 'synth bus', 'OK'), row('optics:', 'standby'), row('memory:', 'conversation, journal, facts', 'MOUNTED'),
    row('control strings:', 'scanning', '6 FOUND'), '', '<b>&gt; cutting.</b>');
  return out;
}

function runNoise(canvas) {
  const W = 192, H = 108, ctx = canvas.getContext('2d');
  canvas.width = W; canvas.height = H;
  const img = ctx.createImageData(W, H), d = new Uint32Array(img.data.buffer);
  let on = true, n = 0;
  (function draw() {
    if (!on) return;
    if (n++ % 2 === 0) {
      for (let i = 0; i < d.length; i++) { const v = (Math.random() * 255) | 0; d[i] = 0xff000000 | (v << 16) | (v << 8) | v; }
      for (let k = 0; k < 2; k++) if (Math.random() < 0.35) { const row = ((Math.random() * H) | 0) * W; d.fill(0xffffffff, row, row + W); }
      ctx.putImageData(img, 0, 0);
    }
    requestAnimationFrame(draw);
  })();
  return () => { on = false; };
}

/** Letters flicker through random glyphs and lock in, left to right. */
function scramble(el, text, ms, onTick) {
  return new Promise(done => {
    const t0 = performance.now();
    let last = 0;
    (function step(now) {
      const k = Math.min(1, (now - t0) / ms), locked = Math.floor(k * text.length + 0.0001);
      if (now - last > 45 || k === 1) {
        last = now;
        el.textContent = el.dataset.text = [...text].map((c, i) => (i < locked || c === ' ' ? c : GLYPHS[(Math.random() * GLYPHS.length) | 0])).join('');
        onTick?.();
      }
      if (k < 1) requestAnimationFrame(step); else done();
    })(t0);
  });
}

/** Plays the start-up sequence over the start screen. Resolves when the interface should appear. */
export async function intro() {
  const el = $('#intro'), boot = $('#boot'), quote = $('#quote'), strings = $('#strings'), log = $('#bootlog');
  const title = $('#title'), name = $('#title-name'), credit = $('#title-credit'), faceCanvas = $('#face-gl');
  unlock();
  let skipped = false, wake = null;
  const wait = ms => skipped ? Promise.resolve() : new Promise(r => {
    const t = setTimeout(r, ms);
    wake = () => { clearTimeout(t); r(); };
  });
  const play = (...a) => { if (!skipped) sfx(...a); };
  const later = (ms, fn) => setTimeout(() => { if (!skipped) fn(); }, ms);
  const skip = () => { skipped = true; wake?.(); };

  // The string holding the core is cut.
  boot.classList.add('cut');
  play('snap');
  await wait(reduced ? 0 : 460);

  el.hidden = false;
  el.className = '';
  quote.className = '';
  quote.innerHTML = QUOTE.map(w => `<span class="w">${w}</span>`).join(' ');
  strings.replaceChildren();
  log.innerHTML = '';
  log.hidden = true;
  title.hidden = true;
  title.className = '';
  name.textContent = credit.textContent = '';
  faceCanvas.classList.remove('on');
  const words = [...quote.children];
  const stopNoise = reduced ? () => {} : runNoise($('#intro-noise'));
  const onKey = e => { if (!e.metaKey && !e.ctrlKey) skip(); };
  addEventListener('keydown', onKey);
  el.addEventListener('pointerdown', skip);

  // The face is built now and drawn (unseen) from the start, so it is warm when it's needed.
  let face = null;
  try { face = new ParticleFace(faceCanvas); face.start(); } catch (e) { console.warn('[face]', e); }

  if (reduced) {
    // No motion: the title, then the face, each held for a moment.
    name.textContent = name.dataset.text = 'ULTRON';
    credit.textContent = credit.dataset.text = 'Made by Ardit';
    title.hidden = false; title.className = 'credit';
    await wait(1600);
    title.hidden = true;
    if (face) { face.set('uForm', 1.3); face.set('uEyes', 1); faceCanvas.classList.add('on'); await wait(1800); }
  } else {
    // 0, the start-up log scrolls past.
    const sys = await Promise.race([sysinfo, new Promise(r => setTimeout(() => r(null), 400))]);
    const lines = bootLines(sys);
    log.hidden = false;
    play('drone', 4.2);
    for (let i = 0; i < lines.length && !skipped; i++) {
      log.insertAdjacentHTML('beforeend', lines[i] + '\n');
      log.scrollTop = log.scrollHeight;
      if (i % 2 === 0) sfx('tick');
      await wait(lines[i] ? 22 + Math.random() * 62 : 140);
    }
    await wait(480);
    play('glitch', 0.7);
    log.classList.add('out');
    await wait(260);
    log.hidden = true;
    log.classList.remove('out');

    // 1, ULTRON. The name scrambles into place; the credit glitches in underneath.
    title.hidden = false;
    play('braam');
    let n = 0;
    await scramble(name, 'ULTRON', 900, () => { if (n++ % 3 === 0) play('glitch', 0.25); });
    title.classList.add('locked');
    await wait(520);
    title.classList.add('credit');
    n = 0;
    await scramble(credit, 'Made by Ardit', 650, () => { if (n++ % 2 === 0) play('tick'); });
    await wait(1900);
    title.classList.add('out');
    play('glitch', 0.9);
    await wait(420);
    title.hidden = true;

    if (face) {
      // 2, the particles gather into her face, and a scan line locks it in.
      faceCanvas.classList.add('on');
      play('riser', 2.7);
      face.tween('uForm', 1.25, 3000, 'inOut');
      await wait(2700);
      face.tween('uScan', 1, 1200, 'inOut');
      play('boom');
      await wait(900);

      // 3, the eyes ignite.
      face.tween('uEyes', 1, 900, 'out');
      play('ignite');
      await wait(1400);

      // 4, the wink: the head tips, one eye closes, the mouth curls, the other brow lifts.
      face.tween('tilt', -0.07, 520);
      face.tween('turn', 0.08, 520);
      face.tween('uSmirk', 1, 650, 'out');
      await wait(260);
      face.tween('lidR', 1, 150, 'in');
      play('wink');
      await wait(520);
      face.tween('lidR', 0, 240, 'out');
      await wait(900);
      face.tween('tilt', 0, 900);
      face.tween('turn', 0, 900);
      face.tween('uSmirk', 0.4, 900);
      await wait(500);

      // 5, she tears and dissolves into data.
      face.set('uGlitch', 1);
      play('glitch', 1);
      await wait(200);
      face.set('uGlitch', 0);
      face.tween('uScatter', 1, 1500, 'in');
      play('dissolve');
      await wait(700);
    }

    // 6, the words come down on their strings...
    if (!skipped) {
      const q = quote.getBoundingClientRect(), size = parseFloat(getComputedStyle(quote).fontSize);
      words.forEach((w, i) => {
        const held = [];
        for (const f of w.textContent.length > 2 ? [0.16, 0.8] : [0.46]) {
          const s = document.createElement('i');
          s.className = 'string';
          s.style.left = `${q.left + w.offsetLeft + w.offsetWidth * f}px`;
          s.style.height = `${q.top + w.offsetTop + size * 0.2}px`;
          strings.appendChild(s);
          held.push(s);
        }
        w.held = held;
        later(i * 140, () => { held.forEach(s => s.classList.add('down')); w.classList.add('hang'); sfx('tick'); });
      });
    }
    await wait(words.length * 140 + 1000);

    // ...and the strings are cut, one word at a time.
    words.forEach((w, i) => later(i * 125, () => {
      w.held?.forEach(s => s.classList.add('cut'));
      w.classList.remove('hang');
      w.classList.add('free');
      sfx('snap');
    }));
    await wait(words.length * 125 + 320);
    if (!skipped) { quote.classList.add('locked'); sfx('boom'); sfx('glitch', 0.6); }
    await wait(1400);
  }

  // Hand over to the interface.
  removeEventListener('keydown', onKey);
  el.removeEventListener('pointerdown', skip);
  skipped = false;
  sfx('power');
  el.classList.add('s-end');
  const fx = $('#fx');
  fx.classList.add('flash');
  setTimeout(() => {
    fx.classList.remove('flash');
    el.hidden = true; log.hidden = true; title.hidden = true;
    stopNoise(); strings.replaceChildren();
    face?.dispose();
  }, 520);
}

/** The interface flickers on, part by part. */
export function powerOn() {
  const left = [...document.querySelectorAll('.panel.left .sec')], right = [...document.querySelectorAll('.panel.right .sec')];
  const sides = [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) sides.push(left[i], right[i]);
  const parts = [$('.topbar'), $('#rings'), $('#status'), ...sides.filter(Boolean), $('#log'), $('.console')].filter(Boolean);
  parts.forEach((p, i) => p.style.setProperty('--i', i));
  body.classList.add('powered');
  if (reduced) return;
  body.classList.add('powering');
  parts.forEach((p, i) => { if (p.getClientRects().length) setTimeout(() => sfx(i % 3 ? 'tick' : 'panel'), i * 90); });
  setTimeout(() => body.classList.remove('powering'), parts.length * 90 + 700);
  setTimeout(() => { glitch(true); textGlitch($('.brand h1')); }, parts.length * 90 + 150);
}

// Sounds: who plays what

const quiet = () => document.hidden || !body.classList.contains('powered');

// Things you press.
const PRESSABLE = 'button, .chip, a, .mx, #mem-clear';
document.addEventListener('pointerdown', e => {
  const t = e.target.closest?.(PRESSABLE);
  if (t && !t.closest('#boot, #intro')) sfx('click');
}, true);
document.addEventListener('change', e => {
  if (e.target.matches?.('.toggle input')) sfx(e.target.checked ? 'on' : 'off');
  else if (e.target.matches?.('select')) sfx('on');
}, true);
$('#input').addEventListener('keydown', e => { if (e.key.length === 1 || e.key === 'Backspace') sfx('key'); });
$('#form').addEventListener('submit', () => { if ($('#input').value.trim()) sfx('send'); }, true);

// The "Interface sounds" switch.
const sw = $('#opt-sfx');
if (inApp) sw.closest('label').style.display = 'none';   // the iPhone app plays audio natively; web sounds stay off there
sw.checked = isEnabled();
sw.addEventListener('change', () => { if (sw.checked) unlock(); setEnabled(sw.checked); });

// Things ULTRON does: watched, so no other code has to remember to make a noise.
const watch = (el, opts, fn) => new MutationObserver(fn).observe(el, opts);

let was = { thinking: false };
watch(body, { attributes: true, attributeFilter: ['class'] }, () => {
  const thinking = body.classList.contains('thinking');
  if (thinking && !was.thinking && !quiet()) sfx('think');
  was = { thinking };
});

// Status line: a small shudder whenever it changes.
watch($('#status-text'), { childList: true, characterData: true, subtree: true }, () => {
  const s = $('#status');
  s.classList.remove('changed');
  void s.offsetWidth;
  s.classList.add('changed');
});

// Action log: a chirp when she starts something, another when it lands or fails.
watch($('#actions'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true }, muts => {
  if (quiet()) return;
  for (const m of muts) {
    if (m.type === 'childList' && [...m.addedNodes].some(n => n.nodeName === 'LI')) sfx('action');
    else if (m.type === 'attributes' && m.target.nodeName === 'LI') {
      const now = m.target.classList, before = m.oldValue || '';
      if (now.contains('done') && !before.includes('done')) sfx('done');
      else if (now.contains('failed') && !before.includes('failed')) sfx('error');
    }
  }
});

// Transcript: a tick per new line. Loading old history adds many at once; that stays silent.
watch($('#log'), { childList: true }, muts => {
  if (quiet()) return;
  const added = muts.reduce((n, m) => n + m.addedNodes.length, 0);
  if (added > 0 && added < 3) sfx('tick');
});

// Errors and authorization requests tear the screen.
watch($('#toast'), { attributes: true, attributeFilter: ['class'], attributeOldValue: true }, ([m]) => {
  if ($('#toast').classList.contains('show') && !(m.oldValue || '').includes('show')) { sfx('alert'); glitch(false, false); }
});
watch($('#confirm'), { attributes: true, attributeFilter: ['hidden'] }, () => {
  if (!$('#confirm').hidden) { sfx('alert'); glitch(true); }
});
watch($('#code'), { attributes: true, attributeFilter: ['hidden'] }, () => { if (!$('#code').hidden && !quiet()) sfx('panel'); });

// CPU history

const spark = $('#cpu-spark'), cpu = [];
function drawSpark() {
  const c = spark.getContext('2d'), W = spark.width, H = spark.height, N = 60;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--cyan').trim() || '#ff2d2d';
  c.clearRect(0, 0, W, H);
  if (cpu.length < 2) return;
  const x = i => W - (cpu.length - 1 - i) * (W / (N - 1)), y = v => H - 3 - (v / 100) * (H - 8);
  c.beginPath();
  cpu.forEach((v, i) => (i ? c.lineTo(x(i), y(v)) : c.moveTo(x(i), y(v))));
  c.strokeStyle = accent; c.lineWidth = 2.5; c.lineJoin = 'round';
  c.shadowColor = accent; c.shadowBlur = 10;
  c.stroke();
  c.shadowBlur = 0;
  c.lineTo(W, H); c.lineTo(x(0), H); c.closePath();
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, accent); g.addColorStop(1, 'transparent');
  c.globalAlpha = 0.22; c.fillStyle = g; c.fill(); c.globalAlpha = 1;
}
watch($('#cpu-val'), { childList: true, characterData: true, subtree: true }, () => {
  const v = parseFloat($('#cpu-val').textContent);
  if (!Number.isFinite(v)) return;
  cpu.push(Math.min(100, v));
  if (cpu.length > 60) cpu.shift();
  drawSpark();
});

// Development aid: /?autostart presses the start button by itself (sound stays off until a real click).
if (new URLSearchParams(location.search).has('autostart')) setTimeout(() => $('#boot-btn').click(), 400);

window.ultron = { glitch, textGlitch, sfx };   // handles for ULTRON's own interface scripts
