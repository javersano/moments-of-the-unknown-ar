// End-to-end: real Chromium, fake camera = y4m walk past artworks.
//   node test/e2e.mjs <url> <camera.y4m> <expected ids comma-separated> [seconds]
// Prints the timeline of which artwork the app anchored to, saves screenshots.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import fs from 'node:fs';

const [url, y4m, expected, secs = '40'] = process.argv.slice(2);
const want = expected.split(',');
fs.mkdirSync('tmp/e2e', { recursive: true });
const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`,
    '--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  ],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, ignoreHTTPSErrors: true });
const logs = [];
page.on('console', (m) => { const t = m.text(); logs.push(t); if (/ERROR|REJECT|failed|found/.test(t)) console.log('  page:', t); });
page.on('pageerror', (e) => console.log('  pageerror:', e.message));
await page.goto(url);
await page.waitForFunction(() => !document.getElementById('start').disabled, null, { timeout: 60000 });
await page.click('#start');
const seen = [];
const t0 = Date.now();
let shot = 0;
while (Date.now() - t0 < +secs * 1000) {
  await page.waitForTimeout(500);
  const s = await page.evaluate(() => ({
    id: window.__motu && window.__motu.current ? window.__motu.current.id : null,
    showing: !document.body.classList.contains('searching'),
    debug: document.getElementById('debug').textContent.split('\n').slice(0, 3).join(' | '),
  }));
  const t = ((Date.now() - t0) / 1000).toFixed(1);
  if (s.showing && s.id && seen[seen.length - 1] !== s.id) {
    seen.push(s.id);
    console.log(`${t}s  ANCHORED ${s.id}`);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `tmp/e2e/${String(++shot).padStart(2, '0')}-${s.id}.png` });
  }
  if (Math.round(+t * 2) % 10 === 0) console.log(`${t}s  ${s.debug}`);
}
await browser.close();
const ok = want.every((w) => seen.includes(w));
console.log(`\nanchored: ${seen.join(' -> ') || '(nothing)'}\nexpected: ${want.join(' -> ')}\n${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
