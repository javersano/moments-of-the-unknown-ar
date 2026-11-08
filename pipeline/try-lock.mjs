// Does a photo lock onto given targets? node pipeline/try-lock.mjs <targets-dir> <photo>...
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import * as msgpack from '@msgpack/msgpack';
import { Detector, tf } from './lib/mind.mjs';
import { Matcher } from '../src/ar/matcher.js';
const [dir, ...photos] = process.argv.slice(2);
const targets = fs.readdirSync(dir).filter((f) => f.endsWith('.mind')).sort().map((f) => [f.replace('.mind', ''), msgpack.decode(fs.readFileSync(path.join(dir, f))).dataList[0].matchingData]);
for (const p of photos) {
  const row = [];
  for (const W of [320, 480]) {
    const { data, info } = await sharp(p).greyscale().resize({ width: W, height: W, fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
    const det = new Detector(info.width, info.height);
    const pts = tf.tidy(() => det.detect(tf.tensor(Float32Array.from(data), [info.height, info.width])).featurePoints);
    const m = new Matcher(info.width, info.height);
    for (const [id, kfs] of targets) {
      const r = m.matchDetection(kfs, pts);
      if (r.keyframeIndex !== -1) row.push(`${id}@${W}(${r.screenCoords.length})`);
    }
  }
  console.log(path.basename(p).padEnd(16), row.join(' ') || '—');
}
