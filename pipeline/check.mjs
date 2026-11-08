#!/usr/bin/env node
// Pre-publish check: every artwork must still be found and locked.
//
//   node pipeline/check.mjs [--shard=i/n]      (writes build/check/<i>.json)
//   node pipeline/check.mjs --report           (summary; exit 1 if anything fails)
//
// For each artwork, two simulated phone shots of its reference image (straight on,
// and 40 degrees from the side, on a dark wall with blur and noise) go through the
// same steps as the phone: recognizer over ALL artworks -> top 3 -> MindAR matcher.
// Passing means: the true artwork is in the top 3 and it locks, and nothing else does.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import * as msgpack from '@msgpack/msgpack';
import { deserializeIndex, bagOfWords, scoreBag } from '../src/ar/recognizer.js';
import { detectCrops } from './lib/frame-features.mjs';
import { Matcher } from '../src/ar/matcher.js';
import { homography, applyH, viewQuad } from './lib/views.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PUB = path.join(ROOT, 'public'), OUT = path.join(ROOT, 'build/check');
fs.mkdirSync(OUT, { recursive: true });

if (process.argv.includes('--report')) {
  const rows = fs.readdirSync(OUT).filter((f) => f.endsWith('.json')).flatMap((f) => JSON.parse(fs.readFileSync(path.join(OUT, f))));
  // Some prints are the same image as another artwork (the four pumpkins and painting 041 are all
  // May 18; the four prints of the man share one film). A lock on a twin plays the same film: fine.
  const manifest = JSON.parse(fs.readFileSync(path.join(PUB, 'manifest.json')));
  const keys = (a) => {
    const k = new Set([a.video.split('?')[0], path.basename(a.video.split('?')[0], '.mp4').toLowerCase()]);
    if (a.date) k.add(a.date.replace(/,.*$/, '').toLowerCase().replace(' ', '-'));
    return k;
  };
  const film = new Map(manifest.artworks.map((a) => [a.id, keys(a)]));
  const same = (x, y) => [...film.get(x)].some((k) => film.get(y).has(k));
  for (const r of rows) if (r.wrong && same(r.wrong, r.id)) { r.twin = r.wrong; r.wrong = null; }
  const by = (view) => rows.filter((r) => r.view === view);
  for (const v of ['front', 'side40']) {
    const rs = by(v);
    console.log(`${v.padEnd(7)} found in top 3: ${rs.filter((r) => r.rank < 3).length}/${rs.length}   locked: ${rs.filter((r) => r.locked || r.twin).length}/${rs.length}   wrong locks: ${rs.filter((r) => r.wrong).length}`);
  }
  const bad = rows.filter((r) => r.rank >= 3 || !(r.locked || r.twin) || r.wrong);
  if (bad.length) console.log('FAILED:', bad.map((r) => `${r.id}/${r.view}(rank ${r.rank}${r.wrong ? ', wrong lock ' + r.wrong : ''})`).join('  '));
  const twins = rows.filter((r) => r.twin);
  if (twins.length) console.log('same film, fine:', twins.map((r) => `${r.id}~${r.twin}`).join('  '));
  const ids = new Set(rows.map((r) => r.id));
  console.log(`${ids.size} artworks checked`);
  process.exit(bad.length ? 1 : 0);
}

const manifest = JSON.parse(fs.readFileSync(path.join(PUB, 'manifest.json')));
const index = deserializeIndex(new Uint8Array(fs.readFileSync(path.join(PUB, 'index.bin'))));
const [si, sn] = (process.argv.find((a) => a.startsWith('--shard=')) || '--shard=0/1').slice(8).split('/').map(Number);
const outFile = path.join(OUT, `${si}.json`);
const done = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile)) : [];
const doneIds = new Set(done.map((r) => `${r.id}/${r.view}`));
const mindCache = new Map();
const kfs = (i) => {
  if (!mindCache.has(i)) mindCache.set(i, msgpack.decode(fs.readFileSync(path.join(PUB, manifest.artworks[i].target.split('?')[0]))).dataList[0].matchingData);
  return mindCache.get(i);
};

// a 480x640 phone frame: the artwork seen at `yaw`, ~72% of the width, on a dark wall
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
async function shot(refFile, yaw) {
  const { data, info } = await sharp(refFile).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = 480, H = 640, w = info.width, h = info.height;
  const q = viewQuad(w, h, yaw, 0, 1).map(([x, y]) => [(x - w / 2), (y - h / 2)]);
  const qw = Math.max(...q.map((p) => p[0])) - Math.min(...q.map((p) => p[0]));
  const s = (0.72 * W) / qw;
  const quad = q.map(([x, y]) => [W / 2 + x * s, H * 0.45 + y * s]);
  const Hinv = homography(quad, [[0, 0], [w, 0], [w, h], [0, h]]);
  const g = new Float32Array(W * H);
  const gain = 0.85 + 0.25 * rnd();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [sx, sy] = applyH(Hinv, x + 0.5, y + 0.5);
    let v = 58;
    if (sx >= 0 && sy >= 0 && sx < w - 1 && sy < h - 1) {
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0, i = y0 * w + x0;
      v = (data[i] * (1 - fx) + data[i + 1] * fx) * (1 - fy) + (data[i + w] * (1 - fx) + data[i + w + 1] * fx) * fy;
    }
    g[y * W + x] = v * gain + (rnd() - 0.5) * 8;
  }
  // light blur (phone optics)
  const b = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    b[i] = (4 * g[i] + g[i - 1] + g[i + 1] + g[i - W] + g[i + W]) / 8;
  }
  return { data: b, width: W, height: H };
}

const results = [...done];
const T0 = Date.now();
for (let i = si; i < manifest.artworks.length; i += sn) {
  const a = manifest.artworks[i];
  if (process.env.ONLY && !process.env.ONLY.split(',').includes(a.id)) continue;
  for (const [view, yaw] of [['front', 0], ['side40', 40]]) {
    if (doneIds.has(`${a.id}/${view}`)) continue;
    const frame = await shot(path.join(ROOT, 'build/refs', `${a.id}.jpg`), yaw);
    const crops = detectCrops(frame, +process.env.CROPS || 3);
    const bag = new Map();
    for (const pts of crops) for (const [w, c] of bagOfWords(index, pts)) bag.set(w, (bag.get(w) || 0) + c);
    const sc = scoreBag(index, bag);
    const order = Array.from(sc.keys()).sort((x, y) => sc[y] - sc[x]);
    const rank = order.indexOf(i);
    const m = new Matcher(frame.width, frame.height);
    let locked = false, wrong = null;
    // like the phone: candidates are tried in score order and the first that verifies wins
    for (const pts of crops) {
      const hit = order.slice(0, 3).find((c) => m.matchDetection(kfs(c), pts).keyframeIndex !== -1);
      if (hit === undefined) continue;
      if (hit === i) { locked = true; break; }
      wrong = manifest.artworks[hit].id;
    }
    results.push({ id: a.id, view, rank, locked, wrong });
  }
  fs.writeFileSync(outFile, JSON.stringify(results));
  if (Date.now() - T0 > (+process.env.BUDGET || 150) * 1000) break;
}
console.log(`shard ${si}: ${results.length} checks`);
