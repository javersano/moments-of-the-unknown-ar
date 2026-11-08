// node test/range.test.mjs  — checks the byte-range middleware against a fake static host.
import assert from 'node:assert/strict';
import { onRequest, parseRange } from '../functions/_middleware.js';

const file = new Uint8Array(1000).map((_, i) => i % 256);
const env = { ASSETS: { fetch: async (req) => {
  assert.equal(req.headers.get('Range'), null, 'range must not be forwarded');
  return new Response(file, { status: 200, headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'public, max-age=31536000, immutable' } });
} } };
const call = (range, method = 'GET') => onRequest({
  request: new Request('https://x.test/media/001.mp4?v=1', { method, headers: range ? { Range: range } : {} }),
  env, next: () => new Response('next'),
});

let r = await call('bytes=0-1');
assert.equal(r.status, 206); assert.equal(r.headers.get('Content-Range'), 'bytes 0-1/1000');
assert.equal(r.headers.get('Content-Length'), '2'); assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [0, 1]);
assert.equal(r.headers.get('Content-Type'), 'video/mp4');

r = await call('bytes=990-');
assert.equal(r.status, 206); assert.equal(r.headers.get('Content-Range'), 'bytes 990-999/1000');
assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [222, 223, 224, 225, 226, 227, 228, 229, 230, 231]);

r = await call('bytes=0-99999');
assert.equal(r.status, 206); assert.equal(r.headers.get('Content-Range'), 'bytes 0-999/1000');
assert.equal((await r.arrayBuffer()).byteLength, 1000);

r = await call('bytes=-5');
assert.equal(r.headers.get('Content-Range'), 'bytes 995-999/1000');

r = await call('bytes=1000-');
assert.equal(r.status, 416); assert.equal(r.headers.get('Content-Range'), 'bytes */1000');

r = await call(null);
assert.equal(r.status, 200); assert.equal(r.headers.get('Accept-Ranges'), 'bytes'); assert.equal((await r.arrayBuffer()).byteLength, 1000);

r = await call('bytes=0-1', 'HEAD');
assert.equal(r.status, 206); assert.equal(r.headers.get('Content-Length'), '2');

r = await call('bytes=0-1,5-6');           // multi-range: fall back to the whole file
assert.equal(r.status, 200);

r = await onRequest({ request: new Request('https://x.test/media/a.mp4', { method: 'POST' }), env, next: () => new Response('next') });
assert.equal(await r.text(), 'next');

assert.deepEqual(parseRange('bytes=5-'), { start: 5, end: null });
assert.equal(parseRange(''), null);
assert.equal(parseRange('items=0-1'), null);
console.log('range middleware: all checks passed');
