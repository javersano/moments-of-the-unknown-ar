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
import { DEFAULT_VIEWS, viewQuad, renderView, homography } from './lib/views.mjs';
// Tracking points are spaced 1/TRACK_OCC_DIV of the keyframe apart (MindAR: 1/10, which
// left most paintings with 25-50 points; see densify-tracking.mjs).
import { extract as extractTrackingPoints, TRACK_OCC_DIV } from './lib/track-extract.mjs';

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

function detectKeyframe(image, keep) {
  const det = detectorFor(image.width, image.height);
  let ps = tf.tidy(() => {
    const t = tf.tensor(image.data, [image.data.length], 'float32').reshape([image.height, image.width]);
    return det.detect(t).featurePoints;
  });
  if (keep) ps = ps.filter(keep);
  const maximaPoints = ps.filter((p) => p.maxima);
  const minimaPoints = ps.filter((p) => !p.maxima);
  return {
    maximaPoints, minimaPoints,
    maximaPointsCluster: buildCluster({ points: maximaPoints }),
    minimaPointsCluster: buildCluster({ points: minimaPoints }),
    width: image.width, height: image.height, scale: image.scale,
  };
}

// Keyframe scales that get oblique views: where a canvas sits in a phone frame
// from a normal viewing distance (roughly 250-550 px across in a 640x480 camera).
export const VIEW_SCALES = [0.5, 0.32];

/**
 * Compile one artwork. `views` adds keyframes rendered from oblique angles
 * (pipeline/lib/views.mjs) so recognition and the first lock work from the side,
 * not only head-on. Pass views: [] for a plain MindAR target.
 */
export function compileGrey(targetImage, { views = DEFAULT_VIEWS, viewScales = VIEW_SCALES } = {}) {
  const images = buildImageList(targetImage);
  const keyframes = images.map((image) => detectKeyframe(image));
  const W = targetImage.width, H = targetImage.height;
  for (const want of views.length ? viewScales : []) {
    const image = images.reduce((a, b) => (Math.abs(b.scale - want) < Math.abs(a.scale - want) ? b : a));
    for (const v of views) {
      const quad = viewQuad(image.width, image.height, v.yaw, v.pitch);
      const r = renderView(image, quad);
      const kf = detectKeyframe(r, (p) => r.inside[Math.round(p.y) * r.width + Math.round(p.x)] === 1);
      kf.scale = image.scale;
      kf.toWorld = homography(quad, [[0, 0], [W, 0], [W, H], [0, H]]);
      kf.view = [v.yaw, v.pitch];
      keyframes.push(kf);
    }
  }
  const trackingData = extractTrackingFeatures(buildTrackingImageList(targetImage), () => {});
  for (const t of trackingData) t.points = extractTrackingPoints({ data: t.data, width: t.width, height: t.height, scale: t.scale }, { occDiv: TRACK_OCC_DIV });
  return {
    targetImage: { width: W, height: H },
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
    if (!force && fs.existsSync(out) && fs.statSync(out).mtimeMs > fs.statSync(path.join(inDir, f)).mtimeMs) {
      console.log(`${id}  ${Math.round(fs.statSync(out).size / 1024)} KB  (already compiled)`);
      continue;
    }
    const t0 = Date.now();
    const target = compileGrey(await loadGrey(path.join(inDir, f)), process.argv.includes('--plain') ? { views: [] } : {});
    const buf = encodeMind([target]);
    fs.writeFileSync(out + '.tmp', buf);
    fs.renameSync(out + '.tmp', out);
    const pts = target.matchingData.reduce((a, k) => a + k.maximaPoints.length + k.minimaPoints.length, 0);
    console.log(`${id}  ${(buf.length / 1024).toFixed(0)} KB  ${pts} pts  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
}
