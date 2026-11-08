// Which artwork is this photo? Runs the recognizer over whole photos (not phone frames).
//   node pipeline/whichday.mjs <image>...
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { deserializeIndex, bagOfWords, scoreBag } from '../src/ar/recognizer.js';
import { Detector, tf } from './lib/mind.mjs';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/manifest.json')));
const index = deserializeIndex(new Uint8Array(fs.readFileSync(path.join(ROOT, 'public/index.bin'))));
for (const f of process.argv.slice(2)) {
  const { data, info } = await sharp(f).greyscale().resize({ width: 512, height: 512, fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
  const det = new Detector(info.width, info.height);
  const pts = tf.tidy(() => det.detect(tf.tensor(Float32Array.from(data), [info.height, info.width])).featurePoints);
  const s = scoreBag(index, bagOfWords(index, pts));
  const order = Array.from(s.keys()).sort((a, b) => s[b] - s[a]).slice(0, 4);
  console.log(path.basename(f).padEnd(16), order.map((i) => `${manifest.artworks[i].id} ${(manifest.artworks[i].title || '').slice(0, 22)} (${s[i].toFixed(3)})`).join(' | '));
}
