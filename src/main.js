import {
  WebGLRenderer, Scene, PerspectiveCamera, Mesh, PlaneGeometry, MeshBasicMaterial,
  VideoTexture, Matrix4, Vector3, Quaternion, SRGBColorSpace, LinearFilter,
} from 'three';
import { deserializeIndex } from './ar/recognizer.js';
import { ArtworkEngine } from './ar/engine.js';
import { Media } from './media.js';
import { screenshot, save, Recorder } from './capture.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
const MANIFEST_URL = new URL(params.get('manifest') || './manifest.json', location.href);
const FADE_MS = 600;

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
const cam3 = new PerspectiveCamera();
const material = new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
const plane = new Mesh(new PlaneGeometry(1, 1), material);
plane.matrixAutoUpdate = false;
plane.visible = false;
scene.add(plane);
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
function layout() {
  const cw = window.innerWidth, ch = window.innerHeight;
  renderer.setSize(cw, ch, false);
  const vw = camera.videoWidth, vh = camera.videoHeight;
  if (!vw || !engine || !engine.controller) return;
  const s = Math.max(cw / vw, ch / vh);
  Object.assign(camera.style, { width: `${vw * s}px`, height: `${vh * s}px`, left: `${(cw - vw * s) / 2}px`, top: `${(ch - vh * s) / 2}px` });
  const proj = engine.projection();
  cam3.fov = (2 * Math.atan((ch / (vh * s)) / proj[5]) * 180) / Math.PI;
  cam3.aspect = cw / ch;
  cam3.near = proj[14] / (proj[10] - 1.0);
  cam3.far = proj[14] / (proj[10] + 1.0);
  cam3.updateProjectionMatrix();
}
window.addEventListener('resize', layout);

// ------------------------------------------------------------------ app state
const media = new Media({ videos: 3, volume: 0.5, log });
let current = null;        // artwork currently anchored
let currentEl = null;      // its video element
let planeAspect = 4 / 3;
let pose = null;           // latest world matrix
let showing = false;
let opacity = 0;
let userOpacity = store.get('opacity', 100);
let poet = store.get('poet', false);
let muted = store.get('muted', false);
let paused = false;
const post = new Matrix4();

function onUpdate({ index: i, worldMatrix, markerSize }) {
  const art = artworks[i];
  if (!worldMatrix) {
    if (current === art) {
      showing = false; media.release(art);
      document.body.classList.add('searching'); $('diary').classList.remove('visible');
      $('header-text').textContent = manifest.title; hint('Point at a painting');
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
    post.compose(new Vector3(w / 2, h / 2, 0), new Quaternion(), new Vector3(w, w, w));
    fitTexture(material.map, art, el, planeAspect);
    material.needsUpdate = true;
    $('header-text').textContent = art.label || manifest.title;
    log('found', art.id);
  }
  if (!showing) {
    showing = true;
    document.body.classList.remove('searching');
    media.play(art, { poet, restart: isNew }).then((el) => { if (current === art) fitTexture(material.map, art, el, planeAspect); });
  }
  pose = worldMatrix;
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(64, now - last); last = now;
  const ready = currentEl && currentEl.readyState >= 2;
  const target = showing && ready ? userOpacity / 100 : 0;
  const step = dt / (showing ? FADE_MS : 220);
  opacity += Math.sign(target - opacity) * Math.min(Math.abs(target - opacity), step);
  material.opacity = opacity;
  plane.visible = opacity > 0.001 && !!pose;
  if (pose) plane.matrix.fromArray(pose).multiply(post);
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
    options: manifest.engine || {},
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
  if (media.ctx && media.ctx.state === 'suspended') media.ctx.resume();
  media.setMuted(muted, showing ? current : null, { poet });
  toast(muted ? 'Sound off' : 'Sound on', 1000);
});

const poetBtn = $('poet-btn');
poetBtn.classList.toggle('active', poet);
poetBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  poet = !poet; store.set('poet', poet);
  poetBtn.classList.toggle('active', poet);
  toast(poet ? 'Poet Mode on — tap the painting to read' : 'Poet Mode off', 1400);
  if (showing && current) media.play(current, { poet });
});

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
  recorder = recorder || new Recorder(camera, glCanvas, media.stream());
  if (recorder.recording) {
    recBtn.classList.remove('recording'); $('rec-border').classList.remove('visible');
    const out = await recorder.stop();
    if (out) await save(out.blob, `moments-${current ? current.id : 'ar'}-${Date.now()}.${out.ext}`);
  } else {
    recorder.start();
    recBtn.classList.add('recording'); $('rec-border').classList.add('visible');
  }
});

// tap the view: pause/play, or read the diary in Poet Mode
const diary = $('diary');
document.body.addEventListener('click', (e) => {
  if (e.target.closest('#controls, #intro, #header')) return;
  if (diary.classList.contains('visible')) { diary.classList.remove('visible'); return; }
  if (!showing || !current) return;
  if (poet && current.diary) {
    diary.querySelector('.diary-title').textContent = current.label || manifest.title;
    diary.querySelector('.diary-body').textContent = current.diary;
    diary.classList.add('visible');
    return;
  }
  paused = media.togglePause(current);
  toast(paused ? 'Paused' : 'Playing', 800);
});

if (DEBUG) window.__motu = { get engine() { return engine; }, get current() { return current; }, artworks: () => artworks };
