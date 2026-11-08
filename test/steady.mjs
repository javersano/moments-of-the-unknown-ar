// How steady does the film sit on the painting? Runs the real app in headless
// Chrome on a make-shake.py clip and compares the film's corners to the truth.
//
//   node test/steady.mjs <app url> <clip.y4m> ['{"minCutoff":0.5,...}' engine settings] [--shots]
//
// Prints, per stretch of the clip:
//   shown   share of frames with the film on the painting (after first lock)
//   error   average distance between film and painting corners (px), includes lag
//   shake   frame-to-frame wobble of the film relative to the painting (px RMS): what reads as jitter
// The same numbers for the raw tracker pose (no smoothing) are shown for reference.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');

const [url, y4m, settings = '{}', ...flags] = process.argv.slice(2);
const truth = JSON.parse(fs.readFileSync(y4m.replace(/\.y4m$/, '.json'), 'utf8'));
const header = fs.readFileSync(y4m).subarray(0, 80).toString().split('\n')[0];
const playFps = +/F(\d+):1/.exec(header)[1];
const seconds = truth.corners.length / playFps;

const browser = await chromium.launch({
  executablePath: process.env.CHROME || undefined,
  args: [
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`,
    '--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    '--ignore-certificate-errors',
  ],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
page.on('pageerror', (e) => console.log('  pageerror:', e.message));
const sep = url.includes('?') ? '&' : '?';
await page.goto(`${url}${sep}debug&engine=${encodeURIComponent(settings)}`);
await page.waitForFunction(() => !document.getElementById('start').disabled, null, { timeout: 90000 });
await page.click('#start');
await page.waitForFunction(() => document.body.classList.contains('running') && window.__motu && window.__motu.engine, null, { timeout: 60000 });

// instrument: which clip frame each engine step saw, what it showed, what the raw tracker said
await page.evaluate(([bits, bx, by, bw, bh, fps]) => {
  const eng = window.__motu.engine;
  const il = eng.controller.inputLoader;
  const ctx = il.context;
  const rec = (window.__rec = []);
  let cur = { f: -1 };
  const read = () => {
    const d = ctx.getImageData(0, 0, bx + bits * bw + 2, by + bh + 1).data, stride = bx + bits * bw + 2;
    let v = 0;
    for (let b = 0; b < bits; b++) {
      const x = bx + b * bw + (bw >> 1), y = by + (bh >> 1), i = (y * stride + x) * 4;
      if (d[i] + d[i + 1] + d[i + 2] > 384) v |= 1 << b;
    }
    return v;
  };
  const load = il.loadInput.bind(il);
  il.loadInput = (input) => { const t = load(input); cur = { f: read(), corners: null }; rec.push(cur); return t; };
  eng.clock = () => cur.f / fps;
  const onUpdate = eng.onUpdate;
  eng.onUpdate = (u) => {
    if (u.corners) {
      cur.corners = Array.from(u.corners); cur.tracking = u.tracking;
      const st = eng.state;
      cur.matched = st.matched; cur.points = st.points;
      if (st.tracking && st.mvt) {
        const r = eng._corners(st.mvt, st.slot); if (r) cur.pose = Array.from(r);
        if (st.fit) cur.fit = Array.from(st.fit);
      }
    }
    onUpdate(u);
  };
}, [...truth.barcode, truth.fps]);

const t0 = Date.now();
let shots = 0;
while (Date.now() - t0 < (seconds + 1.5) * 1000) {
  await page.waitForTimeout(1000);
  if (flags.includes('--shots')) {
    fs.mkdirSync('tmp/steady', { recursive: true });
    await page.screenshot({ path: `tmp/steady/${String(++shots).padStart(2, '0')}.png` });
  }
}
const rec = await page.evaluate(() => window.__rec);
const fps = await page.evaluate(() => document.getElementById('debug').textContent.split('\n')[0]);
await browser.close();

// one record per clip frame, first pass only
const seen = new Map();
let maxF = -1;
for (const r of rec) {
  if (r.f < maxF - 5) break; // the clip looped
  if (r.f > maxF) maxF = r.f;
  if (!seen.has(r.f)) seen.set(r.f, r);
}
const frames = [...seen.values()].sort((a, b) => a.f - b.f);
const T = (f) => f / truth.fps;
const stretches = [['held still', 2.5, 7.5], ['slow look-around', 7.5, 10.5], ['quick flick', 10.5, 12], ['held again', 12, 14]];
const dist = (a, g) => { let s = 0; for (let k = 0; k < 4; k++) s += Math.hypot(a[2 * k] - g[2 * k], a[2 * k + 1] - g[2 * k + 1]); return s / 4; };
function stats(key, a, b) {
  const fr = frames.filter((r) => T(r.f) >= a && T(r.f) < b && truth.corners[r.f]);
  const shown = fr.filter((r) => r[key]);
  const err = shown.map((r) => dist(r[key], truth.corners[r.f]));
  let wob = 0, n = 0;
  for (let i = 1; i < fr.length; i++) {
    const p = fr[i - 1], q = fr[i];
    if (!p[key] || !q[key] || q.f - p.f > 3) continue;
    const gp = truth.corners[p.f], gq = truth.corners[q.f];
    for (let k = 0; k < 8; k++) { const d = (q[key][k] - gq[k]) - (p[key][k] - gp[k]); wob += d * d; }
    n += 4;
  }
  return { frames: fr.length, shown: fr.length ? shown.length / fr.length : 0, error: err.length ? err.reduce((s, x) => s + x, 0) / err.length : NaN, shake: n ? Math.sqrt(wob / n) : NaN };
}
console.log(`settings ${settings}   engine steps: ${frames.length} distinct frames of ${truth.corners.length}   (${fps})`);
console.log('stretch              frames  shown   error px   shake px   | unsmoothed pose: error shake | homography fit: error shake');
const out = {};
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '  -  ').padStart(6);
for (const [name, a, b] of stretches) {
  const s = stats('corners', a, b), r = stats('pose', a, b), h = stats('fit', a, b);
  out[name] = s;
  console.log(`${name.padEnd(20)} ${String(s.frames).padStart(6)}  ${(100 * s.shown).toFixed(0).padStart(4)}%  ${f2(s.error)}    ${f2(s.shake)}    |  ${f2(r.error)} ${f2(r.shake)}          |  ${f2(h.error)} ${f2(h.shake)}`);
}
fs.mkdirSync('tmp', { recursive: true });
fs.writeFileSync(`tmp/steady-${Date.now()}.json`, JSON.stringify({ settings, out, frames }, null, 0));
