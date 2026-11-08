// Steadying the film on the canvas.
//
// We work with what the visitor actually sees: the painting's four corners on
// the screen, in camera pixels. They are fitted straight from the tracked points
// (fitCorners), smoothed together (CornerKalman), and the film is drawn as the
// exact homography onto them, so it always lies flat on the canvas.

/**
 * Constant-velocity Kalman filter on the four corners. The corners move
 * together, so one covariance (and one gain) serves all eight numbers.
 *
 * Unlike a plain low-pass, it follows a moving painting without trailing
 * behind: it learns the motion and only smooths the noise around it.
 */
export class CornerKalman {
  /**
   * @param {object} o
   * @param {number} o.noise  expected corner noise from the tracker, px
   * @param {number} o.accel  how sharply the painting may change speed on screen, px/s^2
   *                          (higher = follows faster, smooths less; only accel/noise matters)
   * @param {number} o.coast  s, how quickly the motion dies away while the tracker has lost the painting
   */
  constructor({ noise = 1, accel = 700, coast = 0.2 } = {}) {
    Object.assign(this, { R: noise * noise, Q: accel * accel, coastTau: coast });
    this.reset();
  }

  reset() { this.x = null; this.v = new Float64Array(8); this.t = 0; this.P = [0, 0, 0]; }

  /** Start from these corners, speed unknown. */
  set(t, q) {
    this.x = Float64Array.from(q); this.v.fill(0); this.t = t;
    this.P = [this.R, 0, this.Q * 0.01];
  }

  /** t in seconds, q = [x0,y0, x1,y1, x2,y2, x3,y3] in camera px -> smoothed copy */
  filter(t, q) {
    if (!this.x) { this.set(t, q); return Float64Array.from(this.x); }
    const dt = t - this.t;
    if (!(dt > 0)) return Float64Array.from(this.x);
    this.t = t;
    // predict
    for (let i = 0; i < 8; i++) this.x[i] += this.v[i] * dt;
    const [a, b, c] = this.P, dt2 = dt * dt, Q = this.Q;
    const p11 = a + 2 * dt * b + dt2 * c + Q * dt2 * dt2 / 4, p12 = b + dt * c + Q * dt2 * dt / 2, p22 = c + Q * dt2;
    // correct
    const S = p11 + this.R, k1 = p11 / S, k2 = p12 / S;
    for (let i = 0; i < 8; i++) {
      const y = q[i] - this.x[i];
      this.x[i] += k1 * y;
      this.v[i] += k2 * y;
    }
    this.P = [(1 - k1) * p11, (1 - k1) * p12, p22 - k2 * p12];
    return Float64Array.from(this.x);
  }

  /** Tracker lost the painting: carry on along the last motion, slowing to a stop. */
  coast(t) {
    if (!this.x) return null;
    const dt = t - this.t;
    if (dt > 0) {
      const decay = Math.exp(-dt / this.coastTau);
      const travel = this.coastTau * (1 - decay); // distance covered by a decaying speed, per unit speed
      for (let i = 0; i < 8; i++) { this.x[i] += this.v[i] * travel; this.v[i] *= decay; }
      this.t = t;
      const [a, b, c] = this.P;
      this.P = [a + this.Q * dt ** 4 / 4, b, c + this.Q * dt * dt];
    }
    return Float64Array.from(this.x);
  }

  /** How fast the painting is moving on screen, px/s (mean corner velocity). */
  speed() {
    let mx = 0, my = 0;
    for (let k = 0; k < 4; k++) { mx += this.v[2 * k] / 4; my += this.v[2 * k + 1] / 4; }
    return Math.hypot(mx, my);
  }
}

/** Largest distance (px) between two corner sets. */
export function quadDistance(a, b) {
  let d = 0;
  for (let k = 0; k < 4; k++) d = Math.max(d, Math.hypot(a[2 * k] - b[2 * k], a[2 * k + 1] - b[2 * k + 1]));
  return d;
}

/** Diagonal length (px) of a corner set. */
export const quadSize = (q) => Math.hypot(q[4] - q[0], q[5] - q[1]);

/**
 * The painting's corners on screen, fitted straight from the tracker's matched
 * points (painting coordinates -> camera pixels) as a plane-to-image homography.
 *
 * MindAR turns those points into a rigid 3D pose using an assumed lens (45 degree
 * field of view). Real phone lenses differ, so the pose can't quite reproduce
 * what the camera sees, and the film's corners sit a few pixels off, worst at an
 * angle. A homography needs no lens model: it is exact for any flat canvas.
 * Least squares (normalised, one pass of outlier rejection). Returns null when
 * there are too few points or the fit is degenerate.
 */
export function fitCorners(world, screen, w, h, minPoints = 12) {
  const n = world.length;
  if (n < minPoints) return null;
  let keep = null;
  for (let pass = 0; pass < 2; pass++) {
    const H = fitHomography(world, screen, keep);
    if (!H) return null;
    if (pass === 1) return project(H, w, h);
    // drop points far off the first fit, then refit
    const r = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = apply(H, world[i].x, world[i].y);
      r[i] = p ? Math.hypot(p[0] - screen[i].x, p[1] - screen[i].y) : Infinity;
    }
    const sorted = Float64Array.from(r).sort();
    const cut = Math.max(2, 3 * sorted[n >> 1]);
    keep = [];
    for (let i = 0; i < n; i++) if (r[i] <= cut) keep.push(i);
    if (keep.length < minPoints) return project(H, w, h);
  }
  return null;
}

function apply(H, x, y) {
  const d = H[6] * x + H[7] * y + H[8];
  if (!(Math.abs(d) > 1e-12)) return null;
  return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d];
}

function project(H, w, h) {
  const q = new Float64Array(8);
  const pts = [[0, 0], [w, 0], [w, h], [0, h]];
  for (let k = 0; k < 4; k++) {
    const p = apply(H, pts[k][0], pts[k][1]);
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
    q[2 * k] = p[0]; q[2 * k + 1] = p[1];
  }
  return q;
}

function fitHomography(world, screen, idx) {
  const ids = idx || world.map((_, i) => i);
  const m = ids.length;
  // normalise both point sets (Hartley): centroid at 0, mean distance sqrt(2)
  let wx = 0, wy = 0, sx = 0, sy = 0;
  for (const i of ids) { wx += world[i].x; wy += world[i].y; sx += screen[i].x; sy += screen[i].y; }
  wx /= m; wy /= m; sx /= m; sy /= m;
  let wd = 0, sd = 0;
  for (const i of ids) { wd += Math.hypot(world[i].x - wx, world[i].y - wy); sd += Math.hypot(screen[i].x - sx, screen[i].y - sy); }
  if (!(wd > 0) || !(sd > 0)) return null;
  const ws = Math.SQRT2 * m / wd, ss = Math.SQRT2 * m / sd;
  // normal equations for h (h8 = 1)
  const A = new Float64Array(64), b = new Float64Array(8), row = new Float64Array(8);
  const add = (r, t) => {
    for (let a = 0; a < 8; a++) { if (!r[a]) continue; b[a] += r[a] * t; for (let c = 0; c < 8; c++) A[a * 8 + c] += r[a] * r[c]; }
  };
  for (const i of ids) {
    const x = (world[i].x - wx) * ws, y = (world[i].y - wy) * ws;
    const u = (screen[i].x - sx) * ss, v = (screen[i].y - sy) * ss;
    row.set([x, y, 1, 0, 0, 0, -x * u, -y * u]); add(row, u);
    row.set([0, 0, 0, x, y, 1, -x * v, -y * v]); add(row, v);
  }
  const hn = solve8(A, b);
  if (!hn) return null;
  const N = [hn[0], hn[1], hn[2], hn[3], hn[4], hn[5], hn[6], hn[7], 1];
  // H = Ts^-1 * N * Tw
  const Tw = [ws, 0, -ws * wx, 0, ws, -ws * wy, 0, 0, 1];
  const Tsi = [1 / ss, 0, sx, 0, 1 / ss, sy, 0, 0, 1];
  return mul3(Tsi, mul3(N, Tw));
}

function mul3(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}

function solve8(A, b) { // Gaussian elimination with partial pivoting
  const M = Float64Array.from(A), x = Float64Array.from(b);
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(M[r * 8 + c]) > Math.abs(M[p * 8 + c])) p = r;
    if (Math.abs(M[p * 8 + c]) < 1e-12) return null;
    if (p !== c) { for (let k = 0; k < 8; k++) { const t = M[c * 8 + k]; M[c * 8 + k] = M[p * 8 + k]; M[p * 8 + k] = t; } const t = x[c]; x[c] = x[p]; x[p] = t; }
    for (let r = c + 1; r < 8; r++) {
      const f = M[r * 8 + c] / M[c * 8 + c];
      if (!f) continue;
      for (let k = c; k < 8; k++) M[r * 8 + k] -= f * M[c * 8 + k];
      x[r] -= f * x[c];
    }
  }
  for (let r = 7; r >= 0; r--) {
    let s = x[r];
    for (let k = r + 1; k < 8; k++) s -= M[r * 8 + k] * x[k];
    x[r] = s / M[r * 8 + r];
  }
  return x;
}
