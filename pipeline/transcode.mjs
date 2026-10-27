#!/usr/bin/env node
// Shrink source films into phone-friendly AR overlays. No npm deps: needs ffmpeg.
//
//   node pipeline/transcode.mjs <src-dir-or-file> <out-dir> [--numbered] [--jobs=2] [--force]
//
//   --numbered   name outputs by the leading number of the source file
//                ("1. April 8th - 1414.mp4" -> 001.mp4); otherwise keep the basename.
//
// Output: 960x720 (4:3) H.264 High, light grain smoothing, ~1.8 Mbps cap,
// AAC 128k, faststart (plays while downloading). ~2.2 MB per 10 s clip.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const [src, out] = args.filter((a) => !a.startsWith('--'));
const numbered = args.includes('--numbered');
const force = args.includes('--force');
const opt = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const jobs = Number(opt('jobs', 2));
const budget = Number(opt('budget', 0)) * 1000;   // stop starting new files after N seconds
const preset = opt('preset', 'slow');
const T0 = Date.now();
if (!src || !out) { console.error('usage: transcode.mjs <src> <out-dir> [--numbered] [--jobs=N]'); process.exit(1); }

export const FFMPEG_ARGS = (input, output, preset = 'slow') => [
  '-v', 'error', '-y', '-i', input,
  '-vf', 'scale=960:720:force_original_aspect_ratio=increase:flags=lanczos,crop=960:720,hqdn3d=2:2:8:8,fps=24',
  '-c:v', 'libx264', '-preset', preset, '-profile:v', 'high', '-level', '4.0', '-pix_fmt', 'yuv420p',
  '-crf', '26', '-maxrate', '1800k', '-bufsize', '3600k', '-g', '48',
  '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
  '-movflags', '+faststart', '-map_metadata', '-1', output,
];

const isVideo = (f) => /\.(mp4|mov|m4v|mkv)$/i.test(f) && !f.startsWith('.');
const files = fs.statSync(src).isDirectory()
  ? fs.readdirSync(src).filter(isVideo).sort((a, b) => parseInt(a) - parseInt(b) || a.localeCompare(b)).map((f) => path.join(src, f))
  : [src];
fs.mkdirSync(out, { recursive: true });

function outName(file) {
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  if (!numbered) return `${base}.mp4`;
  const m = base.match(/^\s*(\d+)/);
  if (!m) return null;
  return `${String(+m[1]).padStart(3, '0')}.mp4`;
}

function run(file) {
  return new Promise((resolve) => {
    const name = outName(file);
    if (!name) { console.log(`skip (no number): ${path.basename(file)}`); return resolve(); }
    const dest = path.join(out, name);
    try {
      if (!force && fs.existsSync(dest) && fs.statSync(dest).mtimeMs >= fs.statSync(file).mtimeMs && fs.statSync(dest).size > 1000) return resolve();
    } catch (e) {}
    const tmp = dest.replace(/\.mp4$/, '.part.mp4');
    const t0 = Date.now();
    const p = spawn('ffmpeg', FFMPEG_ARGS(file, tmp, preset), { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      if (code === 0) {
        fs.renameSync(tmp, dest);
        console.log(`${name}  ${(fs.statSync(dest).size / 1e6).toFixed(2)} MB  ${((Date.now() - t0) / 1000).toFixed(0)}s  <- ${path.basename(file)}`);
      } else {
        try { fs.unlinkSync(tmp); } catch (e) {}
        console.log(`FAILED ${path.basename(file)}: ${err.trim().split('\n').pop()}`);
      }
      resolve();
    });
  });
}

// remember original names (they carry date + time of day) for labels
if (numbered) {
  const f = path.join(out, 'sources.json');
  let map = {};
  try { map = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {}
  for (const file of files) { const n = outName(file); if (n) map[n.replace('.mp4', '')] = path.basename(file); }
  fs.writeFileSync(f, JSON.stringify(map, null, 1));
}

const queue = [...files];
await Promise.all(Array.from({ length: Math.max(1, jobs) }, async () => {
  while (queue.length && !(budget && Date.now() - T0 > budget)) await run(queue.shift());
}));
const left = files.filter((f) => { const n = outName(f); return n && !fs.existsSync(path.join(out, n)); }).length;
console.log(left ? `paused: ${left} of ${files.length} still to do (run again to continue)` : `done: ${files.length} files -> ${out}`);
