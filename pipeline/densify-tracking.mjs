// Denser tracking points for compiled targets, without recompiling.
//
//   node pipeline/densify-tracking.mjs <in dir of .mind> <out dir> [--occ-div=30] [--only=001,040] [--manifest=public/manifest.json]
//
// With --manifest, the ?v= cache key of every rewritten target is updated (targets are
// served with a one-year immutable cache, so phones only fetch a new file under a new key).
//
// The tracker follows a painting frame to frame by template-matching small patches
// ("tracking points") picked from a low-resolution keyframe stored in each .mind.
// MindAR spaces those points a tenth of the keyframe apart, so most paintings got
// only 25-50 points, bunched where the detail is. Fewer points means a noisier fit
// and more dropped locks. This re-picks the points from the keyframe pixels already
// stored in the file, closer together (1/occ-div of the keyframe; 30 tested best, see README), and leaves
// everything else in the file untouched (recognition data, angle views, keyframe).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { densifyMind, TRACK_OCC_DIV } from './lib/track-extract.mjs';

const [inDir, outDir, ...flags] = process.argv.slice(2);
const opt = Object.fromEntries(flags.map((f) => f.replace(/^--/, '').split('=')));
const occDiv = +(opt['occ-div'] || TRACK_OCC_DIV);
const only = opt.only ? new Set(opt.only.split(',')) : null;
if (!inDir || !outDir) { console.error('usage: densify-tracking.mjs <in> <out> [--occ-div=30] [--only=ids]'); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

const manifest = opt.manifest ? JSON.parse(fs.readFileSync(opt.manifest, 'utf8')) : null;
const hashOf = (buf) => crypto.createHash('md5').update(buf).digest('hex').slice(0, 10); // same key as build.mjs
let n = 0, before = 0, after = 0, rekeyed = 0;
for (const f of fs.readdirSync(inDir).filter((x) => x.endsWith('.mind')).sort()) {
  const id = f.slice(0, -5);
  if (only && !only.has(id)) continue;
  const r = densifyMind(fs.readFileSync(path.join(inDir, f)), occDiv);
  before += r.before; after += r.after;
  const out = r.out;
  fs.writeFileSync(path.join(outDir, f), out);
  if (manifest) {
    for (const a of manifest.artworks) {
      if (a.target && a.target.split('?')[0].endsWith(`targets/${f}`)) { a.target = `${a.target.split('?')[0]}?v=${hashOf(out)}`; rekeyed++; }
    }
  }
  n++;
  if (n % 50 === 0) console.log(`${n} done`);
}
if (manifest) fs.writeFileSync(opt.manifest, JSON.stringify(manifest, null, 1)); // same format as build.mjs
console.log(`${n} targets, tracking points ${before} -> ${after} (occ-div ${occDiv})${manifest ? `, ${rekeyed} manifest keys updated` : ''}`);
