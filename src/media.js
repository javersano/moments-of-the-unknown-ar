// Media: a small pool of <video> elements reused across artworks, routed
// through one Web Audio graph (so volume works on iOS and recordings carry sound).
//
// iOS only lets an element play with sound after it has been played inside a
// user gesture. We "prime" every pooled element once on the Start tap, then
// keep reusing those same elements by swapping their src.
//
// iOS also gives the audio to one unmuted element at a time: a film that starts
// or loops back to its first frame takes it from whatever else is playing, even
// at zero volume. So a film that shouldn't be heard is muted outright (after its
// fade), and the Poet Mode reading resumes itself if anything but the visitor
// pauses it.

const BLANK = './blank.mp4';

export class Media {
  constructor({ videos = 3, volume = 0.5, log = () => {} } = {}) {
    this.volume = volume;
    this.log = log;
    this.muted = false;
    this.pool = Array.from({ length: videos }, () => this._makeVideo());
    // iOS Safari only keeps decoding frames for videos that are in the document
    const holder = document.createElement('div');
    holder.setAttribute('aria-hidden', 'true');
    holder.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1';
    this.pool.forEach((v) => holder.appendChild(v));
    document.body.appendChild(holder);
    this.owner = new Map();   // element -> artwork id
    this.lru = [];            // elements, least recent first
    this.narration = new Audio();
    this.narration.preload = 'none';
    this.ctx = null;
    this.gains = new Map();
    this.pinned = null;       // artwork whose element must not be recycled
    this.narrArt = null;      // artwork whose reading is loaded in `narration`
    this.narrPaused = false;  // the visitor paused the reading themselves
    this.heard = new Map();   // film element -> should be audible
    this.muteTimers = new Map();
    this.resumes = [];        // times the reading was resumed after an outside pause
    this.narration.addEventListener('pause', () => this._keepReading());
  }

  _makeVideo() {
    const v = document.createElement('video');
    // remember once a film has shown a frame, so a looping film's momentary
    // stall at its first frame doesn't read as "not ready" (and flicker)
    v.addEventListener('loadeddata', () => { v.loadedSrc = v.src; });
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.loop = true;
    v.preload = 'none';
    v.crossOrigin = 'anonymous';
    return v;
  }

  /** Call synchronously inside the Start tap. */
  prime() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC && !this.ctx) {
      this.ctx = new AC();
      this.mix = this.ctx.createMediaStreamDestination ? this.ctx.createMediaStreamDestination() : null;
      for (const el of [...this.pool, this.narration]) {
        try {
          const src = this.ctx.createMediaElementSource(el);
          const g = this.ctx.createGain();
          g.gain.value = 0;
          src.connect(g); g.connect(this.ctx.destination);
          if (this.mix) g.connect(this.mix);
          this.gains.set(el, g);
        } catch (e) { this.log('audio wire failed', e.message); }
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    // iOS can suspend or "interrupt" the whole audio graph (a call, another app): bring it back
    if (this.ctx && !this.ctx.onstatechange) {
      this.ctx.onstatechange = () => {
        if (this.ctx.state !== 'running' && this.ctx.state !== 'closed') setTimeout(() => this.ctx.resume().catch(() => {}), 250);
      };
    }
    for (const el of [...this.pool, this.narration]) {
      el.src = BLANK;
      const p = el.play();
      if (p) p.then(() => el.pause()).catch(() => {});
    }
  }

  /** Recordable audio stream of everything that plays. */
  stream() { return this.mix ? this.mix.stream : null; }

  _gain(el, value, ramp = 0.35) {
    if (el !== this.narration) this._hear(el, value > 0, ramp);
    const g = this.gains.get(el);
    if (g && this.ctx) {
      const t = this.ctx.currentTime;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(value, t + ramp);
    } else {
      el.volume = Math.min(1, value);
    }
  }

  /** Unmute a film that should be heard; mute one that shouldn't, once its fade is done. */
  _hear(el, on, ramp) {
    this.heard.set(el, on);
    clearTimeout(this.muteTimers.get(el));
    if (on) { el.muted = false; return; }
    const g = this.gains.get(el);
    if (!g || g.gain.value < 0.01) { el.muted = true; return; }
    this.muteTimers.set(el, setTimeout(() => { if (!this.heard.get(el)) el.muted = true; }, ramp * 1000 + 80));
  }

  /** The reading was paused. If the visitor didn't do it (iOS handed the audio elsewhere), carry on. */
  _keepReading() {
    const n = this.narration;
    if (!this.narrArt || this.narrPaused || n.ended) return;
    const now = performance.now();
    this.resumes = this.resumes.filter((t) => now - t < 10000);
    if (this.resumes.length >= 6) { this.log('reading keeps being interrupted; leaving it paused'); return; }
    this.resumes.push(now);
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    setTimeout(() => {
      if (this.narrArt && !this.narrPaused && n.paused && !n.ended) {
        this.log('reading interrupted, resuming');
        n.play().catch((e) => this.log('reading resume failed', e.message));
      }
    }, 150);
  }

  _elementFor(art) {
    for (const [el, id] of this.owner) if (id === art.id) { this._touch(el); return el; }
    // reuse least-recently-used element that isn't currently audible
    const el = this.lru.length < this.pool.length ? this.pool[this.lru.length]
      : this.lru.find((e) => this.owner.get(e) !== this.pinned) || this.lru[0];
    this.owner.set(el, art.id);
    this._touch(el);
    el.pause();
    el.preload = 'auto';
    el.loadedSrc = null;
    el.src = art.video;
    if (art.poster) el.poster = art.poster;
    el.load();
    return el;
  }
  _touch(el) { this.lru = this.lru.filter((e) => e !== el); this.lru.push(el); }

  /** Start buffering an artwork's video before it is verified (cheap head start). */
  prepare(art) { if (art && art.video) this._elementFor(art); }

  /** Video element for an artwork (texture source). */
  video(art) { return this._elementFor(art); }

  /** Film for an artwork. In Poet Mode (with a reading) the film plays silent under the voice. */
  async play(art, { poet = false, restart = false } = {}) {
    const el = this._elementFor(art);
    for (const other of this.pool) if (other !== el) { this._gain(other, 0, 0.2); }
    if (restart) { try { el.currentTime = 0; } catch (e) {} }
    this._gain(el, !this.muted && !(poet && art.audio) ? this.volume : 0);
    try { await el.play(); } catch (e) {
      // sound not allowed yet: keep the picture alive, muted
      this.log('play with sound blocked, falling back to muted', e.message);
      el.muted = true;
      try { await el.play(); } catch (e2) { this.log('play failed', e2.message); }
    }
    return el;
  }

  /** Target lost: fade the film's sound but keep frames running (keeps iOS textures alive). The reading carries on. */
  release(art) {
    for (const [el, id] of this.owner) if (id === art.id) this._gain(el, 0, 0.25);
  }

  /**
   * Poet Mode reading for `art`. A new artwork starts its reading from the top;
   * the same one carries on (and stays paused or finished if it was).
   */
  narrate(art) {
    const n = this.narration;
    if (!art || !art.audio) { this.stopNarration(); return; }
    if (this.narrArt !== art.id) {
      this.narrArt = art.id; this.narrPaused = false;
      n.src = art.audio;
      try { n.currentTime = 0; } catch (e) {}
    } else if (!n.paused || n.ended || this.narrPaused) {
      return;
    }
    this._gain(n, this.muted ? 0 : 1, 0.2);
    n.play().catch((e) => this.log('narration blocked', e.message));
  }

  stopNarration() {
    this.narrArt = null; this.narrPaused = false;
    this._gain(this.narration, 0, 0.2);
    setTimeout(() => { if (!this.narrArt) this.narration.pause(); }, 250);
  }

  /** Play/pause button on the journal. A finished reading starts again. */
  toggleNarration() {
    const n = this.narration;
    if (!this.narrArt) return;
    if (n.paused) {
      if (n.ended) { try { n.currentTime = 0; } catch (e) {} }
      this.narrPaused = false;
      this._gain(n, this.muted ? 0 : 1, 0.15);
      n.play().catch((e) => this.log('narration blocked', e.message));
    } else {
      this.narrPaused = true;
      n.pause();
    }
  }

  /** Tap on the camera view: pause or resume the film (and the reading with it). */
  togglePause(art) {
    const el = this._elementFor(art);
    const n = this.narration;
    if (el.paused) {
      el.play();
      if (this.narrArt && n.paused && !n.ended && n.currentTime > 0) { this.narrPaused = false; n.play().catch(() => {}); }
      return false;
    }
    el.pause();
    if (this.narrArt && !n.paused) { this.narrPaused = true; n.pause(); }
    return true;
  }

  setMuted(m, art, { poet = false } = {}) {
    this.muted = m;
    if (m) { for (const el of [...this.pool, this.narration]) this._gain(el, 0, 0.15); return; }
    if (this.narrArt) this._gain(this.narration, 1, 0.15);
    if (!art) return;
    const narr = poet && art.audio;
    for (const [el, id] of this.owner) if (id === art.id) this._gain(el, narr ? 0 : this.volume, 0.15);
  }
}
