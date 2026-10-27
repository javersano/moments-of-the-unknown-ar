// Compute MindAR feature points for a camera-like frame exactly the way the
// viewer does: 256px crops (CropDetector.detectMoving positions) on Rec.601 grey.
import sharp from 'sharp';
import { Detector, tf } from './mind.mjs';

export async function loadFrameGrey(file) {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const g = new Float32Array(info.width * info.height);
  for (let i = 0, j = 0; i < g.length; i++, j += 3) g[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  return { data: g, width: info.width, height: info.height };
}

export function cropSizeFor(w, h) {
  const minDimension = Math.min(w, h) / 2;
  return Math.pow(2, Math.round(Math.log(minDimension) / Math.log(2)));
}

// MindAR's 9 moving-crop positions, in its visiting order starting at index 4 (center)
export function cropPositions(w, h) {
  const c = cropSizeFor(w, h);
  const out = [];
  for (let n = 0; n < 9; n++) {
    const idx = (4 + n) % 9, dx = idx % 3, dy = Math.floor(idx / 3);
    let sy = Math.floor(h / 2 - c + dy * c / 2), sx = Math.floor(w / 2 - c + dx * c / 2);
    if (sx < 0) sx = 0; if (sy < 0) sy = 0;
    if (sx >= w - c) sx = w - c - 1; if (sy >= h - c) sy = h - c - 1;
    out.push([sx, sy]);
  }
  return { size: c, positions: out };
}

const dets = new Map();
export function detectCrops(frame, nCrops = 9) {
  const { size, positions } = cropPositions(frame.width, frame.height);
  if (!dets.has(size)) dets.set(size, new Detector(size, size));
  const det = dets.get(size);
  const full = tf.tensor(frame.data, [frame.height, frame.width]);
  const crops = positions.slice(0, nCrops).map(([sx, sy]) => {
    const pts = tf.tidy(() => det.detect(full.slice([sy, sx], [size, size])).featurePoints);
    for (const p of pts) { p.x += sx; p.y += sy; }
    return pts;
  });
  full.dispose();
  return crops;
}
