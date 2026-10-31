// Runs test.html in headless Chromium and exits non-zero if any test fails.
// Usage: node tests/run-selftest.cjs   (needs the 'playwright' package)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

server.listen(0, async () => {
  const port = server.address().port;
  const browser = await chromium.launch();
  let failed = true;
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('page error:', e.message));
    await page.goto(`http://localhost:${port}/test.html`);
    await page.waitForFunction(() => /passed/.test(document.getElementById('sum').textContent), null, { timeout: 60000 });
    console.log(await page.innerText('#rows'));
    const sum = await page.textContent('#sum');
    console.log('\n' + sum);
    const m = sum.match(/(\d+) \/ (\d+)/);
    failed = !m || m[1] !== m[2];
  } catch (e) {
    console.error(e.message);
  } finally {
    await browser.close();
    server.close();
    process.exit(failed ? 1 : 0);
  }
});
