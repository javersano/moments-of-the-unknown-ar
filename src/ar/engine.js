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
import { OneEuroFilter } from 'mind-ar/src/libs/one-euro-filter.js';
import { bagOfWords, scoreBag } from './recognizer.js';

const DEFAULTS = {
  bagFrames: 6,          // recognition evidence window (frames)
  minScore: 0.035,       // below this the camera isn't looking at any artwork
  soloRatio: 1.35,       // top1/top2 above this -> verify only top1
  maxSlots: 3,           // artworks loaded into the matcher at once
  warmup: 2,             // tracked frames before showing
  missTolerance: 8,      // lost frames before hiding
  filterMinCF: 0.0005,
  filterBeta: 0.25,
  cacheSize: 16,         // decoded .mind files kept in memory
  trackingKeyframe: 256, // 256: finer pose, more track points; 128: MindAR default, lighter
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

  // ------------------------------------------------------------------ loop
  _freshState() {
    return { slot: -1, tracking: false, showing: false, count: 0, miss: 0, mvt: null,
      filter: new OneEuroFilter({ minCutOff: this.o.filterMinCF, beta: this.o.filterBeta }) };
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
          if (targetIndex !== -1 && this.running) {
            if (st.showing && st.slot !== targetIndex) this._hide();
            if (st.slot !== targetIndex) { st.count = 0; st.filter.reset(); }
            st.slot = targetIndex; st.tracking = true; st.mvt = modelViewTransform;
          }
        }
      }

      if (st.tracking && c.tracker) {
        const mvt = await c._trackAndUpdate(inputT, st.mvt, st.slot);
        if (mvt === null) st.tracking = false; else st.mvt = mvt;
      }

      if (st.slot >= 0) {
        if (st.tracking) {
          st.miss = 0;
          if (!st.showing && ++st.count > this.o.warmup) {
            st.showing = true; st.filter.reset();
            this.focus = this.slots[st.slot];
            this.bags = [];
          }
        } else if (st.showing && ++st.miss > this.o.missTolerance) {
          this._hide();
          st.count = 0;
        } else if (!st.showing) {
          st.count = 0;
        }
        if (st.showing) {
          const m = c._glModelViewMatrix(st.mvt, st.slot);
          const f = st.filter.filter(Date.now(), m);
          this.onUpdate({ index: this.slots[st.slot], worldMatrix: f.slice(), markerSize: c.markerDimensions[st.slot], tracking: st.tracking });
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
