// Run with Playwright installed: node tests/panel-drag.browser.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium, webkit } = require('playwright');
const repo = path.resolve(__dirname, '..');
const near = (a, b, label) => assert(Math.abs(a - b) < 2, `${label}: ${a} vs ${b}`);

async function check(browserType, file) {
  const browser = await browserType.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/backend-api/')) {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ resolved_model_slug: 'test-route', conversation_id: 'test' }) });
      } else {
        await route.fulfill({ contentType: 'text/html', headers: { 'content-security-policy': "script-src 'nonce-drag-test-nonce'" }, body: '<!doctype html><html><head><script nonce="drag-test-nonce">window.testPageLoaded=true;</script></head><body style="margin:0">Panel drag test</body></html>' });
      }
    });
    await page.addInitScript({ path: path.join(repo, file) });
    await page.goto('https://chatgpt.com/c/test');
    const panel = page.locator('#cgri-userscript');
    await panel.locator('#panel').waitFor();
    const box = () => panel.boundingBox();
    const mode = () => page.evaluate(() => window.__chatgptRouteInspectorUserscript.snapshot().mode);
    async function drag(selector, dx, dy, during) {
      const b = await panel.locator(selector).boundingBox();
      const x = b.x + Math.min(35, b.width / 2), y = b.y + b.height / 2;
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 8 });
      if (during) await during();
      await page.mouse.up();
      await page.waitForTimeout(180);
    }
    if (process.env.CGRI_DEBUG) await page.evaluate(() => {
      window.dragEvents = [];
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'lostpointercapture']) window.addEventListener(type, e => window.dragEvents.push({ type, target: e.composedPath()[0]?.id || e.target.tagName, x: e.clientX, y: e.clientY, primary: e.isPrimary }), true);
    });
    let before = await box();
    await drag('header strong', -220, -80, async () => {
      await page.evaluate(() => fetch('/backend-api/conversation', { method: 'POST', body: JSON.stringify({ model: 'test-model', conversation_id: 'test' }) }));
      await page.waitForTimeout(250); // Network rendering must not replace a held drag handle.
    });
    let after = await box();
    near(after.x, before.x - 220, 'full x'); near(after.y, before.y - 80, 'full y');
    assert.equal(await mode(), 'full');
    await panel.locator('[data-action="compact"]').click();
    assert.equal(await mode(), 'compact');
    before = await box();
    await drag('#compact', -90, 45);
    after = await box();
    near(after.x, before.x - 90, 'compact x'); near(after.y, before.y + 45, 'compact y');
    assert.equal(await mode(), 'compact', 'drag must not expand compact mode');
    await panel.locator('#compact').click();
    assert.equal(await mode(), 'full', 'normal compact click still expands');
    await panel.locator('[data-action="edge"]').click();
    assert.equal(await mode(), 'edge');
    before = await box();
    await drag('#edge', -180, -120);
    after = await box();
    if (process.env.CGRI_DEBUG) console.log('EDGE', { before, after, mode: await mode(), events: await page.evaluate(() => window.dragEvents) });
    near(after.x + after.width, 1280, 'edge right attachment'); near(after.y, Math.max(0, before.y - 120), 'edge y');
    assert.equal(await mode(), 'edge', 'drag must not expand edge mode');
    const edgeY = after.y;
    await drag('#edge', -200, 0);
    after = await box();
    near(after.y, edgeY, 'horizontal edge drag does not move vertically');
    near(after.x + after.width, 1280, 'horizontal edge drag stays attached');
    assert.equal(await mode(), 'edge', 'horizontal drag must not expand');
    const savedEdgeY = after.y;
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('cgri.userscript.v1') || '{}').mode === 'edge');
    await page.reload(); await panel.locator('#edge').waitFor();
    after = await box();
    near(after.x + after.width, 1280, 'edge stays attached after reload'); near(after.y, savedEdgeY, 'edge position persisted');
    await panel.locator('#edge').click();
    assert.equal(await mode(), 'full');
    after = await box();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('cgri.userscript.v1.positions')));
    near(after.x, stored.full.x, 'full x restored across mode changes'); near(after.y, stored.full.y, 'full y restored across mode changes');
    await page.setViewportSize({ width: 420, height: 540 });
    await page.waitForTimeout(200);
    after = await box();
    assert(after.x >= -1 && after.y >= -1 && after.x + after.width <= 421 && after.y + after.height <= 541, 'resize keeps panel visible');
    await panel.locator('[data-action="edge"]').click();
    await drag('#edge', -250, 1500);
    after = await box();
    near(after.x + after.width, 420, 'edge right after resize');
    assert(after.y >= 0 && after.y + after.height <= 541, 'edge remains vertically visible');
    await panel.locator('#edge').click();
    await drag('header strong', -300, -1500);
    after = await box();
    near(after.y, 0, 'full drag clamps to top');
    assert(after.x >= 0, 'full drag clamps to left');
    assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
    await page.screenshot({ path: path.join(process.env.CGRI_SCREENSHOT_DIR || require('node:os').tmpdir(), `${browserType.name()}-${file}.png`) });
    await page.evaluate(() => window.__chatgptRouteInspectorUserscript.destroy());
    await page.setViewportSize({ width: 700, height: 700 });
    assert.equal(await panel.count(), 0, 'destroy removes panel');
    await context.close();
    console.log(`PASS ${browserType.name()} / ${file}: all modes, click behavior, network update during drag, persistence, resize and clamping.`);
  } finally { await browser.close(); }
}
(async () => {
  for (const type of [chromium, webkit].filter(t => !process.env.CGRI_ENGINE || process.env.CGRI_ENGINE === t.name())) {
    for (const file of ['chatgpt-route-inspector.user.js', 'chatgpt-route-inspector-safari.user.js'].filter(f => !process.env.CGRI_FILE || process.env.CGRI_FILE === f)) await check(type, file);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
