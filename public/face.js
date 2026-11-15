// The start-up face: a woman's face assembled from particles.
// Built on MediaPipe's canonical face mesh (468 real landmarks, face-mesh.js), reshaped a little
// (softer jaw, fuller lips, arched brows), then drawn as points: shaded skin, scan contours,
// feature lines, lashes, winged liner, glowing irises, and blonde hair worn up in a messy bun.
// A shader flies every point in from the dark, lights the eyes, winks, smirks, and scatters them.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FACE_V, FACE_T } from './face-mesh.js';

// Landmark indices (MediaPipe face mesh). "R" is her right: the viewer's left (x < 0).
const LM = {
  eyes: [
    { up: [33, 246, 161, 160, 159, 158, 157, 173, 133], low: [33, 7, 163, 144, 145, 153, 154, 155, 133] },
    { up: [362, 398, 384, 385, 386, 387, 388, 466, 263], low: [362, 382, 381, 380, 374, 373, 390, 249, 263] },
  ],
  brows: [[[46, 53, 52, 65, 55], [70, 63, 105, 66, 107]], [[276, 283, 282, 295, 285], [300, 293, 334, 296, 336]]],
  lipsOuter: [[61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291], [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291]],
  lipsInner: [[78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308], [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308]],
  oval: [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10],
  nose: [[168, 6, 197, 195, 5, 4], [98, 97, 2, 326, 327]],
  mouthCorner: 291,
};
const WINK = 1;              // which eye winks: index into LM.eyes (1 = her left, the viewer's right)
const S = 0.1;               // mesh units (≈ cm) -> scene units

const C = {                  // colours
  skin: [0.8, 0.86, 0.92], line: [0.95, 0.97, 1.0], lips: [1.0, 0.3, 0.36], liner: [1.0, 0.16, 0.16],
  iris: [1.0, 0.13, 0.1], hot: [1.0, 0.72, 0.5], sclera: [0.78, 0.82, 0.9], hair: [1.0, 0.86, 0.64],
};
const KIND = { skin: 0, contour: 1, line: 2, lash: 3, iris: 4, sclera: 5, hair: 6, neck: 7 };

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const V3 = THREE.Vector3;

// Geometry

function shapeFace() {
  const v = [];
  for (let i = 0; i < FACE_V.length; i += 3) v.push(new V3(FACE_V[i], FACE_V[i + 1], FACE_V[i + 2]));
  for (const p of v) {
    p.x *= 1 - 0.08 * smooth(-1.5, -9.5, p.y);                                  // softer, narrower jaw and chin
    const lx = p.x / 3.4, ly = (p.y + 4.3) / 1.6, lw = Math.max(0, 1 - lx * lx - ly * ly);
    if (lw > 0) { p.y += (p.y + 4.27) * 0.14 * lw; p.z += 0.4 * lw; }           // fuller lips
    const bw = Math.exp(-(((Math.abs(p.x) - 4.0) / 1.9) ** 2) - (((p.y - 4.3) / 1.0) ** 2));
    p.y += 0.32 * bw;                                                           // arched brows
    const ew = Math.exp(-(((Math.abs(p.x) - 3.2) / 1.7) ** 2) - (((p.y - 2.65) / 0.7) ** 2));
    p.y += (p.y - 2.65) * 0.12 * ew;                                            // slightly larger eyes
  }
  return v;
}

function inPoly(x, y, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
// y of a lid line at x (piecewise linear through its landmarks).
function lidY(pts, x) {
  const s = [...pts].sort((a, b) => a.x - b.x);
  if (x <= s[0].x) return s[0].y;
  for (let i = 1; i < s.length; i++) if (x <= s[i].x) return s[i - 1].y + ((x - s[i - 1].x) / (s[i].x - s[i - 1].x)) * (s[i].y - s[i - 1].y);
  return s[s.length - 1].y;
}

function build() {
  const rnd = mulberry32(20261114);
  const v = shapeFace();
  const P = i => v[i].clone();

  // Eyes: lid lines, opening polygon, centre, corners.
  const eyes = LM.eyes.map(({ up, low }, k) => {
    const U = up.map(P), L = low.map(P), poly = [...U, ...L.slice(1, -1).reverse()];
    const xs = U.map(p => p.x), xmin = Math.min(...xs), xmax = Math.max(...xs);
    const centre = poly.reduce((a, p) => a.add(p), new V3()).multiplyScalar(1 / poly.length);
    const outer = Math.abs(U[0].x) > Math.abs(U[U.length - 1].x) ? U[0] : U[U.length - 1];
    return { k, U, L, poly, xmin, xmax, centre, outer, side: k === 0 ? -1 : 1, width: xmax - xmin };
  });
  const closedY = (e, x) => { const up = lidY(e.U, x), lo = lidY(e.L, x); return lo + 0.3 * (up - lo); };
  const eyeNear = p => eyes.find(e => p.x > e.xmin - 0.35 && p.x < e.xmax + 0.35 && Math.abs(p.y - e.centre.y) < 1.6);
  const lipsOut = [...LM.lipsOuter[0].map(P), ...LM.lipsOuter[1].slice(1, -1).map(P).reverse()];
  const lipsIn = [...LM.lipsInner[0].map(P), ...LM.lipsInner[1].slice(1, -1).map(P).reverse()];
  const corner = P(LM.mouthCorner);

  // Expression deltas, applied together by uSmirk: the winking side's mouth corner and cheek lift,
  // that brow drops, the other brow arches up.
  const ws = eyes[WINK].side;
  const expr = p => {
    const d = new V3();
    const m = Math.exp(-p.distanceToSquared(corner) / 1.4);
    d.add(new V3(0.2 * ws, 0.55, 0.08).multiplyScalar(m));
    d.y += 0.32 * Math.exp(-(((p.x - 3.6 * ws) / 1.6) ** 2) - (((p.y + 1.2) / 1.3) ** 2));
    d.y -= 0.3 * Math.exp(-(((p.x - 4.0 * ws) / 2.0) ** 2) - (((p.y - 4.5) / 0.9) ** 2));
    d.y += 0.5 * Math.exp(-(((p.x + 4.0 * ws) / 2.0) ** 2) - (((p.y - 4.5) / 0.9) ** 2));
    return d;
  };

  const out = { pos: [], start: [], close: [], expr: [], color: [], data: [], more: [] };
  const push = (p, kind, alpha, size, col, delay, { close = null, side = 0, t = 0 } = {}) => {
    out.pos.push(p.x * S, p.y * S, p.z * S);
    const r = 22 + rnd() * 26, a = rnd() * Math.PI * 2;
    out.start.push(Math.cos(a) * r * S, (rnd() - 0.5) * 40 * S, (-26 + rnd() * 30) * S);
    out.close.push(close ? close.x * S : 0, close ? close.y * S : 0, close ? close.z * S : 0);
    const e = expr(p);
    out.expr.push(e.x * S, e.y * S, e.z * S);
    out.color.push(...col);
    out.data.push(kind, alpha, size, delay);
    out.more.push(side, rnd(), t);
  };
  // How a point on the skin moves when its eye closes.
  const lidMove = p => {
    const e = eyeNear(p);
    if (!e) return {};
    const up = lidY(e.U, p.x), lo = lidY(e.L, p.x), shut = closedY(e, p.x);
    const inside = p.x > e.xmin && p.x < e.xmax;
    if (inside && p.y >= up - 0.02 && p.y < up + 0.95) return { close: new V3(0, (shut - up) * (1 - (p.y - up) / 0.95), 0.06), side: e.side };
    if (inside && p.y <= lo + 0.02 && p.y > lo - 0.45) return { close: new V3(0, (shut - lo) * 0.4 * (1 - (lo - p.y) / 0.45), 0), side: e.side };
    return {};
  };

  // Triangles, with outward normals and areas.
  const light = new V3(-0.5, 0.42, 0.76).normalize(), centre = new V3(0, 0, -3);
  const tris = [];
  let total = 0;
  for (let i = 0; i < FACE_T.length; i += 3) {
    const a = v[FACE_T[i]], b = v[FACE_T[i + 1]], c = v[FACE_T[i + 2]];
    const n = new V3().subVectors(b, a).cross(new V3().subVectors(c, a));
    const area = n.length() / 2;
    n.normalize();
    if (n.dot(new V3().addVectors(a, b).add(c).multiplyScalar(1 / 3).sub(centre)) < 0) n.negate();
    total += area;
    tris.push({ a, b, c, n, cum: total, lit: 0.06 + 0.94 * Math.max(0, n.dot(light)) ** 1.7 });
  }
  const skipped = p => eyes.some(e => inPoly(p.x, p.y, e.poly)) || inPoly(p.x, p.y, lipsIn);
  const lipTint = p => inPoly(p.x, p.y, lipsOut);
  const fadeDelay = p => 0.04 + 0.18 * smooth(9, -10, p.y) + rnd() * 0.16;

  // 1, skin: points scattered over the surface, brighter where the light falls.
  for (let i = 0; i < 24000; i++) {
    const x = rnd() * total;
    let lo = 0, hi = tris.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tris[m].cum < x) lo = m + 1; else hi = m; }
    const t = tris[lo];
    let u = rnd(), w = rnd();
    if (u + w > 1) { u = 1 - u; w = 1 - w; }
    const p = t.a.clone().multiplyScalar(1 - u - w).add(t.b.clone().multiplyScalar(u)).add(t.c.clone().multiplyScalar(w));
    if (skipped(p)) continue;
    const lip = lipTint(p);
    push(p, KIND.skin, lip ? 0.7 : 0.03 + 0.85 * t.lit, lip ? 1.15 : 1, lip ? C.lips : C.skin, fadeDelay(p), lidMove(p));
  }

  // 2, scan contours: the surface cut by horizontal planes, like a depth scan.
  for (let y = -9.3; y < 8.3; y += 0.3) {
    for (const t of tris) {
      const pts = [];
      for (const [p, q] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
        if ((p.y - y) * (q.y - y) < 0) pts.push(p.clone().lerp(q, (y - p.y) / (q.y - p.y)));
      }
      if (pts.length !== 2) continue;
      const len = pts[0].distanceTo(pts[1]), n = Math.max(1, Math.round(len / 0.085));
      for (let k = 0; k < n; k++) {
        const p = pts[0].clone().lerp(pts[1], (k + rnd()) / n);
        if (skipped(p)) continue;
        const lip = lipTint(p);
        push(p, KIND.contour, lip ? 0.55 : 0.05 + 0.5 * t.lit, 0.9, lip ? C.lips : C.skin, fadeDelay(p), lidMove(p));
      }
    }
  }

  // 3, feature lines.
  const line = (ids, { kind = KIND.line, alpha = 0.9, size = 1.15, col = C.line, step = 0.035, delay = 0.36, lid = null, jitter = 0.025 } = {}) => {
    const curve = new THREE.CatmullRomCurve3(ids.map(i => (typeof i === 'number' ? P(i) : i)));
    const n = Math.max(8, Math.round(curve.getLength() / step));
    for (let k = 0; k <= n; k++) {
      const p = curve.getPoint(k / n).add(new V3((rnd() - 0.5) * jitter, (rnd() - 0.5) * jitter, 0));
      push(p, kind, alpha * (0.75 + 0.25 * rnd()), size, col, delay + rnd() * 0.12, lid ? lid(p) : {});
    }
    return curve;
  };
  line(LM.oval, { alpha: 0.16, size: 0.9, step: 0.09, delay: 0.2 });
  line(LM.nose[0], { alpha: 0.22, step: 0.05 });
  for (const ids of [LM.nose[1], [129, 64, 98], [358, 294, 327]]) line(ids, { alpha: 0.4, step: 0.04 });
  for (const ids of [...LM.lipsOuter, ...LM.lipsInner]) line(ids, { col: C.lips, alpha: 0.95, step: 0.03 });
  for (const e of eyes) {
    const upLid = p => ({ close: new V3(0, closedY(e, p.x) - p.y, 0.06), side: e.side });
    const lowLid = p => ({ close: new V3(0, (closedY(e, p.x) - p.y) * 0.5, 0), side: e.side });
    const upper = line(e.U, { alpha: 1, size: 1.25, step: 0.022, delay: 0.44, lid: upLid });
    line(e.L, { alpha: 0.6, size: 1, step: 0.03, delay: 0.44, lid: lowLid });

    // Lashes: longer toward the outer corner, curling up and out.
    const outerAtEnd = Math.abs(e.U[e.U.length - 1].x) > Math.abs(e.U[0].x);
    for (let i = 0; i < 30; i++) {
      const f = (i + rnd() * 0.6) / 30, tOut = 0.12 + 0.88 * f;
      const root = upper.getPoint(outerAtEnd ? tOut : 1 - tOut);
      const len = 0.32 + 0.75 * tOut ** 1.6;
      const dir = new V3(e.side * (0.15 + 0.55 * tOut), 1, 0.65).normalize();
      const rootShut = closedY(e, root.x);
      for (let s = 1; s <= 10; s++) {
        const q = s / 10;
        const p = root.clone().addScaledVector(dir, len * q).add(new V3(e.side * 0.12 * len * q * q, 0.18 * len * q * q, -0.25 * len * q * q));
        // Shut: the lash hangs down from the closed lid.
        const shut = new V3(p.x, rootShut - (p.y - root.y) * 0.55, p.z);
        push(p, KIND.lash, 0.85 * (1 - 0.35 * q), 0.8, C.line, 0.5 + rnd() * 0.1, { close: shut.sub(p), side: e.side });
      }
    }
    // Winged liner: a thin line from the outer corner, flicking up and out.
    const o = e.outer, wing = [o.clone(), o.clone().add(new V3(e.side * 0.7, 0.32, -0.12)), o.clone().add(new V3(e.side * 1.35, 0.78, -0.3))];
    line(wing, { col: C.liner, alpha: 1, size: 1.2, step: 0.02, delay: 0.5, jitter: 0.012, lid: p => ({ close: new V3(0, (closedY(e, o.x) - o.y) * 0.4, 0), side: e.side }) });

    // Iris: hot ring, fibres, pupil edge and a catch-light, clipped by the lids.
    const r = e.width * 0.215, c = e.centre.clone().add(new V3(0, 0.02, -0.12));
    const irisPt = (x, y, alpha, size, col) => {
      const up = lidY(e.U, x), lo = lidY(e.L, x);
      if (y > up - 0.03 || y < lo + 0.03) return;
      push(new V3(x, y, c.z), KIND.iris, alpha, size, col, 0.62 + rnd() * 0.08, { close: new V3(0, closedY(e, x) - y, 0), side: e.side });
    };
    for (let i = 0; i < 160; i++) { const a = rnd() * Math.PI * 2, rr = r * (0.94 + 0.06 * rnd()); irisPt(c.x + Math.cos(a) * rr, c.y + Math.sin(a) * rr, 1, 1.3, C.iris); }
    for (let i = 0; i < 620; i++) {
      const a = rnd() * Math.PI * 2, rr = r * (0.42 + 0.56 * Math.sqrt(rnd()));
      const hot = 1 - (rr / r - 0.42) / 0.56;
      irisPt(c.x + Math.cos(a) * rr, c.y + Math.sin(a) * rr, 0.55 + 0.4 * hot, 1, C.iris.map((ch, j) => ch + (C.hot[j] - ch) * hot * 0.8));
    }
    for (let i = 0; i < 90; i++) { const a = rnd() * Math.PI * 2; irisPt(c.x + Math.cos(a) * r * 0.4, c.y + Math.sin(a) * r * 0.4, 1, 1.1, C.hot); }
    for (let i = 0; i < 14; i++) irisPt(c.x - r * 0.3 + (rnd() - 0.5) * 0.09, c.y + r * 0.32 + (rnd() - 0.5) * 0.09, 1, 1.2, [1, 1, 1]);
    // Faint whites of the eye.
    for (let i = 0; i < 260; i++) {
      const x = e.xmin + rnd() * e.width, up = lidY(e.U, x), lo = lidY(e.L, x), y = lo + rnd() * (up - lo);
      if (Math.hypot(x - c.x, y - c.y) < r * 1.02 || !inPoly(x, y, e.poly)) continue;
      push(new V3(x, y, c.z + 0.06), KIND.sclera, 0.16, 0.8, C.sclera, 0.6, { close: new V3(0, closedY(e, x) - y, 0), side: e.side });
    }
  }
  // Brows: short strokes between the lower and upper brow lines, tapering toward the tail.
  LM.brows.forEach(([low, high], k) => {
      const lc = new THREE.CatmullRomCurve3(low.map(P)), hc = new THREE.CatmullRomCurve3(high.map(P));
      const side = k === 0 ? -1 : 1;
      for (let i = 0; i < 900; i++) {
        const t = rnd(), a = lc.getPoint(t), b = hc.getPoint(t);
        const thin = 0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 1.15));        // tapers at the tail
        const p = a.lerp(b, 0.5 + (rnd() - 0.5) * thin).add(new V3(side * (rnd() - 0.5) * 0.12, 0, 0.08));
        push(p, KIND.line, 0.42 + 0.3 * rnd(), 0.9, C.line, 0.4 + rnd() * 0.12);
      }
  });

  // 4, hair, worn up: strands sweep from the hairline over the scalp into a messy high bun,
  // with loose pieces framing the face and a few flyaways.
  const HC = new V3(0, 1.2, -2.2), HR = new V3(8.5, 10.3, 9.7), D = THREE.MathUtils.degToRad;
  const scalpAt = (a, th, lift) => new V3(
    HC.x + Math.sin(th) * Math.sin(a) * HR.x * lift,
    HC.y + Math.cos(th) * Math.sin(a) * HR.y * lift,
    HC.z + Math.cos(a) * HR.z * lift);
  const hair = (p, a, { t = 0, size = 0.9, col = C.hair } = {}) =>
    push(p.add(new V3((rnd() - 0.5) * 0.02, (rnd() - 0.5) * 0.02, (rnd() - 0.5) * 0.02)), KIND.hair, a, size, col, 0.12 + 0.3 * rnd(), { t });
  const sheenAt = p => Math.max(0, light.dot(p.clone().sub(HC).normalize())) ** 2;
  const bunA = D(104), bunDir = scalpAt(bunA, 0, 1).sub(HC).normalize();
  const bunC = scalpAt(bunA, 0, 1.03).addScaledVector(bunDir, 2.9), BUN_R = 3.2;

  // Pulled back: from the hairline (across the forehead, round the temples and the nape) to the bun.
  const roots = [];
  for (let i = 0; i < 120; i++) roots.push([D(46 + rnd() * 4), D(-95 + (190 * (i + rnd())) / 120)]);
  for (let i = 0; i < 100; i++) roots.push([D(50 + 125 * rnd()), (i % 2 ? 1 : -1) * D(92 + rnd() * 10)]);
  for (const [a0, th0] of roots) {
    const bright = 0.5 + 0.5 * rnd() ** 1.5, wob = (rnd() - 0.5) * 0.08, ph = rnd() * 6.28, N = 80;
    // Each strand tucks in somewhere on the bun's underside, on its own side, not all at one point.
    const from = scalpAt(a0, th0, 1).sub(bunC).normalize();
    const base = bunC.clone().addScaledVector(from.add(new V3(rnd() - 0.5, -0.4, rnd() - 0.5).multiplyScalar(0.6)).normalize(), BUN_R * 0.85);
    for (let i = 0; i <= N; i++) {
      if (rnd() < 0.05) continue;
      const t = i / N, e = t * t * (3 - 2 * t);
      const p = scalpAt(a0 + (bunA - a0) * e, th0 * (1 - e) + wob * Math.sin(t * 9 + ph), 1.025 + 0.03 * e);
      p.lerp(base, smooth(0.78, 1, t));                                              // gathers into the bun
      hair(p, bright * (0.38 + 0.45 * sheenAt(p)) * (0.65 + 0.35 * e));
    }
  }

  // The bun: loops wound round a centre, looser toward the outside.
  for (let i = 0; i < 130; i++) {
    const axis = new V3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
    const u = new V3().crossVectors(axis, Math.abs(axis.y) < 0.9 ? new V3(0, 1, 0) : new V3(1, 0, 0)).normalize();
    const v = new V3().crossVectors(axis, u);
    const r = BUN_R * (0.45 + 0.6 * rnd() ** 0.7), span = D(160 + 300 * rnd()), f0 = rnd() * 6.28, ph = rnd() * 6.28, bright = 0.45 + 0.5 * rnd();
    for (let f = 0; f < span; f += 0.05 / (r / 2)) {
      const k = r * (1 + 0.14 * Math.sin(3 * f + ph) + 0.06 * Math.sin(7 * f + ph * 2));
      const p = bunC.clone().addScaledVector(u, Math.cos(f0 + f) * k).addScaledVector(v, Math.sin(f0 + f) * k);
      p.y = bunC.y + (p.y - bunC.y) * 0.82;
      hair(p, bright * (0.35 + 0.45 * sheenAt(p)) * (0.7 + 0.3 * Math.sin(f / span * Math.PI)));
    }
  }
  // Flyaways off the bun.
  for (let i = 0; i < 26; i++) {
    const dir = new V3(rnd() - 0.5, 0.2 + rnd() * 0.8, rnd() - 0.7).normalize(), len = 2 + rnd() * 3.5, bend = (rnd() - 0.5) * 2;
    const start = bunC.clone().addScaledVector(dir, BUN_R * 0.95);
    for (let s = 0; s <= 50; s++) {
      const t = s / 50;
      const p = start.clone().addScaledVector(dir, len * t).add(new V3(bend * t * t, -1.2 * t * t, 0));
      hair(p, 0.4 * (1 - t), { t, size: 0.8 });
    }
  }

  // Loose pieces framing the face: from the front hairline down past the cheeks, to below the jaw.
  const surfaceZ = (x, y) => {
    let z = -Infinity;
    for (const q of v) if (Math.abs(q.x - x) < 1.1 && Math.abs(q.y - y) < 1.1 && q.z > z) z = q.z;
    return z;
  };
  for (const side of [-1, 1]) {
    for (let k = 0; k < 12; k++) {
      const ph = rnd() * 6.28, x0 = 2.6 + rnd() * 1.6, out = 6.4 + rnd() * 1.2, end = -7 - rnd() * 6, bright = 0.7 + 0.3 * rnd();
      let z = 4;
      for (let s = 0; s <= 280; s++) {
        const t = s / 280, y = 7.8 + (end - 7.8) * t;
        const x = side * (x0 + (out - x0) * smooth(7.8, 3, y) - 1.0 * smooth(-3, -10, y) + Math.sin(t * 6 + ph) * 0.4 * t);
        const sz = surfaceZ(x, y);
        if (sz > -Infinity) z = sz + 0.55; else z -= 0.02;
        hair(new V3(x, y, z), bright * (1 - 0.6 * t), { t, size: 1 });
      }
    }
  }

  // 5, neck: rings around the front of a tapering column, fading out downward.
  for (let y = -6.5; y > -17; y -= 0.42) {
    const fade = smooth(-17, -8, y), rx = 4.1 - 0.15 * (y + 6.5) / -10, rz = 3.3;
    for (let a = -1.35; a <= 1.35; a += 0.045) {
      if (rnd() < 0.3) continue;
      const p = new V3(Math.sin(a) * rx, y + (rnd() - 0.5) * 0.08, -1.7 + Math.cos(a) * rz);
      push(p, KIND.neck, 0.22 * fade * (0.4 + 0.6 * Math.cos(a)), 0.8, C.skin, 0.1 + rnd() * 0.2);
    }
  }

  return { out, eyes, occluder: { v, HC, HR } };
}

// Shaders

const VERT = /* glsl */ `
uniform float uTime, uForm, uScatter, uGlitch, uEyes, uScan, uScale, uSmirk;
uniform vec2 uLid;
attribute vec3 aStart, aClose, aExpr, aColor, aMore;
attribute vec4 aData;            // kind, alpha, size, delay
varying vec3 vCol;
varying float vA;
float hash(float n){ return fract(sin(n) * 43758.5453); }
void main(){
  float kind = aData.x, seed = aMore.y;
  vec3 p = position;
  float lid = aMore.x < -.5 ? uLid.x : (aMore.x > .5 ? uLid.y : 0.);
  p += aClose * lid + aExpr * uSmirk;
  if (kind > 5.5 && kind < 6.5) {                                    // hair sways
    float t = aMore.z;
    p.x += sin(uTime * .7 + seed * 6.28 + t * 4.) * .05 * t * t;
    p.z += cos(uTime * .5 + seed * 4.) * .035 * t * t;
  }
  p += vec3(sin(uTime * 1.9 + seed * 40.), cos(uTime * 1.6 + seed * 31.), sin(uTime * 1.3 + seed * 17.)) * .0022;

  // Fly in: each point leaves its start at its own moment, swirls, and lands.
  float e = clamp((uForm - aData.w) / .48, 0., 1.);
  e = 1. - pow(1. - e, 3.);
  vec3 q = mix(aStart, p, e);
  float sw = (1. - e) * 2.4 * (seed - .5);
  q.xz = mat2(cos(sw), -sin(sw), sin(sw), cos(sw)) * q.xz;

  // Scatter: blown outward and up, as if the face is dissolving into data.
  if (uScatter > 0.) {
    vec3 dir = normalize(p - vec3(0., .05, -.4) + vec3(seed - .5, hash(seed * 7.) - .5, 0.) * .3);
    float s = uScatter * uScatter;
    q += (dir * (.5 + seed * 2.2) + vec3(0., .5 + hash(seed * 3.) * .8, 0.)) * s;
  }

  // Glitch: horizontal bands torn sideways.
  float band = floor((q.y + 2.) * 14.);
  float r = hash(band * 91.7 + floor(uTime * 22.) * 13.1);
  float g = step(.8, r) * uGlitch;
  q.x += (r - .9) * g * 2.2;

  vec4 mv = modelViewMatrix * vec4(q, 1.);
  gl_Position = projectionMatrix * mv;

  float a = aData.y * (.2 + .8 * e) * (1. - smoothstep(.55, 1., uScatter));
  float size = aData.z;
  vec3 col = aColor;
  if (kind > 3.5 && kind < 5.5) {                                     // eyes: dull until they ignite; gone when shut
    if (kind < 4.5) { col = mix(vec3(.55, .6, .66), aColor, uEyes); a *= .35 + .65 * uEyes; size *= 1. + uEyes * .5; }
    a *= 1. - lid * .97;
  }
  // The scan line: a bright band sweeping down the face as it locks in.
  float sy = mix(1.15, -1.25, uScan);
  float scan = smoothstep(.06, 0., abs(p.y - sy)) * step(.001, uScan) * step(uScan, .999);
  a += scan * .7;
  col = mix(col, vec3(1., .55, .5), scan * .6);
  col = mix(col, vec3(1., .12, .12), g);
  vCol = col;
  vA = a;
  gl_PointSize = size * uScale / -mv.z;
}`;

const FRAG = /* glsl */ `
varying vec3 vCol;
varying float vA;
void main(){
  float d = length(gl_PointCoord - .5);
  float a = smoothstep(.5, .1, d) * vA;
  if (a < .004) discard;
  gl_FragColor = vec4(vCol * a, a);
}`;

// Renderer

const EASE = { linear: t => t, out: t => 1 - (1 - t) ** 3, inOut: t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2), in: t => t * t * t };

export class ParticleFace {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x020203, 1);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x020203);
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
    this.head = new THREE.Group();
    this.scene.add(this.head);

    this.u = {
      uTime: { value: 0 }, uForm: { value: 0 }, uScatter: { value: 0 }, uGlitch: { value: 0 }, uEyes: { value: 0 },
      uScan: { value: 0 }, uScale: { value: 6 }, uSmirk: { value: 0 }, uLid: { value: new THREE.Vector2(0, 0) },
    };
    this.state = { tilt: 0, turn: 0 };

    const { out, eyes, occluder } = build();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3));
    g.setAttribute('aStart', new THREE.Float32BufferAttribute(out.start, 3));
    g.setAttribute('aClose', new THREE.Float32BufferAttribute(out.close, 3));
    g.setAttribute('aExpr', new THREE.Float32BufferAttribute(out.expr, 3));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(out.color, 3));
    g.setAttribute('aData', new THREE.Float32BufferAttribute(out.data, 4));
    g.setAttribute('aMore', new THREE.Float32BufferAttribute(out.more, 3));
    this.count = out.data.length / 4;
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: this.u, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
    }));
    this.points.frustumCulled = false;
    this.head.add(this.points);

    // Invisible occluders, so hair and neck behind the face don't shine through it.
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(occluder.v.flatMap(p => [p.x * S, p.y * S, (p.z - 0.35) * S]), 3));
    fg.setIndex([...FACE_T]);
    const hide = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
    this.occluders = [new THREE.Mesh(fg, hide)];
    const skull = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5).rotateX(Math.PI / 2), hide);   // the back half only
    skull.scale.set(occluder.HR.x * 0.95 * S, occluder.HR.y * 0.95 * S, occluder.HR.z * 0.95 * S);
    skull.position.set(occluder.HC.x * S, occluder.HC.y * S, occluder.HC.z * S);
    this.occluders.push(skull);
    for (const o of this.occluders) { o.renderOrder = -1; o.visible = false; this.head.add(o); }

    // Soft glow behind each iris.
    const glowTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const x = c.getContext('2d'), gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
      gr.addColorStop(0, 'rgba(255,90,70,1)'); gr.addColorStop(0.25, 'rgba(255,30,30,.55)'); gr.addColorStop(1, 'rgba(255,0,0,0)');
      x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
      return new THREE.CanvasTexture(c);
    })();
    this.glows = eyes.map(e => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthTest: false, transparent: true, opacity: 0 }));
      s.position.set(e.centre.x * S, e.centre.y * S, (e.centre.z + 0.4) * S);
      s.scale.setScalar(e.width * 0.95 * S);
      s.userData.side = e.side;
      this.head.add(s);
      return s;
    });

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.38, 0.32);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.mouse = { x: 0, y: 0 };
    this.onMove = e => { this.mouse.x = e.clientX / innerWidth - 0.5; this.mouse.y = e.clientY / innerHeight - 0.5; };
    this.onResize = () => this.resize();
    addEventListener('pointermove', this.onMove);
    addEventListener('resize', this.onResize);
    this.resize();
    this.tweens = [];
    this.running = false;
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.camera.aspect = w / h;
    const t = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.camera.position.set(0, 0.2, Math.max(1.66 / t, 1.2 / (t * this.camera.aspect)));
    this.camera.updateProjectionMatrix();
    this.u.uScale.value = (this.renderer.getPixelRatio() * h) / 118;
  }

  /** Animate a value to `to` over `ms`. name: a uniform (uForm...), 'lidL' / 'lidR', 'tilt' or 'turn'. */
  tween(name, to, ms, ease = 'inOut') {
    return new Promise(done => {
      const from = this.get(name);
      this.tweens = this.tweens.filter(t => t.name !== name);
      this.tweens.push({ name, from, to, t0: performance.now(), ms: Math.max(1, ms), ease: EASE[ease] || EASE.inOut, done });
    });
  }
  get(name) {
    if (name === 'lidL') return this.u.uLid.value.x;
    if (name === 'lidR') return this.u.uLid.value.y;
    if (name in this.state) return this.state[name];
    return this.u[name].value;
  }
  set(name, v) {
    if (name === 'lidL') this.u.uLid.value.x = v;
    else if (name === 'lidR') this.u.uLid.value.y = v;
    else if (name in this.state) this.state[name] = v;
    else this.u[name].value = v;
  }

  start() {
    if (this.running) return;
    this.running = true;
    let last = performance.now();
    const loop = now => {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.tweens = this.tweens.filter(t => {
        const k = Math.min(1, (now - t.t0) / t.ms);
        this.set(t.name, t.from + (t.to - t.from) * t.ease(k));
        if (k >= 1) { t.done(); return false; }
        return true;
      });
      const u = this.u, time = (u.uTime.value += dt);
      const solid = u.uForm.value > 1 && u.uScatter.value < 0.05;
      for (const o of this.occluders) o.visible = solid;
      this.glows.forEach(s => { s.material.opacity = u.uEyes.value * 0.55 * (1 - (s.userData.side < 0 ? u.uLid.value.x : u.uLid.value.y)) * (1 - u.uScatter.value); });
      this.head.rotation.set(
        -0.04 + Math.sin(time * 0.27) * 0.04 + this.mouse.y * 0.14,
        Math.sin(time * 0.33) * 0.14 + this.mouse.x * 0.3 + this.state.turn,
        this.state.tilt,
      );
      this.composer.render(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  dispose() {
    this.running = false;
    removeEventListener('pointermove', this.onMove);
    removeEventListener('resize', this.onResize);
    this.points.geometry.dispose();
    this.points.material.dispose();
    this.composer.dispose?.();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
  }
}
