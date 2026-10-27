// Evaluate recognition on cached query features (see tmp/extract-queries.mjs).
//   node pipeline/eval-recognition.mjs <targets-dir> <qfeat-dir> [--K=16 --L=3 --frames=1,3,9]
import fs from 'node:fs';
import path from 'node:path';
import { readTargetPoints, buildIndex } from './build-index.mjs';
import { bagOfWords, scoreBag } from '../src/ar/recognizer.js';

const [tdir, qdir] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const opt = Object.fromEntries(process.argv.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const frames = (opt.frames || '1,3,9').split(',').map(Number);
const files = fs.readdirSync(tdir).filter((f) => f.endsWith('.mind')).sort();
const ids = files.map((f) => path.basename(f, '.mind'));
const t0 = Date.now();
const { index } = buildIndex(files.map((f) => readTargetPoints(path.join(tdir, f))), { K: +(opt.K || 32), L: +(opt.L || 3), sample: +(opt.sample || 200000), shared: opt.shared === '1' });
console.log(`index built in ${((Date.now() - t0) / 1000).toFixed(1)}s for ${ids.length} targets`);

const qfiles = fs.readdirSync(qdir).filter((f) => f.endsWith('.json') && ids.includes(f.slice(0, 3)));
const res = Object.fromEntries(frames.map((n) => [n, { r1: 0, r3: 0, r5: 0, margins: [], fails: [] }]));
for (const f of qfiles) {
  const truth = ids.indexOf(f.slice(0, 3));
  const q = JSON.parse(fs.readFileSync(path.join(qdir, f)));
  const cropBags = q.crops.map((pts) => bagOfWords(index, pts.map(([m, , , , , d]) => ({ maxima: !!m, descriptors: d }))));
  for (const n of frames) {
    const bag = new Map();
    for (const b of cropBags.slice(0, n)) for (const [w, c] of b) bag.set(w, (bag.get(w) || 0) + c);
    const s = scoreBag(index, bag);
    const order = Array.from(s.keys()).sort((a, b) => s[b] - s[a]);
    const rank = order.indexOf(truth);
    const r = res[n];
    if (rank < 1) r.r1++; if (rank < 3) r.r3++; if (rank < 5) r.r5++;
    else r.fails.push(f);
    r.margins.push(s[order[0]] / (s[order[1]] || 1e-6));
  }
}
for (const n of frames) {
  const r = res[n], N = qfiles.length;
  const m = r.margins.sort((a, b) => a - b);
  console.log(`frames=${n}: top1 ${(100 * r.r1 / N).toFixed(1)}%  top3 ${(100 * r.r3 / N).toFixed(1)}%  top5 ${(100 * r.r5 / N).toFixed(1)}%  (n=${N})  ratio p10 ${m[Math.floor(N * 0.1)].toFixed(2)} med ${m[Math.floor(N / 2)].toFixed(2)}  fails: ${r.fails.slice(0, 12).join(' ')}`);
}
