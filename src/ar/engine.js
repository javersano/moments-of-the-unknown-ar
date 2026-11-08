// AR engine: camera frames -> "which artwork + where" at any collection size.
//
// Per frame, MindAR's detector runs once. Its feature points feed two things:
//   1. the recognizer (bag of visual words vs. every artwork)  -> candidates
//   2. MindAR's matcher, but only against the 1-3 candidates   -> verified pose
// Once verified, MindAR's tracker follows the artwork frame-to-frame and
// detection pauses. Per-artwork target data (.mind) is fetched lazily and
// hot-swapped into a single long-lived controller.
import * as tf from '@tensorflow/tfjs';
import * as msgpack from '@msgpack/msgpack';
import { Controller } from 'mind-ar/src/image-target/controller.js';
import { Tracker } from 'mind-ar/src/image-target/tracker/tracker.js';
import { buildModelViewProjectionTransform, computeScreenCoordiate } from 'mind-ar/src/image-target/estimation/utils.js';
import { bagOfWords, scoreBag } from './recognizer.js';
import { CornerKalman, fitCorners, quadDistance, quadSize } from './smooth.js';

const DEFAULTS = {
  bagFrames: 6,          // recognition evidence window (frames)
  minScore: 0.035,       // below this the camera isn't looking at any artwork
  soloRatio: 1.35,       // top1/top2 above this -> verify only top1
  maxSlots: 3,           // artworks loaded into the matcher at once
  warmup: 2,             // tracked frames before showing
  // Where the film sits (see smooth.js; tuned with test/steady.mjs + test/tune-steady.mjs)
  fit: 'homography',     // corners from the tracked points ('homography', exact for a flat canvas) or the 3D pose ('pose')
  noise: 1,              // expected corner noise, camera px
  accel: 700,            // how sharply the painting may change speed on screen, px/s^2 (higher = follows faster, smooths less)
  coast: 0.2,            // s; through a drop, the film drifts on along its last motion and slows to a stop
  holdMs: 600,           // keep the film up this long through a tracking drop while the phone is steady...
  fastHoldMs: 60,        // ...but only this long if the painting was moving fast (it has gone somewhere else)
  fastSpeed: 80,         // px/s on screen that counts as moving fast
  cacheSize: 16,         // decoded .mind files kept in memory
  trackingKeyframe: 256, // 256: finer pose, more track points; 128: MindAR default, lighter
  minTrackedShare: 0.2,  // let go (and re-find) when fewer than this share of the painting's points still match.
                         // On a good lock about half or more match; a fast sweep that has slipped keeps only a few.
};

export class ArtworkEngine {
  constructor({ video, index, artworks, targetUrl, options = {}, onUpdate, onCandidates, onStats }) {
    this.video = video;
    this.index = index;               // deserialized recognizer index
    this.artworks = artworks;         // manifest entries, same order as index ids
    this.targetUrl = targetUrl;       // (i) => url of artwork i's .mind
    this.o = { ...DEFAULTS, ...options };
    this.onUpdate = onUpdate || (() => {});
    this.onCandidates = onCandidates || (() => {});
    this.onStats = onStats || (() => {});
    this.cache = new Map();           // artwork index -> Promise<dataList entry>
    this.slots = [];                  // artwork indexes currently in the matcher
    this.pending = null;              // slots requested, applied between frames
    this.bags = [];
    this.running = false;
    this.focus = -1;                  // artwork the user is looking at (sticky)
    this.clock = () => performance.now() / 1000; // seconds; the bench swaps in the clip's own clock
  }

  async start() {
    const { video } = this;
    this.w = video.videoWidth; this.h = video.videoHeight;
    video.width = this.w; video.height = this.h; // MindAR reads element width/height
    this.controller = new Controller({ inputWidth: this.w, inputHeight: this.h, maxTrack: 1 });
    // MindAR guesses "rotated input" when width/height look swapped, which is
    // always true for square frames. We restart on real orientation changes
    // instead, so load frames as-is.
    const il = this.controller.inputLoader;
    il.loadInput = function loadInput(input) {
      const ctx = this.context;
      ctx.drawImage(input, 0, 0, this.width, this.height);
      const backend = tf.backend();
      backend.gpgpu.uploadPixelDataToTexture(backend.getTexture(this.tempPixelHandle.dataId), ctx.canvas);
      return this._compileAndRun(this.program, [this.tempPixelHandle]);
    };
    // compile detector shaders now so the first real frame doesn't stall
    const t = this.controller.inputLoader.loadInput(video);
    this.controller.cropDetector.detect(t);
    t.dispose();
    this.state = this._freshState();
    this.running = true;
    this._loop();
  }

  stop() {
    this.running = false;
    if (this.controller) { this.controller.dispose(); this._disposeTracker(); }
  }

  /** Projection for the renderer (OpenGL column-major, input-pixel space). */
  projection() { return this.controller.getProjectionMatrix(); }

  // ---------------------------------------------------------------- targets
  _load(i) {
    if (!this.cache.has(i)) {
      const p = fetch(this.targetUrl(i)).then((r) => {
        if (!r.ok) throw new Error(`target ${i}: HTTP ${r.status}`);
        return r.arrayBuffer();
      }).then((buf) => {
        const d = msgpack.decode(new Uint8Array(buf)).dataList[0];
        // MindAR's Tracker always reads trackingData[1]; put the chosen keyframe there
        if (this.o.trackingKeyframe === 256 && d.trackingData.length > 1) d.trackingData = [d.trackingData[1], d.trackingData[0]];
        return d;
      });
      p.catch(() => this.cache.delete(i));
      this.cache.set(i, p);
      if (this.cache.size > this.o.cacheSize) {
        for (const k of this.cache.keys()) { if (!this.slots.includes(k)) { this.cache.delete(k); break; } }
      }
    }
    return this.cache.get(i);
  }

  async _request(slots) {
    const key = slots.join(',');
    if (key === this.slots.join(',') || key === this._requestedKey) return;
    this._requestedKey = key;
    try {
      const data = await Promise.all(slots.map((i) => this._load(i)));
      if (this._requestedKey === key) this.pending = { slots, data };
    } catch (e) {
      console.warn('[engine] target load failed', e);
      this._requestedKey = null;
    }
  }

  _disposeTracker() {
    const tr = this.controller && this.controller.tracker;
    if (!tr) return;
    tf.dispose([...tr.featurePointsListT, ...tr.imagePixelsListT, ...tr.imagePropertiesListT]);
    this.controller.tracker = null;
  }

  _applyPending(inputT) {
    const { slots, data } = this.pending;
    this.pending = null;
    const c = this.controller;
    const dims = data.map((d) => [d.targetImage.width, d.targetImage.height]);
    this._disposeTracker();
    c.tracker = new Tracker(dims, data.map((d) => d.trackingData), c.projectionTransform, this.w, this.h, false);
    c.worker.postMessage({
      type: 'setup', inputWidth: this.w, inputHeight: this.h,
      projectionTransform: c.projectionTransform, debugMode: false,
      matchingDataList: data.map((d) => d.matchingData),
    });
    c.markerDimensions = dims;
    if (!this._trackerWarm) { c.tracker.dummyRun(inputT); this._trackerWarm = true; }
    // keep tracking state if the tracked artwork survived the swap
    const prev = this.state.slot >= 0 ? this.slots[this.state.slot] : -1;
    this.slots = slots;
    const kept = slots.indexOf(prev);
    if (kept >= 0) this.state.slot = kept;
    else if (this.state.slot >= 0) { this._hide(); this.state = this._freshState(); }
  }

  // ------------------------------------------------------------ recognition
  _recognize(featurePoints) {
    const bag = bagOfWords(this.index, featurePoints);
    this.bags.push(bag);
    if (this.bags.length > this.o.bagFrames) this.bags.shift();
    const acc = new Map();
    for (const b of this.bags) for (const [w, c] of b) acc.set(w, (acc.get(w) || 0) + c);
    const s = scoreBag(this.index, acc);
    let a = -1, b = -1, c = -1;
    for (let i = 0; i < s.length; i++) {
      if (a < 0 || s[i] > s[a]) { c = b; b = a; a = i; }
      else if (b < 0 || s[i] > s[b]) { c = b; b = i; }
      else if (c < 0 || s[i] > s[c]) { c = i; }
    }
    const top = [a, b, c].filter((i) => i >= 0).map((i) => ({ i, score: s[i] }));
    this.lastTop = top;
    if (!top.length || top[0].score < this.o.minScore) return;
    const ratio = top[0].score / Math.max(1e-6, top[1] ? top[1].score : 0);
    const want = [top[0].i];
    if (ratio < this.o.soloRatio && top[1]) want.push(top[1].i);
    if (ratio < 1.12 && top[2]) want.push(top[2].i);
    // keep the most recently tracked artwork loaded for instant re-acquire
    if (this.focus >= 0 && !want.includes(this.focus) && want.length < this.o.maxSlots) want.push(this.focus);
    this.onCandidates(want, top, ratio);
    this._request(want);
  }

  /**
   * Reject a first lock whose pose can't be a real canvas: corners behind the
   * camera, a twisted (non-convex) outline, or a size far off the frame. Side-on
   * matches are the ones that occasionally produce these; dropping them costs a
   * frame, showing them would put the film in the wrong place.
   */
  _plausible(mvt, slot) {
    const c = this.controller;
    const [w, h] = c.markerDimensions[slot];
    const mvp = buildModelViewProjectionTransform(c.projectionTransform, mvt);
    const z = (x, y) => mvt[2][0] * x + mvt[2][1] * y + mvt[2][3];
    const corners = [[0, 0], [w, 0], [w, h], [0, h]];
    if (corners.some(([x, y]) => z(x, y) <= 0)) return false;
    const p = corners.map(([x, y]) => computeScreenCoordiate(mvp, x, y, 0));
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = p[i], b = p[(i + 1) % 4], d = p[(i + 2) % 4];
      const cr = (b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x);
      if (!Number.isFinite(cr) || Math.abs(cr) < 1) return false;
      if (sign && Math.sign(cr) !== sign) return false;
      sign = Math.sign(cr);
    }
    const area = Math.abs(p.reduce((s, q, i) => s + q.x * p[(i + 1) % 4].y - p[(i + 1) % 4].x * q.y, 0)) / 2;
    const frame = this.w * this.h;
    return area > frame * 0.01 && area < frame * 4;
  }

  // ------------------------------------------------------------------ loop
  _freshState() {
    const { noise, accel, coast } = this.o;
    return { slot: -1, tracking: false, showing: false, count: 0, lostAt: 0, mvt: null, fit: null, out: null,
      filter: new CornerKalman({ noise, accel, coast }) };
  }

  /** The painting's corners in camera pixels (TL, TR, BR, BL), straight from a pose. */
  _corners(mvt, slot) {
    const c = this.controller;
    const [w, h] = c.markerDimensions[slot];
    const mvp = buildModelViewProjectionTransform(c.projectionTransform, mvt);
    const q = new Float64Array(8);
    const pts = [[0, 0], [w, 0], [w, h], [0, h]];
    for (let k = 0; k < 4; k++) {
      const p = computeScreenCoordiate(mvp, pts[k][0], pts[k][1], 0);
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
      q[2 * k] = p.x; q[2 * k + 1] = p.y;
    }
    return q;
  }

  /** Unsmoothed corners for this frame: the homography fit, else the pose. */
  _raw(st) { return st.fit || this._corners(st.mvt, st.slot); }

  /** Smoothed corners for this frame. */
  _smooth(st, now) {
    const raw = this._raw(st);
    if (!raw) return st.out;
    // back from a drop somewhere else on screen: jump there rather than glide across
    if (st.out && st.fresh && quadDistance(raw, st.out) > 0.25 * quadSize(st.out)) st.filter.set(now, raw);
    st.fresh = false;
    return st.filter.filter(now, raw);
  }

  _hide() {
    const st = this.state;
    if (st.showing) {
      st.showing = false;
      this.onUpdate({ artwork: this.slots[st.slot], index: this.slots[st.slot], worldMatrix: null });
    }
  }

  async _loop() {
    const c = this.controller;
    let frames = 0, t0 = performance.now();
    while (this.running) {
      if (this.video.readyState < 2 || this.video.videoWidth !== this.w) {
        if (this.video.videoWidth && this.video.videoWidth !== this.w) { this.onStats({ resize: true }); return; }
        await tf.nextFrame();
        continue;
      }
      const inputT = c.inputLoader.loadInput(this.video);
      if (this.pending) this._applyPending(inputT);
      const st = this.state;

      if (!st.tracking) {
        const { featurePoints } = c.cropDetector.detectMoving(inputT);
        this._recognize(featurePoints);
        if (this.slots.length && c.tracker) {
          const { targetIndex, modelViewTransform } = await c._workerMatch(featurePoints, this.slots.map((_, k) => k));
          if (targetIndex !== -1 && this.running && this._plausible(modelViewTransform, targetIndex)) {
            if (st.showing && st.slot !== targetIndex) this._hide();
            if (st.slot !== targetIndex) { st.count = 0; st.filter.reset(); }
            st.slot = targetIndex; st.tracking = true; st.mvt = modelViewTransform;
          }
        }
      }

      if (st.tracking && c.tracker) {
        // MindAR's _trackAndUpdate, keeping the matched points for the corner fit
        const { worldCoords, screenCoords } = c.tracker.track(inputT, st.mvt, st.slot);
        st.matched = worldCoords.length;
        st.points = c.tracker.trackingKeyframeList[st.slot].points.length;
        const enough = worldCoords.length >= Math.max(4, this.o.minTrackedShare * st.points);
        const mvt = enough ? await c._workerTrackUpdate(st.mvt, { worldCoords, screenCoords }) : null;
        if (mvt === null) { st.tracking = false; st.fit = null; } else {
          st.mvt = mvt;
          const [w, h] = c.markerDimensions[st.slot];
          st.fit = this.o.fit === 'homography' ? fitCorners(worldCoords, screenCoords, w, h) : null;
        }
      }

      if (st.slot >= 0) {
        const now = this.clock();
        if (st.tracking) {
          if (st.lostAt) { st.lostAt = 0; st.fresh = true; }
          if (!st.showing && ++st.count > this.o.warmup) {
            st.showing = true; st.filter.reset(); st.out = null;
            this.focus = this.slots[st.slot];
            this.bags = [];
          }
        } else if (st.showing) {
          // most drops are a frame or two: keep the film up, drifting along its last motion.
          // If the painting was sweeping across the screen, let it go almost at once.
          if (!st.lostAt) { st.lostAt = now; st.lostFast = st.filter.speed() > this.o.fastSpeed; }
          const hold = (st.lostFast ? this.o.fastHoldMs : this.o.holdMs) / 1000;
          if (now - st.lostAt > hold) { this._hide(); st.count = 0; st.lostAt = 0; }
          else st.out = st.filter.coast(now) || st.out;
        } else {
          st.count = 0;
        }
        if (st.showing) {
          if (st.tracking || !st.out) st.out = this._smooth(st, now) || st.out;
          if (st.out) this.onUpdate({ index: this.slots[st.slot], corners: st.out, markerSize: c.markerDimensions[st.slot], tracking: st.tracking });
        }
      }

      inputT.dispose();
      frames++;
      const now = performance.now();
      if (now - t0 > 1000) {
        this.onStats({ fps: (frames * 1000) / (now - t0), slots: this.slots, top: this.lastTop, tensors: tf.memory().numTensors });
        frames = 0; t0 = now;
      }
      await tf.nextFrame();
    }
  }
}
