// Media: a small pool of <video> elements reused across artworks, and one <audio>
// for the Poet Mode readings. Everything plays natively, straight from the
// elements. (An earlier version mixed through Web Audio; on iPhone that graph can
// be suspended by the camera starting or by a film looping, and then stays silent
// until the next tap.)
//
// The iPhone rules this is built around:
// - An element may play with sound without a tap only once it has played inside
//   one. Every element is "primed" on the Start tap and then reused by swapping
//   its src.
// - One unmuted element holds the audio at a time, and a film that starts or
//   loops takes it. So exactly one element is ever unmuted: the reading in Poet
//   Mode, otherwise the film in view. Everything else plays muted.
// - Element volume is fixed to the phone's volume (elsewhere `volume` applies).
// Any tap also re-asserts what should be playing (unlock), in case iOS stopped it.

const BLANK = './blank.mp4';

export class Media {
  constructor({ videos = 3, volume = 0.5, log = () => {} } = {}) {
    this.volume = volume;
    this.log = log;
    this.muted = false;       // the visitor turned sound off
    this.pool = Array.from({ length: videos }, () => this._makeVideo());
    // iOS Safari only keeps decoding frames for videos that are in the document
    const holder = document.createElement('div');
    holder.setAttribute('aria-hidden', 'true');
    holder.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1';
    this.pool.forEach((v) => holder.appendChild(v));
    document.body.appendChild(holder);
    this.owner = new Map();   // element -> artwork id
    this.lru = [];            // elements, least recent first
    this.pinned = null;       // artwork whose element must not be recycled
    this.film = null;         // the film in view (heard unless a reading is on)
    this.filmPaused = false;  // the visitor paused the film (tap on the view)
    this.narration = new Audio();
    this.narration.preload = 'auto';
    this.narrArt = null;      // artwork whose reading is loaded
    this.narrPaused = false;  // the visitor paused the reading
    this.resumes = [];        // recent automatic resumes of the reading
    this.narration.addEventListener('pause', () => this._keepReading());
  }

  _makeVideo() {
    const v = document.createElement('video');
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.loop = true;
    v.preload = 'none';
    v.crossOrigin = 'anonymous';
    // remember once a film has shown a frame, so a looping film's momentary
    // stall at its first frame doesn't read as "not ready" (and flicker)
    v.addEventListener('loadeddata', () => { v.loadedSrc = v.src; });
    return v;
  }

  /** Call synchronously inside the Start tap. */
  prime() {
    for (const el of [...this.pool, this.narration]) {
      el.muted = false;
      el.src = BLANK;
      const p = el.play();
      if (p) p.then(() => el.pause()).catch(() => {});
    }
  }

  /** Exactly one element may be heard: the reading if one is on, else the film in view. */
  _sync() {
    const want = this.muted ? null : (this.narrArt ? this.narration : this.film);
    for (const el of [...this.pool, this.narration]) if (el !== want && !el.muted) el.muted = true; // silence first...
    if (want) {                                                                                    // ...then let one speak
      if (want !== this.narration) want.volume = Math.min(1, this.volume);
      want.muted = false;
    }
  }

  _elementFor(art) {
    for (const [el, id] of this.owner) if (id === art.id) { this._touch(el); return el; }
    // reuse the least-recently-used element that isn't the one in view
    const el = this.lru.length < this.pool.length ? this.pool[this.lru.length]
      : this.lru.find((e) => this.owner.get(e) !== this.pinned) || this.lru[0];
    this.owner.set(el, art.id);
    this._touch(el);
    if (el === this.film) this.film = null;
    el.muted = true;
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

  /** The film for an artwork comes into view. (In Poet Mode with a reading, it plays silent under the voice.) */
  async play(art, { restart = false } = {}) {
    const el = this._elementFor(art);
    this.film = el;
    this.filmPaused = false;
    if (restart) { try { el.currentTime = 0; } catch (e) {} }
    this._sync();
    try { await el.play(); } catch (e) {
      // sound not allowed without a tap: keep the picture going, silent, until the next tap (unlock)
      this.log('film sound blocked until a tap', e.message);
      el.muted = true;
      try { await el.play(); } catch (e2) { this.log('play failed', e2.message); }
    }
    return el;
  }

  /** The painting is gone: its film goes silent but keeps running (keeps iOS textures alive). The reading carries on. */
  release(art) {
    if (this.film && this.owner.get(this.film) === art.id) this.film = null;
    this._sync();
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
      this._sync();
      return;
    }
    this._sync();
    n.play().catch((e) => this.log('reading blocked until a tap', e.message));
  }

  stopNarration() {
    this.narrArt = null; this.narrPaused = false;
    this.narration.pause();
    this._sync();
  }

  /** Play/pause button on the journal. A finished reading starts again. */
  toggleNarration() {
    const n = this.narration;
    if (!this.narrArt) return;
    if (n.paused) {
      if (n.ended) { try { n.currentTime = 0; } catch (e) {} }
      this.narrPaused = false;
      this._sync();
      n.play().catch((e) => this.log('reading blocked', e.message));
    } else {
      this.narrPaused = true;
      n.pause();
    }
  }

  /** The reading stopped. Unless the visitor paused it or it finished, carry on. */
  _keepReading() {
    const n = this.narration;
    if (!this.narrArt || this.narrPaused || n.ended) return;
    const now = performance.now();
    this.resumes = this.resumes.filter((t) => now - t < 10000);
    if (this.resumes.length >= 6) { this.log('reading keeps being interrupted; waiting for a tap'); return; }
    this.resumes.push(now);
    setTimeout(() => {
      if (this.narrArt && !this.narrPaused && n.paused && !n.ended) {
        this.log('reading interrupted, resuming');
        this._sync();
        n.play().catch((e) => this.log('reading resumes on the next tap', e.message));
      }
    }, 150);
  }

  /** Any tap: iOS lets anything play now, so bring back whatever should be playing. */
  unlock() {
    const n = this.narration;
    this._sync();
    if (this.narrArt && !this.narrPaused && !n.ended && n.paused) n.play().catch(() => {});
    if (this.film && !this.filmPaused && this.film.paused) this.film.play().catch(() => {});
  }

  /** Tap on the camera view: pause or resume the film (and the reading with it). */
  togglePause(art) {
    const el = this._elementFor(art);
    const n = this.narration;
    if (this.filmPaused || el.paused) {
      this.filmPaused = false;
      el.play().catch(() => {});
      if (this.narrArt && n.paused && !n.ended && n.currentTime > 0) { this.narrPaused = false; n.play().catch(() => {}); }
      return false;
    }
    this.filmPaused = true;
    el.pause();
    if (this.narrArt && !n.paused) { this.narrPaused = true; n.pause(); }
    return true;
  }

  setMuted(m) { this.muted = m; this._sync(); }

  /** Audio of whatever is being heard, for screen recordings (where the browser allows it; not on iPhone). */
  audioTracks() {
    const el = this.muted ? null : (this.narrArt ? this.narration : this.film);
    try { return el && el.captureStream ? el.captureStream().getAudioTracks() : []; } catch (e) { return []; }
  }
}
