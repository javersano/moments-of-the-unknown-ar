// Compile each artwork image into its own MindAR target file (<id>.mind).
//
//   node pipeline/compile-targets.mjs <images-dir> <out-dir> [--shard=i/n] [--force]
//
// One small .mind per artwork (instead of one giant file for all of them) is
// what lets the viewer scale to hundreds of works: it only ever downloads and
// tracks the 1-3 candidates the recognizer proposes.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import * as msgpack from '@msgpack/msgpack';
import { Detector, buildImageList, buildTrackingImageList, buildCluster, extractTrackingFeatures, tf } from './lib/mind.mjs';

export const TARGET_SIZE = 1024; // compile resolution (long side); 4:3 works -> 1024x768

// Grey exactly like the runtime camera loader (Rec.601 luma), so the
// descriptors stored for a painting match what the phone computes from video.
export async function loadGrey(file, size = TARGET_SIZE) {
  const { data, info } = await sharp(file).rotate().resize({ width: size, height: size, fit: 'inside' })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const grey = new Uint8Array(info.width * info.height);
  for (let i = 0, j = 0; i < grey.length; i++, j += 3) {
    grey[i] = Math.round(0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]);
  }
  return { data: grey, width: info.width, height: info.height };
}

const detectors = new Map(); // reuse per size: kernels + caches are size-specific
function detectorFor(w, h) {
  const k = `${w}x${h}`;
  if (!detectors.has(k)) detectors.set(k, new Detector(w, h));
  return detectors.get(k);
}

export function compileGrey(targetImage) {
  const keyframes = [];
  for (const image of buildImageList(targetImage)) {
    const det = detectorFor(image.width, image.height);
    const ps = tf.tidy(() => {
      const t = tf.tensor(image.data, [image.data.length], 'float32').reshape([image.height, image.width]);
      return det.detect(t).featurePoints;
    });
    const maximaPoints = ps.filter((p) => p.maxima);
    const minimaPoints = ps.filter((p) => !p.maxima);
    keyframes.push({
      maximaPoints, minimaPoints,
      maximaPointsCluster: buildCluster({ points: maximaPoints }),
      minimaPointsCluster: buildCluster({ points: minimaPoints }),
      width: image.width, height: image.height, scale: image.scale,
    });
  }
  const trackingData = extractTrackingFeatures(buildTrackingImageList(targetImage), () => {});
  return {
    targetImage: { width: targetImage.width, height: targetImage.height },
    trackingData,
    matchingData: keyframes,
  };
}

export const encodeMind = (dataList) => msgpack.encode({ v: 2, dataList });

if (import.meta.url === `file://${process.argv[1]}`) {
  const [inDir, outDir] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const shardArg = process.argv.find((a) => a.startsWith('--shard='));
  const force = process.argv.includes('--force');
  const [si, sn] = shardArg ? shardArg.slice(8).split('/').map(Number) : [0, 1];
  fs.mkdirSync(outDir, { recursive: true });
  const files = fs.readdirSync(inDir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort()
    .filter((_, i) => i % sn === si);
  for (const f of files) {
    const id = path.parse(f).name;
    const out = path.join(outDir, `${id}.mind`);
    if (!force && fs.existsSync(out) && fs.statSync(out).mtimeMs > fs.statSync(path.join(inDir, f)).mtimeMs) continue;
    const t0 = Date.now();
    const target = compileGrey(await loadGrey(path.join(inDir, f)));
    const buf = encodeMind([target]);
    fs.writeFileSync(out + '.tmp', buf);
    fs.renameSync(out + '.tmp', out);
    const pts = target.matchingData.reduce((a, k) => a + k.maximaPoints.length + k.minimaPoints.length, 0);
    console.log(`${id}  ${(buf.length / 1024).toFixed(0)} KB  ${pts} pts  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
}
