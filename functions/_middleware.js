// Byte-range support for films and narrations.
//
// Cloudflare Pages serves static files with a full 200 even when the browser asks
// for a byte range. Safari on iPhone and iPad (and so every iOS browser) will not
// play <video> or <audio> unless it gets a proper 206 Partial Content, so without
// this the films would stay black on iPhones.
//
// public/_routes.json sends only /media/* and /audio/* here; everything else on the
// site is served straight from the static host and never runs this code.
// Files are small (a few MB), so we read the whole asset and hand back the slice.

export async function onRequest({ request, env, next }) {
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD') return next();

  const asset = await env.ASSETS.fetch(new Request(request.url, { method: 'GET' }));
  if (asset.status !== 200) return asset;

  const headers = new Headers(asset.headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.delete('Content-Encoding');
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'public, max-age=31536000, immutable');

  const range = parseRange(request.headers.get('Range'));
  if (!range) {
    // Plain request: same as the static host, plus Accept-Ranges so players know they may seek.
    if (method === 'HEAD') return new Response(null, { status: 200, headers });
    return new Response(asset.body, { status: 200, headers });
  }

  const buf = await asset.arrayBuffer();
  const size = buf.byteLength;
  let start, end;
  if (range.start === null) {            // bytes=-N  (last N bytes)
    start = Math.max(0, size - range.end);
    end = size - 1;
  } else {
    start = range.start;
    end = range.end === null ? size - 1 : Math.min(range.end, size - 1);
  }
  if (size === 0 || start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' } });
  }
  const length = end - start + 1;
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(length));
  if (method === 'HEAD') return new Response(null, { status: 206, headers });
  return new Response(new Uint8Array(buf, start, length), { status: 206, headers });
}

// Only the single-range forms browsers send for media: bytes=a-b, bytes=a-, bytes=-n.
export function parseRange(value) {
  if (!value) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(value);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') return { start: null, end: Number(m[2]) };
  return { start: Number(m[1]), end: m[2] === '' ? null : Number(m[2]) };
}
