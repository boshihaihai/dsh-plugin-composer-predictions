// Optional real-DOM smoke test. Install Playwright locally, or set
// PLAYWRIGHT_MODULE to an existing Playwright package directory.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 600 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://composer.test/**', route => route.fulfill({
      contentType: 'text/html', body: `<!doctype html><html lang="zh"><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:24px;font:16px/24px sans-serif;color:#24262b;background:#f5f6f8}
      [data-composer-card]{margin:32px auto;background:white;border:1px solid #ddd;border-radius:16px;padding:16px;max-width:840px}
      .grow{position:relative}[data-composer-input]{outline:none;min-height:32px;padding:4px 8px;white-space:pre-wrap}
      [data-composer-placeholder]{position:absolute;top:4px;left:8px;color:#aaa;pointer-events:none}
      button{margin-top:16px}
      </style><h3>下一条提示词推荐</h3><div data-composer-card><div class="grow"><div data-composer-input contenteditable="true"><br></div><span data-composer-placeholder="true">发送消息</span></div><button>工具</button></div></html>`
    }));
    await page.goto('http://composer.test/');
    // Reuse the test hook runner with an actual browser DOM and native observers.
    // This validates layout / browser events; it does not substitute for a DSH integration run.
    const helper = readFileSync(path.join(__dirname, 'helpers/client-harness.js'), 'utf8');
    const hooks = helper.slice(helper.indexOf('function createReact()'), helper.indexOf('function findElement('));
    await page.addScriptTag({ content: `${hooks}\nwindow.hooks = createReact(); window.__ModuleLoader__ = { load: value => window.plugin = value.factory(() => hooks.React) };` });
    await page.addScriptTag({ content: readFileSync(path.join(__dirname, '../client.js'), 'utf8') });
    await page.evaluate(async () => {
      const slots = new Map();
      window.__DSH_COMPOSER_PREDICTIONS_TOKEN__ = 'fixture-token';
      window.insertions = [];
      window.fetch = async () => ({ ok: true, json: async () => ({ suggestion: '请补充几个实际使用示例，说明遇到异常时如何处理，并把关键操作整理成一份可以直接参考的简短清单。' }) });
      window.dispose = await plugin.apply({
        effect: f => f(), locale: { register: () => () => {} },
        slots: { inject: (_, f) => f(), register: (config, component) => slots.set(config.name, { config, component }) },
      });
      const slot = slots.get('conversation.input.dock');
      window.runner = hooks.mount(slot.component, {
        ...slot.config.inject(), sessionId: 'fixture-session', session: { running: true }, input: { draft: '' },
        t: () => '按 Tab 填入', inputActions: {
          captureInsertion: () => null,
          insertText: text => { insertions.push(text); document.querySelector('[data-composer-input]').textContent = text; runner.update({ input: { draft: text } }); return true; },
        },
      });
      let dirty = runner.dirty;
      Object.defineProperty(runner, 'dirty', { get: () => dirty, set: value => { dirty = value; if (value) queueMicrotask(() => runner.render()); } });
      runner.update({ session: { running: false } });
    });
    const ghost = '[data-composer-predictions="inline"]';
    await page.waitForSelector(ghost);
    async function measure() {
      return page.evaluate(() => {
        const editor = document.querySelector('[data-composer-input]');
        const text = document.querySelector('[data-composer-predictions="inline-text"]');
        const a = editor.getBoundingClientRect(), b = text.getBoundingClientRect();
        return { editorHeight: a.height, textHeight: b.height, fits: b.left >= a.left && b.right <= a.right + 1 && b.bottom <= a.bottom + 1,
          placeholderHidden: getComputedStyle(document.querySelector('[data-composer-placeholder]')).display === 'none' };
      });
    }
    const narrow = await measure();
    assert.equal(narrow.fits, true);
    assert.equal(narrow.placeholderHidden, true);
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.waitForFunction(height => document.querySelector('[data-composer-input]').getBoundingClientRect().height < height, narrow.editorHeight);
    const wide = await measure();
    assert.equal(wide.fits, true);

    await page.evaluate(() => {
      const old = document.querySelector('[data-composer-input]');
      const next = old.cloneNode(true); next.style.minHeight = ''; old.replaceWith(next);
    });
    await page.waitForFunction(() => document.querySelector('[data-composer-input]').style.minHeight !== '');
    assert.equal(await page.locator(ghost).count(), 1);
    await page.locator('button').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => insertions.length), 0);
    await page.locator('[data-composer-input]').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => insertions.length), 1);
    assert.equal(await page.locator(ghost).count(), 0);
    assert.equal(await page.locator('[data-composer-input]').evaluate(el => el.style.minHeight), '');
    assert.notEqual(await page.locator('[data-composer-placeholder]').evaluate(el => getComputedStyle(el).display), 'none');
    await page.evaluate(() => { runner.unmount(); dispose(); });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, narrow, wide, checks: ['native observers', 'responsive layout', 'editor remount', 'toolbar Tab', 'editor Tab', 'cleanup'], pageErrors: errors }, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
