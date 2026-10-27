// Build the recognition index (vocabulary tree + tf-idf bags) from .mind targets.
//
//   node pipeline/build-index.mjs <targets-dir> <out.bin> [--K=16] [--L=3] [--sample=150000]
//
// Every target's feature points (all scales) are quantized into visual words.
// The viewer downloads this one small file and can then tell which of the N
// artworks a camera frame shows, before loading any per-artwork tracking data.
import fs from 'node:fs';
import path from 'node:path';
import * as msgpack from '@msgpack/msgpack';
import { trainTree, bagOfWords, finalizeIndex, serializeIndex, DESC_WORDS } from '../src/ar/recognizer.js';

export function readTargetPoints(file) {
  const { dataList } = msgpack.decode(fs.readFileSync(file));
  const pts = [];
  for (const kf of dataList[0].matchingData) {
    for (const p of kf.maximaPoints) pts.push({ maxima: true, descriptors: p.descriptors });
    for (const p of kf.minimaPoints) pts.push({ maxima: false, descriptors: p.descriptors });
  }
  return pts;
}

export function buildIndex(targetPoints, { K = 32, L = 3, sample = 200000, seed = 1, shared = false } = {}) {
  const trees = {};
  for (const sign of shared ? [null] : [true, false]) {
    const all = [];
    targetPoints.forEach((pts) => pts.forEach((p) => { if (sign === null || p.maxima === sign) all.push(p.descriptors); }));
    // deterministic stride sample
    const step = Math.max(1, all.length / sample);
    const n = Math.min(sample, all.length);
    const descs = new Uint32Array(n * DESC_WORDS);
    for (let i = 0; i < n; i++) descs.set(all[Math.floor(i * step)], i * DESC_WORDS);
    trees[sign === false ? 'min' : 'max'] = trainTree(descs, n, K, L, seed + (sign === false ? 7 : 0));
  }
  if (shared) trees.min = trees.max;  // one tree; words still split by maxima/minima
  const index = { treeMax: trees.max, treeMin: trees.min, V: K ** L };
  const bags = targetPoints.map((pts) => bagOfWords(index, pts));
  finalizeIndex(index, bags);
  return { index, bags };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, out] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const opt = Object.fromEntries(process.argv.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')).map(([k, v]) => [k, Number(v)]));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mind')).sort();
  const ids = files.map((f) => path.basename(f, '.mind'));
  const t0 = Date.now();
  const { index, bags } = buildIndex(files.map((f) => readTargetPoints(path.join(dir, f))), opt);
  const bin = serializeIndex(index, bags, ids);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, bin);
  console.log(`index: ${ids.length} artworks, ${2 * index.V} words, ${(bin.length / 1024).toFixed(0)} KB, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
