// Offline: replay recorded tracker output (steady.mjs runs) through the smoothing
// filters and score them against the truth. Instant, so it can try hundreds of settings.
//   node test/tune-steady.mjs rec1.json:clip1.json rec2.json:clip2.json ...
import fs from 'node:fs';
import { CornerKalman } from '../src/ar/smooth.js';

const sets = process.argv.slice(2).map((s) => {
  const [r, c] = s.split(':');
  return { name: c.replace(/.*\//, ''), frames: JSON.parse(fs.readFileSync(r)).frames, truth: JSON.parse(fs.readFileSync(c)) };
});
const stretches = [['still', 2.5, 7.5, 3], ['look', 7.5, 10.5, 1.5], ['flick', 10.5, 12, 0.5], ['still2', 12, 14, 2]];
const dist = (a, g) => { let s = 0; for (let k = 0; k < 4; k++) s += Math.hypot(a[2 * k] - g[2 * k], a[2 * k + 1] - g[2 * k + 1]); return s / 4; };

// mirrors the engine's per-frame logic (tracking -> filter; dropped -> hold/coast; long drop -> hide)
function replay({ frames, truth }, make, { holdMs = 600, fastHoldMs = 150, fast = 150, source = 'fit' } = {}) {
  const f = make();
  let out = null, lostAt = 0, showing = false;
  const res = [];
  for (const r of frames) {
    const t = r.f / truth.fps;
    const raw = r.tracking ? (source === 'fit' ? (r.fit || r.pose) : r.pose) : null;
    if (raw) {
      if (!showing) { f.reset(); showing = true; }
      if (lostAt && out && dist(raw, out) > 0.25 * Math.hypot(out[4] - out[0], out[5] - out[1])) f.set(t, raw);
      lostAt = 0;
      out = f.filter(t, raw);
    } else if (showing && out) {
      if (!lostAt) lostAt = t;
      const limit = (f.speed && f.speed() > fast ? fastHoldMs : holdMs) / 1000;
      if (t - lostAt > limit) { showing = false; out = null; } else if (f.coast) out = f.coast(t);
    }
    res.push({ f: r.f, out: showing ? out : null });
  }
  return res;
}

function score(set, res) {
  const T = (f) => f / set.truth.fps, out = {};
  let cost = 0;
  for (const [name, a, b, w] of stretches) {
    const fr = res.filter((r) => T(r.f) >= a && T(r.f) < b && set.truth.corners[r.f]);
    const shown = fr.filter((r) => r.out);
    const err = shown.map((r) => dist(r.out, set.truth.corners[r.f]));
    let wob = 0, n = 0;
    for (let i = 1; i < fr.length; i++) {
      const p = fr[i - 1], q = fr[i];
      if (!p.out || !q.out || q.f - p.f > 3) continue;
      const gp = set.truth.corners[p.f], gq = set.truth.corners[q.f];
      for (let k = 0; k < 8; k++) { const d = (q.out[k] - gq[k]) - (p.out[k] - gp[k]); wob += d * d; }
      n += 4;
    }
    const e = err.length ? err.reduce((s, x) => s + x, 0) / err.length : 99;
    const big = err.filter((x) => x > 12).length / Math.max(1, fr.length);
    const sh = n ? Math.sqrt(wob / n) : 99, gone = 1 - shown.length / Math.max(1, fr.length);
    out[name] = { e, sh, gone, big };
    cost += w * (sh + 0.5 * e + 20 * big + 6 * gone);
  }
  return { cost, out };
}

function evaluate(label, make, opts) {
  let total = 0; const rows = [];
  for (const s of sets) { const sc = score(s, replay(s, make, opts)); total += sc.cost; rows.push([s.name, sc.out]); }
  return { label, total, rows };
}
const show = (r) => {
  console.log(`${r.label}   cost ${r.total.toFixed(1)}`);
  for (const [n, o] of r.rows) console.log('   ' + n.padEnd(16) + Object.entries(o).map(([k, v]) => `${k} e${v.e.toFixed(2)} sh${v.sh.toFixed(2)}${v.gone > 0.01 ? ` gone${(100 * v.gone).toFixed(0)}%` : ''}${v.big > 0 ? ` big${(100 * v.big).toFixed(0)}%` : ''}`).join(' | '));
};

const results = [];
results.push(evaluate('raw fit, no smoothing', () => ({ reset() {}, set() {}, filter: (t, q) => q }), { holdMs: 600, fastHoldMs: 60, fast: 80 }));
results.push(evaluate('raw pose, no smoothing (old geometry)', () => ({ reset() {}, set() {}, filter: (t, q) => q }), { source: 'pose' }));
const grid = process.env.GRID === 'hold';
if (!grid) {
  const hold = { holdMs: 600, fastHoldMs: 60, fast: 80 };
  for (const accel of [150, 250, 400, 700, 1200, 2500]) {
    results.push(evaluate(`kalman n1 a${accel}`, () => new CornerKalman({ noise: 1, accel, coast: 0.2 }), hold));
  }
} else {
  const accel = +process.env.ACCEL;
  for (const holdMs of [300, 600, 900]) for (const fastHoldMs of [60, 120, 200]) for (const fast of [80, 150, 250]) for (const coast of [0.05, 0.1, 0.2]) {
    results.push(evaluate(`kalman a${accel} hold${holdMs} fastHold${fastHoldMs} fast${fast} coast${coast}`, () => new CornerKalman({ noise: 1, accel, coast }), { holdMs, fastHoldMs, fast }));
  }
}
results.sort((a, b) => a.total - b.total);
for (const l of ['raw fit', 'raw pose']) show(results.find((r) => r.label.startsWith(l)));
console.log('--- best overall');
for (const r of results.filter((r) => r.label.startsWith('kalman')).slice(0, +(process.env.TOP || 5))) show(r);
