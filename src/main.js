import {
  WebGLRenderer, Scene, Camera, Mesh, PlaneGeometry, MeshBasicMaterial,
  VideoTexture, Matrix4, SRGBColorSpace, LinearFilter,
  BufferGeometry, Float32BufferAttribute, LineSegments, LineBasicMaterial, Color,
} from 'three';
import '@fontsource/playfair-display/400.css';
import '@fontsource/playfair-display/400-italic.css';
import '@fontsource/playfair-display-sc/400.css';
import '@fontsource/playfair-display-sc/700.css';
import './styles.css';
import { deserializeIndex } from './ar/recognizer.js';
import { ArtworkEngine } from './ar/engine.js';
import { Media } from './media.js';
import { screenshot, save, Recorder } from './capture.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
const MANIFEST_URL = new URL(params.get('manifest') || './manifest.json', location.href);
const FADE_MS = 600;
// ?debug&engine={"accel":1200} tries engine settings on a phone without a rebuild
const ENGINE_OVERRIDES = (() => { try { return DEBUG && params.get('engine') ? JSON.parse(params.get('engine')) : {}; } catch (e) { return {}; } })();

// ------------------------------------------------------------------ debug
const debugEl = $('debug');
const logs = [];
const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log('[motu]', line);
  logs.push(line); if (logs.length > 12) logs.shift();
};
if (DEBUG) debugEl.classList.add('visible');
window.addEventListener('error', (e) => log('ERROR', e.message));
window.addEventListener('unhandledrejection', (e) => log('REJECT', String(e.reason && e.reason.message || e.reason)));

// ------------------------------------------------------------------ ui bits
const hintEl = $('hint');
const hint = (t) => { if (hintEl.textContent !== t) hintEl.textContent = t; };
const toastEl = $('toast');
function toast(msg, ms = 1800) {
  toastEl.textContent = msg; toastEl.classList.add('visible');
  clearTimeout(toast.t); toast.t = setTimeout(() => toastEl.classList.remove('visible'), ms);
}
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};

// ------------------------------------------------------------------ boot: manifest + index
const startBtn = $('start');
const startLabel = startBtn.querySelector('.label');
let manifest, artworks, index;

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const out = new Uint8Array(total);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > out.length) { // content-length was compressed size
      const bigger = new Uint8Array(Math.max(out.length * 2, got + value.length));
      bigger.set(out.subarray(0, got)); return finishGrow(bigger, got, value, reader, onProgress);
    }
    out.set(value, got); got += value.length;
    onProgress(got / total);
  }
  return out.subarray(0, got);
}
async function finishGrow(buf, got, value, reader, onProgress) {
  const chunks = [buf.subarray(0, got), value];
  for (;;) { const { done, value: v } = await reader.read(); if (done) break; chunks.push(v); onProgress(0.9); }
  const n = chunks.reduce((a, c) => a + c.length, 0), out = new Uint8Array(n);
  let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

const resolveUrl = (p) => (p ? new URL(p, MANIFEST_URL).href : null);

async function boot() {
  manifest = await (await fetch(MANIFEST_URL, { cache: 'no-cache' })).json();
  artworks = manifest.artworks.map((a) => ({
    ...a, video: resolveUrl(a.video), poster: resolveUrl(a.poster), audio: resolveUrl(a.audio), target: resolveUrl(a.target),
  }));
  const progress = (p) => startBtn.style.setProperty('--p', `${Math.round(p * 100)}%`);
  const canInflate = typeof DecompressionStream !== 'undefined';
  let bin = await fetchWithProgress(resolveUrl(canInflate || !manifest.indexRaw ? manifest.index : manifest.indexRaw), progress);
  if (bin[0] === 0x1f && bin[1] === 0x8b) { // gzip magic: inflate (unless the host already did)
    const s = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
    bin = new Uint8Array(await new Response(s).arrayBuffer());
  }
  index = deserializeIndex(bin);
  if (typeof manifest.volume === 'number') media.volume = manifest.volume;
  if (index.ids.length !== artworks.length) throw new Error('index/manifest mismatch — rebuild');
  log(`ready: ${artworks.length} artworks`);
  startBtn.disabled = false;
  startLabel.textContent = 'Start';
}
boot().catch((e) => { log('boot failed', e.message); startLabel.textContent = 'Could not load — retry'; startBtn.disabled = false; startBtn.dataset.retry = '1'; });

// ------------------------------------------------------------------ renderer
const camera = $('camera');
const glCanvas = $('gl');
const renderer = new WebGLRenderer({ canvas: glCanvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.outputColorSpace = SRGBColorSpace;
const scene = new Scene();
// The film is drawn straight onto the painting's four on-screen corners (a
// homography in clip space), so the camera is the identity.
const cam3 = new Camera();
const material = new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
const plane = new Mesh(new PlaneGeometry(1, 1), material);
plane.matrixAutoUpdate = false;
plane.frustumCulled = false;
plane.visible = false;
scene.add(plane);
const cornerMat = new LineBasicMaterial({ color: new Color('#ECE2D2'), transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
const corners = new LineSegments(new BufferGeometry(), cornerMat);
corners.matrixAutoUpdate = false;
corners.frustumCulled = false;
corners.visible = false;
scene.add(corners);
function cornerGeometry(aspect) { // plane is 1 wide, `aspect` (h/w) tall, centred
  const v = [], hw = 0.5, hh = aspect / 2, L = 0.07;
  for (const o of [0.018, 0.03]) { // two strokes = a double rule
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const x = sx * (hw + o), y = sy * (hh + o);
      v.push(x, y, 0, x - sx * L, y, 0, x, y, 0, x, y - sy * L, 0);
    }
  }
  const g = new BufferGeometry(); g.setAttribute('position', new Float32BufferAttribute(v, 3)); return g;
}
const textures = new Map(); // video element -> VideoTexture

function textureFor(el) {
  if (!textures.has(el)) {
    const t = new VideoTexture(el);
    t.colorSpace = SRGBColorSpace; t.minFilter = LinearFilter; t.magFilter = LinearFilter; t.generateMipmaps = false;
    textures.set(el, t);
  }
  return textures.get(el);
}

function fitTexture(tex, art, el, planeAspect) {
  const fit = art.fit || {};
  const va = art.videoAspect || (el.videoWidth ? el.videoWidth / el.videoHeight : 4 / 3);
  let rx = 1, ry = 1;
  if ((fit.mode || 'cover') === 'cover') {
    if (va > planeAspect) rx = planeAspect / va; else ry = va / planeAspect;
  }
  const z = fit.zoom || 1;
  rx /= z; ry /= z;
  tex.repeat.set(rx, ry);
  tex.offset.set((1 - rx) / 2 + (fit.dx || 0), (1 - ry) / 2 + (fit.dy || 0));
}

let engine = null;
// camera pixels -> clip space: the camera fills the screen ("cover"), centred
const view = { kx: 0, ky: 0, ox: 0, oy: 0 };
function layout() {
  const cw = window.innerWidth, ch = window.innerHeight;
  renderer.setSize(cw, ch, false);
  const vw = camera.videoWidth, vh = camera.videoHeight;
  if (!vw) return;
  const s = Math.max(cw / vw, ch / vh), left = (cw - vw * s) / 2, top = (ch - vh * s) / 2;
  Object.assign(camera.style, { width: `${vw * s}px`, height: `${vh * s}px`, left: `${left}px`, top: `${top}px` });
  Object.assign(view, { kx: (2 * s) / cw, ox: (2 * left) / cw - 1, ky: (-2 * s) / ch, oy: 1 - (2 * top) / ch });
}
window.addEventListener('resize', layout);

/**
 * Matrix that lays the plane (1 wide, `aspect` tall, centred, y up) exactly onto
 * the quad q = [TL, TR, BR, BL] in camera pixels, perspective-correct.
 * Returns false for a degenerate quad.
 */
function quadMatrix(q, aspect, out) {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = q;
  // unit square -> quad (Heckbert): u runs along the top edge, v down the side
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const den = dx1 * dy2 - dx2 * dy1;
  if (!den) return false;
  const g = (sx * dy2 - dx2 * sy) / den, h = (dx1 * sy - sx * dy1) / den;
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, c = x0;
  const d = y1 - y0 + g * y1, e = y3 - y0 + h * y3, f = y0;
  // plane (X, Y) -> (u, v) = (X + 1/2, 1/2 - Y / aspect)
  const ia = -1 / aspect;
  const H = [a, b * ia, (a + b) / 2 + c, d, e * ia, (d + e) / 2 + f, g, h * ia, (g + h) / 2 + 1];
  if (H[8] <= 0) return false; // the centre must be in front
  // camera pixels -> clip
  const { kx, ky, ox, oy } = view;
  out.set(
    kx * H[0] + ox * H[6], kx * H[1] + ox * H[7], 0, kx * H[2] + ox * H[8],
    ky * H[3] + oy * H[6], ky * H[4] + oy * H[7], 0, ky * H[5] + oy * H[8],
    0, 0, 1, 0,
    H[6], H[7], 0, H[8],
  );
  return true;
}

// ------------------------------------------------------------------ app state
const media = new Media({ videos: 3, volume: 0.5, log });
let current = null;        // artwork currently anchored
let currentEl = null;      // its video element
let planeAspect = 4 / 3;
let quad = null;           // latest smoothed corners of the painting (camera pixels)
let showing = false;
let opacity = 0;
let userOpacity = store.get('opacity', 100);
let poet = store.get('poet', false);
let poetMin = store.get('poetMin', false);  // journal folded down to the slim bar
let poetArt = null;        // whose journal and reading Poet Mode is on
let muted = store.get('muted', false);
let paused = false;
const quadM = new Matrix4();

function onUpdate({ index: i, corners: q, markerSize }) {
  const art = artworks[i];
  if (!q) {
    if (current === art) {
      // the film fades; a Poet Mode reading carries on until you leave it or find another painting
      showing = false; media.release(art);
      document.body.classList.add('searching');
      hint('Point at a painting — hold steady');
    }
    return;
  }
  const isNew = current !== art;
  if (isNew) {
    if (current) media.release(current);
    current = art; paused = false;
    const el = currentEl = media.video(art);
    media.pinned = art.id;
    material.map = textureFor(el);
    const [w, h] = markerSize;
    planeAspect = w / h;
    plane.geometry.dispose();
    plane.geometry = new PlaneGeometry(1, h / w);
    corners.geometry.dispose();
    corners.geometry = cornerGeometry(h / w);
    fitTexture(material.map, art, el, planeAspect);
    material.needsUpdate = true;
    $('caption').textContent = art.label || '';
    $('title').textContent = art.title || '';
    log('found', art.id);
  }
  if (!showing) {
    showing = true;
    document.body.classList.remove('searching');
    media.play(art, { restart: isNew }).then((el) => { if (current === art) fitTexture(material.map, art, el, planeAspect); });
    if (poet) listenTo(art);
  }
  quad = q;
}

// ------------------------------------------------------------------ Poet Mode
// The journal follows the painting you're at. Losing the painting for a moment
// (a hand moves, someone walks past) never stops the reading.
function poetPanel() {
  const open = poet && !!poetArt && !!(poetArt.diary || poetArt.audio);
  document.body.classList.toggle('poet-open', open);
  document.body.classList.toggle('poet-min', open && poetMin);
}
function listenTo(art) {
  if (poetArt !== art) {
    poetArt = art;
    $('diary-caption').textContent = art.label || '';
    $('diary-title').textContent = $('bar-title').textContent = art.title || art.label || '';
    $('bar-caption').textContent = art.label || '';
    $('diary-body').textContent = art.diary || '';
    $('diary-body').scrollTop = 0;
  }
  media.narrate(art);
  poetPanel();
}

const narrProgress = $('narr-progress'), barProgress = $('bar-progress');
let last = performance.now();
function frame(now) {
  const dt = Math.min(64, now - last); last = now;
  // ready once the film has shown a frame; a looping film dips for an instant at its start, ignore that
  const ready = currentEl && (currentEl.readyState >= 2 || (!!currentEl.loadedSrc && currentEl.loadedSrc === currentEl.src));
  const target = showing && ready ? userOpacity / 100 : 0;
  const step = dt / (showing ? FADE_MS : 220);
  opacity += Math.sign(target - opacity) * Math.min(Math.abs(target - opacity), step);
  material.opacity = opacity;
  const placed = !!quad && quadMatrix(quad, 1 / planeAspect, quadM);
  plane.visible = corners.visible = opacity > 0.001 && placed;
  cornerMat.opacity = Math.min(1, opacity * 1.2);
  if (placed) { plane.matrix.copy(quadM); corners.matrix.copy(quadM); }
  if (poetArt) {
    const n = media.narration;
    narrProgress.style.width = barProgress.style.width = n.duration ? `${(100 * n.currentTime / n.duration).toFixed(1)}%` : '0%';
  }
  renderer.render(scene, cam3);
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ start
async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: 'environment' }, // browser default (~640x480) keeps detection fast
  });
  camera.srcObject = stream;
  await new Promise((r) => (camera.readyState >= 1 ? r() : camera.addEventListener('loadedmetadata', r, { once: true })));
  await camera.play().catch(() => {});
  log(`camera ${camera.videoWidth}x${camera.videoHeight}`);
}

async function startEngine() {
  const cache = engine ? engine.cache : null;
  if (engine) engine.stop();
  engine = new ArtworkEngine({
    video: camera, index, artworks,
    targetUrl: (i) => artworks[i].target,
    options: { ...(manifest.engine || {}), ...ENGINE_OVERRIDES },
    onUpdate,
    onCandidates: (want, top, ratio) => {
      if (showing) return;
      if (ratio > 1.15) { media.prepare(artworks[want[0]]); hint('Hold steady…'); }
    },
    onStats: (s) => {
      if (s.resize) { log('camera resized → restart'); startEngine(); return; }
      if (DEBUG) {
        const top = (s.top || []).map((t) => `${artworks[t.i].id}:${t.score.toFixed(3)}`).join(' ');
        debugEl.textContent = `fps ${s.fps.toFixed(1)}  tensors ${s.tensors}\nslots ${s.slots.map((i) => artworks[i].id).join(',')}\ntop ${top}\n${logs.join('\n')}`;
      }
    },
  });
  if (cache) engine.cache = cache;
  await engine.start();
  layout();
}

startBtn.addEventListener('click', async () => {
  if (startBtn.dataset.retry) { location.reload(); return; }
  media.prime();                      // must happen synchronously in the tap
  startBtn.disabled = true; startLabel.textContent = 'Starting camera…';
  try {
    await startCamera();
  } catch (e) {
    log('camera failed', e.name, e.message);
    startBtn.disabled = false;
    startLabel.textContent = 'Allow camera & retry';
    $('intro-note').textContent = e.name === 'NotAllowedError'
      ? 'Camera access was blocked. In Settings › Safari › Camera, choose Allow, then reload.'
      : 'This browser could not open the camera. Try Safari on iPhone or Chrome on Android.';
    return;
  }
  await startEngine();
  $('intro').classList.add('gone');
  document.body.classList.add('running', 'searching');
  media.setMuted(muted);
  requestWakeLock();
  requestAnimationFrame(frame);
});

// any tap lets iOS play sound again: bring back whatever should be playing
for (const ev of ['touchend', 'click']) {
  document.addEventListener(ev, () => { if (document.body.classList.contains('running')) media.unlock(); }, { capture: true, passive: true });
}

// keep the screen awake while people walk the show
let wakeLock = null;
async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (e) {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && document.body.classList.contains('running')) requestWakeLock(); });

// ------------------------------------------------------------------ controls
const slider = $('opacity');
slider.value = userOpacity; $('opacity-value').textContent = `${userOpacity}%`;
slider.addEventListener('input', () => {
  userOpacity = +slider.value; $('opacity-value').textContent = `${userOpacity}%`; store.set('opacity', userOpacity);
});

const soundBtn = $('sound-btn');
soundBtn.classList.toggle('muted', muted);
soundBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  muted = !muted; store.set('muted', muted);
  soundBtn.classList.toggle('muted', muted);
  media.setMuted(muted);
  toast(muted ? 'Sound off' : 'Sound on', 1000);
});

const poetBtn = $('poet-btn');
poetBtn.classList.toggle('active', poet);
function setPoet(on) {
  poet = on; store.set('poet', poet);
  poetBtn.classList.toggle('active', poet);
  if (poet) {
    if (showing && current) {
      if (!current.diary && !current.audio) toast('No journal for this one', 1400);
      listenTo(current);                  // the film goes quiet under the reading
    }
  } else {
    media.stopNarration();                // the film's own sound comes back
    poetArt = null;
    poetPanel();
  }
}
function setPoetMin(min) { poetMin = min; store.set('poetMin', poetMin); poetPanel(); }
const tap = (id, fn) => $(id).addEventListener('click', (e) => { e.stopPropagation(); fn(); });
tap('poet-btn', () => setPoet(!poet));
tap('diary-close', () => setPoet(false));
tap('bar-close', () => setPoet(false));
tap('diary-min', () => setPoetMin(true));
tap('bar-open', () => setPoetMin(false));
tap('bar-expand', () => setPoetMin(false));
for (const id of ['diary-play', 'bar-play']) tap(id, () => media.toggleNarration());
function syncPlayButtons() {
  const paused = media.narration.paused;
  for (const id of ['diary-play', 'bar-play']) {
    $(id).classList.toggle('paused', paused);
    $(id).setAttribute('aria-label', paused ? 'Play the reading' : 'Pause the reading');
  }
}
for (const ev of ['play', 'pause', 'ended']) media.narration.addEventListener(ev, syncPlayButtons);
syncPlayButtons();

$('shot-btn').addEventListener('click', async (e) => {
  e.stopPropagation();
  const blob = await screenshot(camera, glCanvas);
  if (blob) await save(blob, `moments-${current ? current.id : 'ar'}-${Date.now()}.jpg`);
});

const recBtn = $('record-btn');
let recorder = null;
recBtn.disabled = !window.MediaRecorder;
recBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  recorder = recorder || new Recorder(camera, glCanvas, () => media.audioTracks());
  if (recorder.recording) {
    recBtn.classList.remove('recording'); $('rec-border').classList.remove('visible');
    const out = await recorder.stop();
    if (out) await save(out.blob, `moments-${current ? current.id : 'ar'}-${Date.now()}.${out.ext}`);
  } else {
    recorder.start();
    recBtn.classList.add('recording'); $('rec-border').classList.add('visible');
  }
});

// tap the camera view: pause / play
document.body.addEventListener('click', (e) => {
  if (e.target.closest('#card, #diary, #poet-bar, #intro, #header')) return;
  if (!showing || !current) return;
  paused = media.togglePause(current);
  toast(paused ? 'Paused' : 'Playing', 800);
});

if (DEBUG) window.__motu = { get engine() { return engine; }, get current() { return current; }, get media() { return media; }, artworks: () => artworks };
