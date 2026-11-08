# MOTU — Moments of the Unknown, AR

Point a phone at a painting and the moment it came from plays on top of it.

This is the web app behind **366**, Justin Aversano's series of hand-painted silkscreen
portraits made from ten-second Super 8 films shot across all seven continents over the
leap year April 8, 2023 – April 7, 2024. It runs in the phone's browser (no app to
install) and is built so anyone can run it for their own work, on their own hosting.

## How it works

Most web AR libraries compare every camera frame against every artwork, one by one.
That works for ten images and collapses at hundreds. This app splits the job in two:

```
camera frame ──► MindAR feature detector (once per frame, on the GPU)
                    │
                    ├─► recognizer: visual words vs. ALL artworks at once  ──► top 1–3 candidates
                    │       (vocabulary tree + tf‑idf, ~1 ms, independent of collection size)
                    │
                    └─► MindAR matcher vs. ONLY those candidates ──► verified pose ──► tracking
```

* **Recognize** — every artwork's feature points are quantized into "visual words" at
  build time (`index.bin`). On the phone, the same features from the camera are scored
  against every artwork in one pass.
* **Verify + track** — only the 1–3 best candidates' tracking files (`targets/<id>.mind`,
  ~650 KB each) are fetched and loaded into a single MindAR controller, which checks the
  geometry and then tracks the painting frame to frame.
* **Play** — the matching film is already buffering by the time the painting locks, and
  fades in over it.

Because recognition and tracking use the *same* features, anything the recognizer can
see, the tracker can lock onto.

**Keeping the film on the canvas** (`src/ar/smooth.js`). MindAR turns the tracked points
into a rigid 3D pose that assumes a 45° lens; phone lenses differ, so the film would sit a
few pixels off and slide around at an angle. Instead, the painting's four corners are fitted
straight from the tracked points as a homography (exact for any flat canvas, no lens model),
smoothed together with a constant-velocity Kalman filter (follows a moving phone without
trailing, damps tracker noise), and the film is drawn as that exact homography. Through a
brief tracking drop the film drifts on along its last motion; if the painting was sweeping
across the screen it fades almost at once.

Measured with `test/make-shake.py` (synthetic handheld clips with ground-truth corners,
including dim, noisy, JPEG-compressed ones) and `test/steady.mjs` (runs the real app in
headless Chrome on that clip): film-to-canvas error 0.7–1.3 px, down from 4–18 px with the
pose. `test/tune-steady.mjs` replays recorded runs to tune the filter offline. Settings can be
tried on a phone without a rebuild: `?debug&engine={"accel":1200}`.

**Poet Mode** shows the day's journal and plays its reading. Fold the journal down to a slim
bar to see the painting; the reading carries on when the phone loses the painting for a
moment, and moves on to the next painting's when you point at another one. It plays straight
through the film's 10-second loops.

**Sound on iPhone** (`src/media.js`). Films and readings play natively from their elements,
with exactly one unmuted at a time: on iPhone a film that starts or loops takes the audio
from anything else unmuted, and a Web Audio mix can be suspended by the camera or a loop
and stay silent until a tap. Every element is primed on the Start tap, any later tap
re-asserts what should be playing, and the reading resumes itself if iOS pauses it.
Screen recordings carry sound where the browser allows capturing it (Chrome, Android); on
iPhone use the built-in screen recorder for sound.

## Make your own

You need [Node.js 20+](https://nodejs.org) and [ffmpeg](https://ffmpeg.org).

```bash
git clone https://github.com/<you>/moments-of-the-unknown-ar
cd moments-of-the-unknown-ar
npm install --ignore-scripts   # mind-ar lists a native package we never use
```

1. **Photos of the artworks** → `content/paintings/` named by number: `1.png`, `2.jpg` …
   (flat, cropped to the canvas edge, ~1500 px is plenty).
2. **Films** → shrink them for phones (≈2 MB per 10 s clip). Source names only need to
   start with the same number as the painting:

   ```bash
   npm run transcode -- "path/to/films" content/media/366 --numbered --jobs=3
   ```

   Long batches can be stopped and re-run; finished files are skipped.
3. **Extras (optional)** — any other image → video pairs go in `content/bonus/bonus.json`
   (see below). Titles and Poet Mode texts go in `content/texts.json`.
4. **Build**: `npm run build` → a static site in `dist/`.
5. **Try it on your phone**: `npm run dev`, then open the `https://<your-computer-ip>:5173`
   address it prints (same Wi‑Fi; accept the certificate warning).
6. **Publish**: upload `dist/` to any static host (see *Hosting*).

### `motu.config.json`

```json
{
  "title": "Moments of the Unknown",
  "volume": 0.5,
  "collections": [
    { "name": "366", "kind": "numbered", "images": "content/paintings", "videos": "content/media/366",
      "texts": "content/texts.json", "startDate": "2023-04-08", "label": "Day {n} · {date}" },
    { "name": "bonus", "kind": "list", "file": "content/bonus/bonus.json" }
  ]
}
```

* `numbered` collections pair `content/paintings/12.png` with `content/media/366/012.mp4`.
  `startDate` turns the number into a date for the on-screen label.
* `list` collections are explicit pairs, paths relative to the JSON file:

  ```json
  [{ "id": "henry-flowers", "title": "Henry Flowers", "image": "images/henry-flowers.jpg",
     "video": "media/february-6.mp4", "audio": "audio/henry.mp3", "diary": "henry.txt" }]
  ```

* `content/texts.json` (optional) — per-number title / Poet Mode text / alignment tweak:

  ```json
  { "001": { "title": "Example title", "diary": "Have you ever been a tourist…", "fit": { "zoom": 1.02, "dx": 0, "dy": 0.01 } } }
  ```

### Viewer features

Opacity slider · sound on/off (starts at half volume) · tap to pause · photo + screen
recording with sound (saved via the share sheet) · Poet Mode (narration track + tap to read
the journal entry) · screen stays awake · add to Home Screen. Add `?debug` to the URL to see
frame rate and recognition scores.

### Angle training and the pre-publish check

Each artwork is also trained from two simulated side views (50° left and right,
`pipeline/lib/views.mjs`), so a canvas locks from the side, not only head-on; the matcher
maps those views back onto the real canvas plane (`src/ar/matcher.js`).

Before publishing, run the check: every artwork is shown to the recognizer and tracker as a
simulated phone shot, straight on and 40° from the side. The build is only good if every one
is found in the top 3 and locks.

```bash
for i in 0 1 2 3; do node pipeline/check.mjs --shard=$i/4 & done; wait
node pipeline/check.mjs --report      # exits 1 if anything fails
```

## Hosting

The built site is plain static files (`index.html`, a JS bundle, `manifest.json`,
`index.bin.gz`, `targets/`, `media/`), with response headers in `_headers`. Any static host works.

**This show runs on Cloudflare Pages, connected to this GitHub repo** (build command
`npm run build:site`, output `dist`, `NODE_VERSION=22`): every push to `main` goes live.
The built assets in `public/` are committed, so the host only runs Vite.

**iPhones need byte ranges.** Safari on iOS only plays `<video>`/`<audio>` when the server
answers `Range` requests with `206 Partial Content`. Cloudflare Pages' static host always
answers `200`, so `functions/_middleware.js` (routed to `/media/*` and `/audio/*` only, via
`public/_routes.json`) cuts the requested slice. It runs as a Pages Function: free up to
100,000 requests a day, and it needs Git or `wrangler pages deploy` (drag-and-drop uploads
skip Functions). Netlify, S3/R2 and most web servers do ranges themselves. Test:
`node test/range.test.mjs`, and `curl -sI -H 'Range: bytes=0-1' https://<site>/media/001.mp4`
should print `206`.

**Recommended: Cloudflare Pages (free).** Static files are served with no bandwidth charge,
so a busy opening can't run up a bill or get the site paused (only the small range
function above counts against a daily request allowance). Up to 20,000 files and
25 MiB per file; the dashboard's drag-and-drop upload takes a folder of up to 1,000 files
(366 artworks ≈ 760 files). Larger collections: `npx wrangler pages deploy dist`.

Other hosts: Netlify (reads the same `_headers`; bandwidth is metered), an S3/R2 bucket,
a computer on the gallery Wi‑Fi, or IPFS/Arweave. All paths in `manifest.json` are
relative and media URLs carry a content hash (`?v=…`), so files can be cached forever.
To keep the films somewhere else, set `"assetBase": "https://media.example.com/"` in
`motu.config.json` and upload `public/media`, `public/targets` and `public/audio` there
(that host must send `Access-Control-Allow-Origin: *`). The viewer can also load a manifest
hosted elsewhere: `https://your-site/?manifest=https://some-gateway/manifest.json`.

Camera access requires HTTPS (or `localhost`).

Approximate sizes: app ~350 KB, index ~5 MB (once per visitor), each artwork ~0.65 MB
target + ~2.2 MB film. A visitor only downloads what they point at.

## Licenses

* **Code** — MIT (see `LICENSE`). Use it for your own work.
* **Artwork, films, photographs, sound and texts** of *Moments of the Unknown* — © Justin
  Aversano, all rights reserved (see `ARTWORK-LICENSE.md`). The built films, narration and
  targets are included in `public/` so this exact viewer can be run from any copy; they are
  not licensed for other use.

Built on [MindAR](https://github.com/hiukim/mind-ar-js) (MIT), [three.js](https://threejs.org)
(MIT) and [TensorFlow.js](https://github.com/tensorflow/tfjs) (Apache‑2.0). Recognition
follows Nistér & Stewénius, *Scalable Recognition with a Vocabulary Tree* (CVPR 2006).
