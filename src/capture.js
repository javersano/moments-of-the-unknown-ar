// Screenshot + screen recording of camera feed composited with the AR layer.

function coverRect(sw, sh, dw, dh) {
  const s = Math.max(dw / sw, dh / sh);
  const w = sw * s, h = sh * s;
  return [(dw - w) / 2, (dh - h) / 2, w, h];
}

export function compose(out, camera, glCanvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.round(window.innerWidth * dpr), H = Math.round(window.innerHeight * dpr);
  if (out.width !== W || out.height !== H) { out.width = W; out.height = H; }
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (camera.videoWidth) ctx.drawImage(camera, ...coverRect(camera.videoWidth, camera.videoHeight, W, H));
  ctx.drawImage(glCanvas, 0, 0, W, H);
}

export async function save(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return true; }
    catch (e) { if (e.name === 'AbortError') return false; }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return true;
}

export function screenshot(camera, glCanvas) {
  const c = document.createElement('canvas');
  compose(c, camera, glCanvas);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
}

const TYPES = ['video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];

export class Recorder {
  /** audio: a function returning the audio tracks to record (or a MediaStream) */
  constructor(camera, glCanvas, audio) {
    this.camera = camera; this.gl = glCanvas; this.audio = audio;
    this.rec = null;
  }
  get supported() { return !!window.MediaRecorder; }
  get recording() { return !!this.rec && this.rec.state === 'recording'; }

  start() {
    const canvas = document.createElement('canvas');
    compose(canvas, this.camera, this.gl);
    const tick = () => { compose(canvas, this.camera, this.gl); this.raf = requestAnimationFrame(tick); };
    tick();
    const stream = canvas.captureStream(30);
    const tracks = typeof this.audio === 'function' ? this.audio() : (this.audio ? this.audio.getAudioTracks() : []);
    tracks.forEach((t) => stream.addTrack(t));
    const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const chunks = [];
    this.rec = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    this.rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
    this.done = new Promise((resolve) => {
      this.rec.onstop = () => {
        cancelAnimationFrame(this.raf);
        const type = mimeType || 'video/webm';
        resolve({ blob: new Blob(chunks, { type }), ext: type.includes('mp4') ? 'mp4' : 'webm' });
        this.rec = null;
      };
    });
    this.rec.start(250);
  }

  async stop() {
    if (!this.recording) return null;
    this.rec.stop();
    return this.done;
  }
}
