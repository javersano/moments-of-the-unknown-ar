// Synthetic viewpoints for angle-robust targets (the ASIFT idea, applied to MindAR).
//
// FREAK descriptors survive rotation and scale but not strong perspective, so a
// painting seen from the side stops matching its straight-on photo. At build time
// we render the artwork as a camera would see it from a few oblique angles, detect
// features on those renders, and store each render as an extra MindAR keyframe.
// The keyframe keeps its points in its OWN (warped) pixel space, so MindAR's Hough
// voting and RANSAC see a geometrically consistent view, and carries `toWorld`, a
// homography from that space back to the artwork, which src/ar/matcher.js applies
// when it reports world coordinates for pose estimation.

/** Solve the 3x3 homography (row-major, h33 = 1) mapping 4 src points onto 4 dst points. */
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  // Gaussian elimination with partial pivoting
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      if (!f) continue;
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = b.map((v, i) => v / A[i][i]);
  return [...h, 1];
}

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/**
 * Corners of a w x h artwork seen from (yaw, pitch) degrees, fitted into a w x h canvas.
 * Returns the 4 projected corners (TL, TR, BR, BL) in canvas pixels.
 */
export function viewQuad(w, h, yawDeg, pitchDeg, fill = 0.94) {
  const yaw = (yawDeg * Math.PI) / 180, pitch = (pitchDeg * Math.PI) / 180;
  const f = 1.2 * Math.max(w, h);           // ~ a phone camera a couple of metres from a 30x40" canvas
  const corners = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  const proj = corners.map(([X, Y]) => {
    // rotate the plane: yaw about the vertical axis, then pitch about the horizontal axis
    let x = X * Math.cos(yaw), z = X * Math.sin(yaw), y = Y;
    const y2 = y * Math.cos(pitch) - z * Math.sin(pitch);
    const z2 = y * Math.sin(pitch) + z * Math.cos(pitch);
    const d = f + z2;
    return [(f * x) / d, (f * y2) / d];
  });
  const xs = proj.map((p) => p[0]), ys = proj.map((p) => p[1]);
  const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
  const s = fill * Math.min(w / bw, h / bh);
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  return proj.map(([x, y]) => [w / 2 + (x - cx) * s, h / 2 + (y - cy) * s]);
}

/**
 * Render `img` (grey, {data,width,height}) through the view; returns the warped
 * image (same size, neutral grey outside the artwork) and an inside-mask eroded
 * by `margin` px so features on the artificial border can be dropped.
 */
export function renderView(img, quad, margin = 6) {
  const { width: w, height: h, data } = img;
  const Hinv = homography(quad, [[0, 0], [w, 0], [w, h], [0, h]]); // canvas -> image
  const out = new Float32Array(w * h);
  const inside = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [sx, sy] = applyH(Hinv, x + 0.5, y + 0.5);
      const i = y * w + x;
      if (sx < margin || sy < margin || sx > w - margin || sy > h - margin) { out[i] = 128; continue; }
      const x0 = Math.floor(sx - 0.5), y0 = Math.floor(sy - 0.5);
      const fx = sx - 0.5 - x0, fy = sy - 0.5 - y0;
      const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
      const a = data[y0 * w + x0], b = data[y0 * w + x1], c = data[y1 * w + x0], d = data[y1 * w + x1];
      out[i] = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
      inside[i] = 1;
    }
  }
  return { data: out, width: w, height: h, inside };
}

// Default viewpoints: side-on both ways at two strengths, plus looking up / down.
export const DEFAULT_VIEWS = [
  { yaw: 40, pitch: 0 }, { yaw: -40, pitch: 0 },
  { yaw: 60, pitch: 0 }, { yaw: -60, pitch: 0 },
  { yaw: 0, pitch: 35 }, { yaw: 0, pitch: -35 },
];
