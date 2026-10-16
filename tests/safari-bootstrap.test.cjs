const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '..', 'chatgpt-route-inspector-safari.user.js'), 'utf8');

function environment({ blocked = false, nonce = 'test-page-nonce' } = {}) {
  const attrs = new Map(), elements = new Map(), timeouts = [];
  let page, resourceCallback, nativeCalls = 0, nativePromise;
  const shell = { innerHTML: '' };
  const document = {
    querySelectorAll: q => q === 'script[nonce]' && nonce ? [{ nonce }] : [],
    getElementById: id => elements.get(id) || null,
    createElement: tag => ({
      tag, style: {}, isConnected: false, textContent: '', remove() {}, click() {},
      attachShadow: () => ({ innerHTML: '', addEventListener() {}, querySelector: q => q === '#shell' ? shell : null })
    })
  };
  const parent = {
    getAttribute: k => attrs.get(k), setAttribute: (k, v) => attrs.set(k, v),
    appendChild(el) {
      if (el.tag === 'script') {
        if (!blocked && (!nonce || el.nonce === nonce)) vm.runInContext(el.textContent, page);
      } else { el.isConnected = true; if (el.id) elements.set(el.id, el); }
      return el;
    },
    append(el) { this.appendChild(el); }
  };
  document.documentElement = document.head = parent;
  const location = { hostname: 'chatgpt.com', origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/test', pathname: '/c/test', search: '' };
  const shared = {
    document, location, crypto: webcrypto, URL, Request, TextDecoder, structuredClone, performance,
    setTimeout: fn => (timeouts.push(fn), timeouts.length), clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    MutationObserver: class { observe() {} disconnect() {} },
    PerformanceObserver: class { constructor(cb) { resourceCallback = cb; } observe() {} disconnect() {} }
  };
  const app = {
    ...shared, fetch() {
      nativeCalls++;
      nativePromise = Promise.resolve(new Response(JSON.stringify({ resolved_model_slug: 'test-route' }), { headers: { 'content-type': 'application/json' } }));
      return nativePromise;
    },
    XMLHttpRequest: class { open() {} send() {} }, WebSocket: class {}, localStorage: { getItem: () => null, setItem() {} }
  };
  app.window = app; app.top = app.self = app;
  page = vm.createContext(app);
  const outer = { ...shared, fetch: () => {}, XMLHttpRequest: class {}, WebSocket: class {} };
  outer.window = outer; outer.top = outer.self = outer;
  const outerFetch = outer.fetch, originalPageFetch = app.fetch;
  vm.runInContext(source, vm.createContext(outer));
  return { app, outer, outerFetch, originalPageFetch, attrs, elements, timeouts, shell,
    resources: entries => resourceCallback({ getEntries: () => entries }),
    get nativeCalls() { return nativeCalls; }, get nativePromise() { return nativePromise; } };
}

test('injects into the page, acknowledges startup and leaves extension globals alone', async () => {
  const e = environment();
  assert.equal(e.outer.fetch, e.outerFetch);
  assert.notEqual(e.app.fetch, e.originalPageFetch);
  const api = e.app.__chatgptRouteInspectorUserscript;
  assert.equal(api.version, '1.0.2');
  assert(e.attrs.has('data-cgri-page-bootstrap'));
  assert(e.elements.has('cgri-userscript'));
  assert(e.shell.innerHTML.includes('Safari 诊断（1.0.2 · 页面注入）'));
  assert.equal(e.nativeCalls, 0, 'installation must not issue extra requests');
  const result = e.app.fetch('/backend-api/conversation', { body: JSON.stringify({ model: 'test-model', conversation_id: 'test' }) });
  assert.equal(result, e.nativePromise, 'return the original fetch promise');
  await result;
  await new Promise(setImmediate);
  e.resources([{ name: 'https://chatgpt.com/backend-api/conversation?private=not-recorded' }]);
  const state = api.snapshot();
  assert.equal(state.diagnostics.fetchCalls, 1);
  assert.equal(state.diagnostics.matchedCalls, 1);
  assert.equal(state.diagnostics.resourceMatches, 1);
  assert(!JSON.stringify(state.diagnostics).includes('not-recorded'));
  assert.equal(state.records[0].requestedModel, 'test-model');
  assert.equal(state.records[0].resolvedModel, 'test-route');
  assert.equal(e.nativeCalls, 1);
  api.destroy();
  assert.equal(e.app.fetch, e.originalPageFetch);
});

test('reports blocked page injection without installing extension-world network hooks', () => {
  const e = environment({ blocked: true });
  assert.equal(e.app.fetch, e.originalPageFetch);
  assert.equal(e.outer.fetch, e.outerFetch);
  assert.equal(e.app.__chatgptRouteInspectorUserscript, undefined);
  e.timeouts[0]();
  assert(e.elements.get('cgri-bootstrap-error').textContent.includes('页面端启动未获确认'));
  assert.equal(e.nativeCalls, 0);
});

test('can start on a page without a nonce when inline scripts are allowed', () => {
  const e = environment({ nonce: '' });
  assert(e.attrs.has('data-cgri-page-bootstrap'));
  assert.equal(e.nativeCalls, 0);
  e.app.__chatgptRouteInspectorUserscript.destroy();
});
