#!/usr/bin/env node
// One command from artist files to a deployable AR site.
//
//   node pipeline/build.mjs [--config=motu.config.json] [--jobs=2]
//
// Reads motu.config.json, then for every artwork that has both an image and a video:
//   1. makes a 1024px reference image          build/refs/<id>.jpg
//   2. compiles its MindAR target (cached)     public/targets/<id>.mind
//   3. builds the recognition index            public/index.bin
//   4. links media + writes the manifest       public/manifest.json
// Re-running only redoes what changed. Videos must already be transcoded
// (pipeline/transcode.mjs) into the collection's videos folder.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { readTargetPoints, buildIndex } from './build-index.mjs';
import { serializeIndex } from '../src/ar/recognizer.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || `=${d}`).split('=').slice(1).join('=');
const config = JSON.parse(fs.readFileSync(path.resolve(ROOT, arg('config', 'motu.config.json'))));
const JOBS = +arg('jobs', 2);
const R = (p) => path.resolve(ROOT, p);
const PUB = R(config.public || 'public');
const BUILD = R('build');
for (const d of ['refs', 'targets']) fs.mkdirSync(path.join(BUILD, d), { recursive: true });
for (const d of ['targets', 'media', 'audio']) fs.mkdirSync(path.join(PUB, d), { recursive: true });

const IMG = /\.(jpe?g|png|webp|tiff?)$/i;
const VID = /\.(mp4|m4v|mov)$/i;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(3, '0');
const leadNum = (f) => { const m = path.basename(f).match(/^\s*(\d+)/); return m ? +m[1] : null; };
const readJSON = (f, d) => (f && fs.existsSync(R(f)) ? JSON.parse(fs.readFileSync(R(f), 'utf8')) : d);

// ------------------------------------------------------------ collect artworks
const artworks = [];
const warnings = [];
for (const col of config.collections) {
  if (col.kind === 'numbered') {
    const imgs = fs.existsSync(R(col.images)) ? fs.readdirSync(R(col.images)).filter((f) => IMG.test(f) && !f.startsWith('.')) : [];
    const vids = fs.existsSync(R(col.videos)) ? fs.readdirSync(R(col.videos)).filter((f) => VID.test(f) && !f.includes('.part.')) : [];
    const vidBy = new Map(vids.map((f) => [leadNum(f), f]));
    const texts = readJSON(col.texts, {});
    const sources = readJSON(path.join(col.videos, 'sources.json'), {});
    const start = col.startDate ? new Date(`${col.startDate}T12:00:00Z`) : null;
    const byNum = new Map();
    for (const f of imgs) {
      const n = leadNum(f), prev = byNum.get(n);
      if (prev !== undefined) warnings.push(`${col.name} #${n}: two photos (${prev}, ${f}) — using the newer one`);
      if (prev === undefined || fs.statSync(path.join(R(col.images), f)).mtimeMs > fs.statSync(path.join(R(col.images), prev)).mtimeMs) byNum.set(n, f);
    }
    for (const f of [...byNum.values()].sort((a, b) => leadNum(a) - leadNum(b))) {
      const n = leadNum(f);
      if (n === null) { warnings.push(`no number in ${f}`); continue; }
      const v = vidBy.get(n);
      if (!v) { warnings.push(`${col.name} #${n}: image but no video yet`); continue; }
      const t = texts[pad(n)] || texts[String(n)] || {};
      let date = '';
      if (start) {
        const d = new Date(start.getTime() + (n - 1) * 864e5);
        date = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
      }
      const src = sources[pad(n)] || '';
      const tm = src.match(/-\s*(\d{2})(\d{2})\s*\./);
      const time = tm ? `${tm[1]}:${tm[2]}` : '';
      const label = (t.label || col.label || '{n}').replace('{nnn}', pad(n)).replace('{n}', n).replace('{date}', date).replace('{time}', time).replace('{title}', t.title || '');
      artworks.push({
        id: pad(n), collection: col.name, n, title: t.title || null, label, date, time,
        image: path.join(R(col.images), f), video: path.join(R(col.videos), v),
        audio: t.audio ? R(t.audio) : null, diary: t.diary || null, fit: t.fit || col.fit || null,
      });
    }
    for (const [n] of vidBy) if (n !== null && !imgs.some((f) => leadNum(f) === n)) warnings.push(`${col.name} #${n}: video but no photo yet`);
  } else if (col.kind === 'list') {
    const dir = path.dirname(R(col.file));
    for (const it of readJSON(col.file, [])) {
      const id = `${col.name}-${it.id}`;
      const image = path.resolve(dir, it.image), video = path.resolve(dir, it.video);
      if (!fs.existsSync(image) || !fs.existsSync(video)) { warnings.push(`${id}: missing ${fs.existsSync(image) ? 'video' : 'image'}`); continue; }
      artworks.push({
        id, collection: col.name, title: it.title || null, label: it.label || it.title || id,
        image, video, audio: it.audio ? path.resolve(dir, it.audio) : null, fit: it.fit || col.fit || null,
        diary: it.diary && /\.(txt|md)$/.test(it.diary) && fs.existsSync(path.resolve(dir, it.diary))
          ? fs.readFileSync(path.resolve(dir, it.diary), 'utf8').trim() : (it.diary || null),
      });
    }
  }
}
if (!artworks.length) { console.error('no artworks found'); process.exit(1); }
console.log(`${artworks.length} artworks (${config.collections.map((c) => `${c.name}: ${artworks.filter((a) => a.collection === c.name).length}`).join(', ')})`);

// Caching is by content hash (sidecar .src files), not timestamps: Dropbox and
// copies between machines change mtimes, and recompiling 366 targets takes a while.
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const upToDate = (out, srcHash) => fs.existsSync(out) && fs.existsSync(`${out}.src`) && fs.readFileSync(`${out}.src`, 'utf8') === srcHash;
// Bump when compile-targets changes what it stores (e.g. the angle-trained keyframes), so old targets rebuild.
const COMPILE = 'views-1';

// ------------------------------------------------------------ 1. reference images
for (const a of artworks) {
  a.ref = path.join(BUILD, 'refs', `${a.id}.jpg`);
  const h = md5(a.image);
  if (!upToDate(a.ref, h)) {
    await sharp(a.image).rotate().resize({ width: 1024, height: 1024, fit: 'inside' }).jpeg({ quality: 92 }).toFile(a.ref);
    fs.writeFileSync(`${a.ref}.src`, h);
  }
  a.refHash = md5(a.ref);
}

// ------------------------------------------------------------ 2. targets (parallel, cached)
// Restore precompiled targets shipped as build/cache/*.tar (saves ~12 s per artwork).
const cacheDir = path.join(BUILD, 'cache');
if (fs.existsSync(cacheDir)) {
  for (const t of fs.readdirSync(cacheDir).filter((f) => f.endsWith('.tar')).sort()) {
    const r = spawnSync('tar', ['-xf', path.join(cacheDir, t), '-k', '-C', BUILD], { stdio: 'ignore' });
    if (r.status !== 0 && r.status !== 1) warnings.push(`could not unpack ${t}`);
  }
}
const mindOf = (a) => path.join(BUILD, 'targets', `${a.id}.mind`);
const stale = artworks.filter((a) => !upToDate(mindOf(a), `${a.refHash}:${COMPILE}`));
if (stale.length) {
  console.log(`compiling ${stale.length} targets with ${JOBS} workers…`);
  const listDir = path.join(BUILD, 'stale');
  fs.rmSync(listDir, { recursive: true, force: true }); fs.mkdirSync(listDir);
  for (const a of stale) fs.symlinkSync(a.ref, path.join(listDir, `${a.id}.jpg`));
  // Each finished target is stamped at once, so a long compile can be stopped and resumed.
  const byId = new Map(stale.map((a) => [a.id, a]));
  const stamp = (line) => {
    const m = line.match(/^(\S+)\s+\d+ KB/);
    const a = m && byId.get(m[1]);
    if (a && fs.existsSync(mindOf(a))) fs.writeFileSync(`${mindOf(a)}.src`, `${a.refHash}:${COMPILE}`);
  };
  await Promise.all(Array.from({ length: JOBS }, (_, i) => new Promise((res, rej) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'pipeline/compile-targets.mjs'), listDir, path.join(BUILD, 'targets'), `--shard=${i}/${JOBS}`], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d; const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) if (/KB/.test(l)) { stamp(l); process.stdout.write(`  ${l}\n`); }
    });
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(`compile worker ${i} exited ${c}`))));
  })));
  fs.rmSync(listDir, { recursive: true, force: true });
}

// ------------------------------------------------------------ 3. index
const hashFile = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex').slice(0, 10);
const t0 = Date.now();
const { index, bags } = buildIndex(artworks.map((a) => readTargetPoints(path.join(BUILD, 'targets', `${a.id}.mind`))), config.index || {});
const bin = serializeIndex(index, bags, artworks.map((a) => a.id));
// gzip it ourselves (hosts rarely compress binary types); the viewer inflates it
// with DecompressionStream. Raw copy kept for very old browsers.
const gz = zlib.gzipSync(bin, { level: 9 });
fs.writeFileSync(path.join(PUB, 'index.bin'), bin);
fs.writeFileSync(path.join(PUB, 'index.bin.gz'), gz);
console.log(`index: ${(bin.length / 1024).toFixed(0)} KB (${(gz.length / 1024).toFixed(0)} KB gzipped) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ------------------------------------------------------------ 4. publish files + manifest
const published = new Map(); // real source path -> published url (shared films are stored once)
function publish(src, rel) {
  const real = fs.realpathSync(src);
  if (published.has(real)) return published.get(real);
  const dest = path.join(PUB, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const same = fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(src).size && fs.statSync(dest).mtimeMs >= fs.statSync(src).mtimeMs;
  if (!same) fs.copyFileSync(src, dest);
  const url = `${rel}?v=${hashFile(dest)}`;
  published.set(real, url);
  return url;
}
const sub = (a) => (a.collection === '366' ? '' : `${a.collection}/`);
// Heavy files (films, targets, narration) can live on another host/CDN: set
// "assetBase": "https://media.example.com/" in motu.config.json and upload public/{media,targets,audio} there.
const base = config.assetBase ? config.assetBase.replace(/\/?$/, '/') : '';
const remote = (rel) => base + rel;
const entries = artworks.map((a) => {
  const mind = path.join(BUILD, 'targets', `${a.id}.mind`);
  const e = {
    id: a.id, collection: a.collection, label: a.label,
    target: remote(publish(mind, `targets/${a.id}.mind`)),
    video: remote(publish(a.video, `media/${sub(a)}${path.basename(a.video).replace(/^(\d+)\..*/, (m, n) => `${pad(+n)}.mp4`)}`)),
  };
  if (a.title) e.title = a.title;
  if (a.date) e.date = a.date;
  if (a.time) e.time = a.time;
  if (a.audio) e.audio = remote(publish(a.audio, `audio/${path.basename(a.audio)}`));
  if (a.diary) e.diary = a.diary;
  if (a.fit) e.fit = a.fit;
  return e;
});
const manifest = {
  title: config.title, volume: config.volume ?? 0.5, built: new Date().toISOString(),
  index: `index.bin.gz?v=${hashFile(path.join(PUB, 'index.bin'))}`,
  indexRaw: `index.bin?v=${hashFile(path.join(PUB, 'index.bin'))}`,
  engine: config.engine || {}, artworks: entries,
};
fs.writeFileSync(path.join(PUB, 'manifest.json'), JSON.stringify(manifest, null, 1));
const bytes = [...new Set(entries.map((e) => e.video.slice(base.length).split('?')[0]))].reduce((s, f) => s + fs.statSync(path.join(PUB, f)).size, 0);
console.log(`manifest: ${entries.length} artworks, ${(bytes / 1e6).toFixed(0)} MB of film`);
if (warnings.length) console.log(`\n${warnings.length} notes:\n  ${warnings.slice(0, 40).join('\n  ')}${warnings.length > 40 ? '\n  …' : ''}`);
