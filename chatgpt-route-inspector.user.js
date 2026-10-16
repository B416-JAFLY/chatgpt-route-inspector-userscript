// ==UserScript==
// @name         ChatGPT 路由检测器 · 油猴版
// @namespace    https://github.com/B416-JAFLY/chatgpt-route-inspector-userscript
// @version      1.1.0
// @homepageURL  https://github.com/B416-JAFLY/chatgpt-route-inspector-userscript
// @supportURL   https://github.com/B416-JAFLY/chatgpt-route-inspector-userscript/issues
// @downloadURL  https://raw.githubusercontent.com/B416-JAFLY/chatgpt-route-inspector-userscript/main/chatgpt-route-inspector.user.js
// @updateURL    https://raw.githubusercontent.com/B416-JAFLY/chatgpt-route-inspector-userscript/main/chatgpt-route-inspector.user.js
// @description  显示请求模型、响应路由、模型标签、PoW 和额度快照；本地记录与导出。
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @inject-into  page
// @noframes
// ==/UserScript==

/* Independently implemented userscript, informed by the protocol handling in
 * https://github.com/Liu-Bot24/chatgpt-route-inspector
 * Reference revision: 05d8d5ab0a263690651a5982ab6cc43aebbd2615 (2026-10-16).
 * No remote code, dependencies, analytics, credential access or extra API calls.
 */
(() => {
  'use strict';
  if (window.top !== window.self || !['chatgpt.com', 'chat.openai.com'].includes(location.hostname)) return;
  const API = '__chatgptRouteInspectorUserscript';
  window[API]?.destroy?.();
  const KEY = 'cgri.userscript.v1';
  const MAX_HISTORY = 100;
  const MAX_BYTES = 12 * 1024 * 1024;
  const TTL = 10 * 60 * 1000;
  const native = { fetch: window.fetch, ws: window.WebSocket, open: XMLHttpRequest.prototype.open, send: XMLHttpRequest.prototype.send };
  const fields = ['requestedModel', 'thinkingEffort', 'resolvedModel', 'serverModel', 'modelLabel', 'domLabel', 'conversationId', 'requestId', 'task', 'plan'];
  const recordKeys = ['id', 'source', 'time', 'path', 'status', 'durationMs', 'httpStatus', 'error', 'pow', 'quota', ...fields];
  const keep = new Set(['message', 'messages', 'metadata', 'server_ste_metadata', 'author', 'role', 'type', 'id', 'parent', 'parent_id', 'conversation_id', 'model_slug', 'resolved_model_slug', 'default_model_slug', 'request_id', 'plan_type', 'limits_progress', 'feature_name', 'remaining', 'reset_after', 'topic_id', 'recipient', 'name', 'resource_name', 'invoked_resource', 'app_name', 'chatgpt_sdk', 'image_gen_title', 'widget_session_id', 'deep_research', 'task_type']);
  let alive = true, paused = false, epoch = 0, host, root, timer, renderTimer, saveTimer;
  let mode = 'full', view = 'live', historyOpen = false, path = location.pathname + location.search, visit = crypto.randomUUID(), domSignature = '', storageError = '';
  let records = [], pow = null, quota = null, clearedAt = 0;
  const pending = new Map(), readers = new Set(), sockets = new Map(), xhrInfo = new WeakMap();
  const str = value => typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
  const obj = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const merge = (a, b) => { for (const k of fields) if (b[k] != null) a[k] = b[k]; return a; };
  const conv = () => /\/c\/([^/]+)/.exec(location.pathname)?.[1] || null;
  const now = () => new Date().toISOString();
  const clean = value => Object.fromEntries(recordKeys.filter(k => value[k] !== undefined).map(k => [k, value[k]]));
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    // Reloaded data is validated; no arbitrary keys are carried into exports.
    records = Array.isArray(saved.records) ? saved.records.slice(0, MAX_HISTORY).filter(r => obj(r) && str(r.id) && str(r.time)).map(r => {
      const result = {};
      for (const k of ['id', 'source', 'time', 'path', 'status', 'error', ...fields]) if (str(r[k])) result[k] = r[k];
      for (const k of ['durationMs', 'httpStatus']) if (Number.isFinite(r[k])) result[k] = r[k];
      if (r.pow) { result.pow = parsePow({ pow: { difficulty: r.pow.hex } }); if (result.pow && str(r.pow.time)) result.pow.time = r.pow.time; }
      if (obj(r.quota)) result.quota = sanitizeQuota(r.quota);
      return result;
    }) : [];
    mode = ['full', 'compact', 'edge'].includes(saved.mode) ? saved.mode : 'full';
    clearedAt = Number.isFinite(saved.clearedAt) ? saved.clearedAt : 0;
  } catch { storageError = '本地存储不可用或记录损坏'; }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!alive) return;
      try {
        // Preserve records written by another ChatGPT tab, and respect clears.
        const other = JSON.parse(localStorage.getItem(KEY) || '{}');
        clearedAt = Math.max(clearedAt, Number.isFinite(other.clearedAt) ? other.clearedAt : 0);
        const merged = new Map();
        for (const r of Array.isArray(other.records) ? other.records.slice(0, MAX_HISTORY) : []) {
          if (obj(r) && str(r.id) && str(r.time) && Date.parse(r.time) > clearedAt) {
            const item = {};
            for (const k of ['id', 'source', 'time', 'path', 'status', 'error', ...fields]) if (str(r[k])) item[k] = r[k];
            for (const k of ['durationMs', 'httpStatus']) if (Number.isFinite(r[k])) item[k] = r[k];
            if (obj(r.pow)) { item.pow = parsePow({pow:{difficulty:r.pow.hex}}); if (item.pow && str(r.pow.time)) item.pow.time = r.pow.time; }
            if (obj(r.quota)) item.quota = sanitizeQuota(r.quota);
            merged.set(item.id, item);
          }
        }
        for (const r of records) if (Date.parse(r.time) > clearedAt) merged.set(r.id, r);
        records = [...merged.values()].sort((a,b) => Date.parse(b.time)-Date.parse(a.time)).slice(0, MAX_HISTORY);
        localStorage.setItem(KEY, JSON.stringify({ mode, clearedAt, records: records.map(clean) })); schedule();
      }
      catch { storageError = '记录未能保存（存储空间或隐私设置）'; schedule(); }
    }, 400);
  }
  function schedule() {
    if (!alive || renderTimer) return;
    renderTimer = setTimeout(() => { renderTimer = 0; render(); }, 120);
  }
  function classify(input) {
    try {
      const u = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (u.origin !== location.origin) return null;
      const p = u.pathname.replace(/\/$/, '');
      if (p === '/backend-api/conversation' || /^\/backend-api\/f\/conversations?$/.test(p)) return { kind: 'live' };
      if (p === '/backend-api/conversation/init') return { kind: 'quota' };
      if (/^\/(backend-api|backend-anon|api)\/sentinel\/chat-requirements(?:\/prepare)?$/.test(p)) return { kind: 'pow' };
      const m = /^\/backend-api\/conversations?\/([^/]+)$/.exec(p);
      if (m && !['cursor', 'offset', 'before', 'after'].some(k => u.searchParams.has(k))) return { kind: 'reload', id: decodeURIComponent(m[1]) };
    } catch { /* Ignore unrelated requests. */ }
    return null;
  }
  function project(value, depth = 0, budget = { n: 0 }) {
    if (++budget.n > 5000 || depth > 18) throw Error('metadata_limit');
    if (typeof value === 'string') return value.length <= 512 ? value : undefined;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 128).map(v => project(v, depth + 1, budget));
    if (!obj(value)) return undefined;
    const out = Object.create(null);
    for (const [k, v] of Object.entries(value)) if (keep.has(k)) {
      out[k] = k === 'image_gen_title' ? Boolean(v) : project(v, depth + 1, budget);
    }
    return out;
  }
  function sanitizeQuota(value) {
    const out = {};
    for (const feature of ['deep_research', 'image_gen']) if (obj(value[feature])) {
      const item = value[feature];
      out[feature] = {
        remaining: Number.isSafeInteger(item.remaining) && item.remaining >= 0 ? item.remaining : null,
        reset: typeof item.reset === 'string' && Number.isFinite(Date.parse(item.reset)) ? new Date(item.reset).toISOString() : null
      };
    }
    if (str(value.time)) out.time = value.time;
    return out;
  }
  function readQuota(value) {
    if (!Array.isArray(value?.limits_progress)) return null;
    const out = {};
    for (const item of value.limits_progress.slice(0, 128)) if (['deep_research', 'image_gen'].includes(item?.feature_name)) {
      out[item.feature_name] = { remaining: item.remaining, reset: item.reset_after };
    }
    return Object.keys(out).length ? { ...sanitizeQuota(out), time: now() } : null;
  }
  function parsePow(value) {
    for (const r of [value, value?.chat_requirements, value?.requirements]) {
      const hex = (r?.proofofwork || r?.proof_of_work || r?.pow)?.difficulty;
      if (typeof hex === 'string' && hex.length <= 256 && /^(?:0x)?[0-9a-f]+$/i.test(hex.trim())) {
        return { hex: hex.trim(), decimal: BigInt('0x' + hex.trim().replace(/^0x/i, '')).toString(), time: now() };
      }
    }
    return null;
  }
  function extract(value, result = {}, depth = 0, budget = { n: 0 }) {
    if (!value || typeof value !== 'object' || depth > 16 || ++budget.n > 5000) return result;
    if (Array.isArray(value)) { for (const v of value.slice(0, 128)) extract(v, result, depth + 1, budget); return result; }
    const meta = obj(value.metadata);
    if (str(value.conversation_id)) result.conversationId = value.conversation_id;
    if (str(value.resolved_model_slug)) result.resolvedModel = value.resolved_model_slug;
    if (str(value.request_id)) result.requestId = value.request_id;
    if (str(value.plan_type)) result.plan = value.plan_type;
    if (value.type === 'server_ste_metadata' && str(meta?.model_slug)) result.serverModel = meta.model_slug;
    if (value.author?.role === 'assistant' && str(meta?.model_slug)) result.modelLabel = meta.model_slug;
    if (str(value.server_ste_metadata?.model_slug)) result.serverModel = value.server_ste_metadata.model_slug;
    const q = readQuota(value); if (q) result.quota = q;
    const tool = [value.recipient, value.name, value.resource_name, value.invoked_resource, value.app_name, value.task_type].filter(v => typeof v === 'string').join(' ');
    if (value.image_gen_title || /(?:imagegen|image_gen|dall[-_]?e)/i.test(tool)) result.task = '图片生成';
    if (/deep[_-]?research|research_kickoff/i.test(tool) || value.deep_research === true) result.task = '深度研究';
    for (const [k, v] of Object.entries(value)) if (keep.has(k) && v && typeof v === 'object') extract(v, result, depth + 1, budget);
    return result;
  }
  function assessment(r) {
    const explicit = [...new Set([r.resolvedModel, r.serverModel].filter(Boolean))];
    const labels = [...new Set([r.modelLabel, r.domLabel].filter(Boolean))];
    const route = explicit.length === 1 ? explicit[0] : explicit.length ? null : labels.length === 1 ? labels[0] : null;
    const basis = explicit.length ? '显式路由字段' : labels.length ? '模型标签' : '无可用字段';
    let verdict = '等待响应证据';
    if (explicit.length > 1 || labels.length > 1 || (route && explicit.length && labels.some(x => x !== route))) verdict = '字段存在差异';
    else if (r.task) verdict = r.task + '任务';
    else if (route && (/^gpt-\d+(?:-\d+)?-auto-thinking$/.test(route) || r.requestedModel === 'auto')) verdict = '自动路由 / 推理';
    else if (route && r.requestedModel) verdict = route === r.requestedModel ? '模型一致' : '请求与响应不同';
    else if (route) verdict = '已捕获响应模型';
    return { route, basis, verdict };
  }

  // Metadata-only SSE delta reconstruction. Content paths update inherited
  // headers, but their values never enter a channel, record or export.
  class Decoder {
    constructor(accept) { this.accept = accept; this.buffer = ''; this.lines = []; this.event = ''; this.header = { c: 0, p: '', o: 'add' }; this.channels = new Map(); this.done = false; this.size = 0; }
    push(text) {
      this.buffer += text;
      let pos;
      while ((pos = this.buffer.search(/[\r\n]/)) >= 0) {
        if (this.buffer[pos] === '\r' && pos === this.buffer.length - 1) break;
        const line = this.buffer.slice(0, pos), crlf = this.buffer.slice(pos, pos + 2) === '\r\n';
        this.buffer = this.buffer.slice(pos + (crlf ? 2 : 1)); this.line(line);
      }
      if (this.buffer.length > 1024 * 1024) throw Error('event_limit');
    }
    line(line) {
      if (!line) { this.dispatch(); return; }
      if (line.startsWith('event:')) this.event = line.slice(6).trim();
      if (line.startsWith('data:')) { this.size += line.length; if (this.size > 1024 * 1024) throw Error('event_limit'); this.lines.push(line.slice(5).replace(/^ /, '')); }
    }
    finish() { if (this.buffer) this.line(this.buffer.replace(/\r$/, '')); this.buffer = ''; this.dispatch(); }
    dispatch() {
      const text = this.lines.join('\n'), event = this.event;
      this.lines = []; this.event = ''; this.size = 0;
      if (!text) return;
      if (text === '[DONE]') { this.done = true; this.channels.clear(); this.accept({ terminal: true }); return; }
      let item;
      try { item = JSON.parse(text); }
      catch { for (const line of text.split('\n')) { try { this.accept(project(JSON.parse(line))); } catch {} } return; }
      if (event === 'delta_encoding') { if (item !== 'v1') throw Error('unsupported_delta'); this.channels.clear(); this.header = { c: 0, p: '', o: 'add' }; return; }
      if (event === 'delta' && obj(item) && ['v', 'p', 'o', 'c'].some(k => Object.hasOwn(item, k))) {
        const h = { ...this.header };
        for (const k of ['c', 'p', 'o']) if (Object.hasOwn(item, k)) h[k] = item[k];
        if (!Number.isSafeInteger(h.c) || h.c < 0 || typeof h.p !== 'string' || h.p.length > 1024) throw Error('invalid_delta');
        this.header = h;
        if (!this.channels.has(h.c) && this.channels.size >= 32) throw Error('channel_limit');
        item = this.patch(this.channels.get(h.c), h.p, h.o, item.v, { n: 0 });
        if ((JSON.stringify(item)?.length || 0) > 65536) throw Error('metadata_limit');
        this.channels.set(h.c, item);
      } else item = project(item);
      if (item) this.accept(item);
    }
    patch(value, path, op, next, budget, depth = 0) {
      if (++budget.n > 512 || depth > 16 || typeof path !== 'string') throw Error('patch_limit');
      const keys = path ? path.replace(/^\//, '').split('/').map(k => k.replace(/~1/g, '/').replace(/~0/g, '~')) : [];
      if (keys.length > 16) throw Error('patch_limit');
      if (keys.some(k => !keep.has(k) && !/^(?:0|[1-9]\d{0,2})$/.test(k))) return value;
      const box = { value }; let parent = box, key = 'value';
      for (const k of keys) { if (!parent[key] || typeof parent[key] !== 'object') parent[key] = /^\d+$/.test(k) ? [] : Object.create(null); parent = parent[key]; key = k; if (Array.isArray(parent) && Number(key) >= 128) throw Error('array_limit'); }
      const previous = parent[key];
      if (op === 'patch') {
        if (!Array.isArray(next) || next.length > 512) throw Error('invalid_patch');
        let out = previous;
        for (const child of next) out = this.patch(out, child.p || '', child.o, child.v, budget, depth + 1);
        parent[key] = out;
      } else if (op === 'remove') { if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key]; }
      else if (op === 'truncate') { if (!Number.isSafeInteger(next) || next < 0) throw Error('invalid_truncate'); if (typeof previous === 'string' || Array.isArray(previous)) parent[key] = previous.slice(0, next); }
      else if (['add', 'replace', 'append'].includes(op)) {
        const projected = project(next);
        if (op === 'append' && obj(previous) && obj(projected)) Object.assign(previous, projected);
        else if (op === 'append' && Array.isArray(previous)) { previous.push(...(Array.isArray(projected) ? projected : [projected])); if (previous.length > 128) throw Error('array_limit'); }
        else if (op === 'append' && typeof previous === 'string' && typeof projected === 'string') { if (previous.length + projected.length > 512) throw Error('string_limit'); parent[key] = previous + projected; }
        else if (op === 'add' && Array.isArray(parent)) { if (parent.length >= 128) throw Error('array_limit'); parent.splice(Number(key), 0, projected); }
        else parent[key] = projected;
      } else throw Error('invalid_operation');
      return box.value;
    }
  }

  function newRecord(source, body, endpoint) {
    let request = {};
    if (typeof body === 'string' && body.length < MAX_BYTES) { try { request = JSON.parse(body); } catch {} }
    const r = { id: crypto.randomUUID(), visit, source, time: now(), path: location.pathname, status: '采集中', conversationId: str(request.conversation_id) || endpoint?.id || conv(), pow: pow ? { ...pow } : null, quota: quota ? structuredClone(quota) : null };
    if (source === 'live') { r.requestedModel = str(request.model); r.thinkingEffort = str(request.thinking_effort); }
    records.unshift(r); records.length = Math.min(records.length, MAX_HISTORY);
    const p = { r, epoch, started: performance.now(), inputId: str(request.messages?.[0]?.id), topics: new Set(), expires: Date.now() + TTL, decoder: null };
    pending.set(r.id, p); prune(); schedule(); save(); return p;
  }
  function prune() {
    for (const [id, p] of pending) if (p.expires < Date.now()) pending.delete(id);
    while (pending.size > 32) pending.delete(pending.keys().next().value);
  }
  function valid(p) { return alive && !paused && p.epoch === epoch; }
  function update(p, value) {
    if (!valid(p)) return;
    if (str(value.topic_id)) p.topics.add(value.topic_id);
    const f = extract(value); merge(p.r, f);
    if (f.quota) { quota = f.quota; p.r.quota = structuredClone(quota); }
    if (value.type === 'stream_handoff') p.r.status = '等待 WebSocket';
    if (value.type === 'server_ste_metadata' || value.terminal) p.r.status = '已完成';
    p.r.durationMs = Math.round(performance.now() - p.started);
    p.expires = Date.now() + TTL; schedule(); save();
  }
  function historyFields(value) {
    const mapping = obj(value?.mapping);
    if (mapping) {
      let key = typeof value.current_node === 'string' ? value.current_node : value.current_node?.id;
      const seen = new Set(); let result = {}, found = false;
      for (let n = 0; key && n < 128 && !seen.has(key); n++) {
        seen.add(key); const node = mapping[key]; if (!node) return found ? result : null;
        const m = node.message;
        if (m?.author?.role === 'user' && found) break;
        if (m?.author?.role === 'assistant' || (found && m?.author?.role === 'tool')) { result = { ...extract(project(m)), ...result }; found = true; }
        key = typeof node.parent === 'string' ? node.parent : node.parent?.id;
      }
      if (value.current_node) return found ? result : null;
      const candidates = Object.values(mapping).map(n => n?.message).filter(m => m?.author?.role === 'assistant');
      candidates.sort((a, b) => (a.create_time || 0) - (b.create_time || 0));
      return candidates.length ? extract(project(candidates.at(-1))) : null;
    }
    if (Array.isArray(value?.messages)) {
      const a = value.messages.filter(m => (m.message || m)?.author?.role === 'assistant').at(-1);
      return a ? extract(project(a.message || a)) : null;
    }
    return null;
  }
  async function inspect(response, endpoint, p, captureEpoch) {
    let reader, timeout, expired = false;
    try {
      if (!response.body) return;
      reader = response.body.getReader(); readers.add(reader);
      timeout = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, 180000);
      const text = new TextDecoder(), chunks = []; let bytes = 0;
      const sse = endpoint.kind === 'live' && /text\/event-stream/i.test(response.headers.get('content-type') || '');
      if (sse) p.decoder = new Decoder(v => update(p, v));
      while (alive && !paused && epoch === captureEpoch) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength; if (bytes > MAX_BYTES) throw Error('response_limit');
        const decoded = text.decode(chunk.value, { stream: true });
        if (sse) p.decoder.push(decoded); else chunks.push(decoded);
      }
      if (!alive || paused || epoch !== captureEpoch) return;
      if (expired) throw Error('capture_timeout');
      if (sse) { p.decoder.push(text.decode()); p.decoder.finish(); if (p.r.status === '采集中') p.r.status = '响应结束'; }
      else {
        chunks.push(text.decode()); const value = JSON.parse(chunks.join(''));
        if (endpoint.kind === 'pow') { pow = parsePow(value); schedule(); return; }
        const q = readQuota(value); if (q) { quota = q; schedule(); }
        if (endpoint.kind === 'quota') return;
        if (endpoint.kind === 'reload') {
          const f = historyFields(value);
          if (f) { merge(p.r, f); if (f.quota || q) p.r.quota = f.quota || q; p.r.status = '已读取'; }
          else p.r.status = '未提供模型字段';
        } else { update(p, project(value)); if (p.r.status === '采集中') p.r.status = '响应结束'; }
      }
      if (p) { p.r.durationMs = Math.round(performance.now() - p.started); schedule(); save(); }
    } catch (err) {
      if (p && valid(p) && p.r.status !== '已完成') {
        p.r.status = err?.name === 'AbortError' ? '流已中止' : '采集未完成';
        const known = ['metadata_limit', 'event_limit', 'unsupported_delta', 'invalid_delta', 'channel_limit', 'patch_limit', 'array_limit', 'invalid_patch', 'invalid_truncate', 'string_limit', 'invalid_operation', 'response_limit', 'capture_timeout'];
        p.r.error = known.includes(err?.message) ? err.message : err?.name === 'AbortError' ? 'stream_aborted' : 'parse_or_stream_error';
        schedule(); save();
      }
    } finally {
      clearTimeout(timeout);
      if (reader) { readers.delete(reader); void reader.cancel().catch(() => {}); }
    }
  }
  function wrappedFetch(input, init) {
    const endpoint = !paused && alive ? classify(input) : null;
    const captureEpoch = epoch;
    let body = typeof init?.body === 'string' ? Promise.resolve(init.body) : Promise.resolve(null);
    if (endpoint?.kind === 'live' && init?.body === undefined && input instanceof Request) { try { body = input.clone().text().catch(() => null); } catch {} }
    const promise = Reflect.apply(native.fetch, this, arguments);
    if (!endpoint) return promise;
    let p;
    const context = body.then(raw => {
      if (!alive || paused || epoch !== captureEpoch) return null;
      if (endpoint.kind === 'live' || endpoint.kind === 'reload') p = newRecord(endpoint.kind, raw, endpoint);
      return p;
    });
    // Observe a clone in the background; return the original promise unchanged.
    void promise.then(response => {
      let copy; try { copy = response.clone(); } catch { return; }
      void context.then(active => {
        if (!alive || paused || epoch !== captureEpoch) { void copy.body?.cancel().catch(() => {}); return; }
        if (active) { active.r.httpStatus = response.status; if (!response.ok) { active.r.status = 'HTTP ' + response.status; schedule(); save(); } }
        if (response.ok) void inspect(copy, endpoint, active, captureEpoch); else void copy.body?.cancel().catch(() => {});
      }).catch(() => { void copy.body?.cancel().catch(() => {}); });
    }, () => { void context.then(active => { if (active && valid(active)) { active.r.status = init?.signal?.aborted ? '已取消' : '网络失败'; schedule(); save(); } }); }).catch(() => {});
    return promise;
  }
  window.fetch = wrappedFetch;

  function wrappedOpen(method, url) { xhrInfo.set(this, { method, endpoint: classify(url) }); return Reflect.apply(native.open, this, arguments); }
  function wrappedSend(body) {
    const info = xhrInfo.get(this), captureEpoch = epoch;
    if (alive && !paused && info?.endpoint) {
      const endpoint = info.endpoint, p = ['live', 'reload'].includes(endpoint.kind) ? newRecord(endpoint.kind, body, endpoint) : null;
      this.addEventListener('loadend', () => {
        if (!alive || paused || epoch !== captureEpoch) return;
        try {
          if (p) p.r.httpStatus = this.status;
          if (this.status < 200 || this.status >= 300) { if (p) { p.r.status = 'HTTP / 网络失败 ' + this.status; schedule(); save(); } return; }
          const value = this.responseType === 'json' ? this.response : this.responseText;
          if (typeof value === 'string' && value.length > MAX_BYTES) throw Error('response_limit');
          if (typeof value === 'string' && /^\s*(?:event:|data:)/m.test(value) && p) { const decoder = new Decoder(v => update(p, v)); decoder.push(value); decoder.finish(); }
          else {
            const parsed = typeof value === 'string' ? JSON.parse(value) : value;
            if (endpoint.kind === 'pow') pow = parsePow(parsed);
            else if (p) { const f = endpoint.kind === 'reload' ? historyFields(parsed) : extract(project(parsed)); if (f) { merge(p.r, f); if (f.quota) p.r.quota = f.quota; } }
            const q = readQuota(parsed); if (q) { quota = q; if (p) p.r.quota = structuredClone(q); }
          }
          if (p && p.r.status === '采集中') p.r.status = '响应结束'; schedule(); save();
        } catch { if (p) { p.r.status = '采集未完成'; schedule(); save(); } }
      }, { once: true });
    }
    return Reflect.apply(native.send, this, arguments);
  }
  XMLHttpRequest.prototype.open = wrappedOpen;
  XMLHttpRequest.prototype.send = wrappedSend;

  function socketFrame(raw, topics) {
    if (!alive || paused || typeof raw !== 'string' || raw.length > 2 * 1024 * 1024) return;
    let data; try { data = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(data)) return;
    prune();
    for (const envelope of data.slice(0, 16)) {
      const encoded = envelope?.payload?.payload?.encoded_item, topic = str(envelope?.topic_id);
      if (typeof encoded !== 'string' || encoded.length > 1024 * 1024 || !topic) continue;
      let state = topics.get(topic);
      if (state && (state.epoch !== epoch || state.expires < Date.now())) { topics.delete(topic); state = null; }
      if (!state) {
        state = { p: null, epoch, expires: Date.now() + TTL, fields: {}, ids: new Set(), parents: new Set(), decoder: null };
        state.decoder = new Decoder(value => {
          const collect = (v, depth = 0) => {
            if (!obj(v) || depth > 8) return;
            for (const k of ['parent_id', 'parent']) if (str(v[k])) state.parents.add(v[k]);
            if (str(v.id) && v.author) state.ids.add(v.id);
            for (const k of ['message', 'metadata']) if (obj(v[k])) collect(v[k], depth + 1);
          };
          collect(value); const f = extract(value); Object.assign(state.fields, f);
          if (!state.p) {
            const candidates = [...pending.values()].filter(p => valid(p) && p.r.source === 'live' && (p.topics.has(topic) || (p.inputId && (state.parents.has(p.inputId) || state.ids.has(p.inputId)))));
            if (candidates.length === 1) { state.p = candidates[0]; state.p.topics.add(topic); }
          }
          if (state.p) { merge(state.p.r, state.fields); if (state.fields.quota) state.p.r.quota = state.fields.quota; update(state.p, value); }
        });
        if (topics.size >= 32) topics.delete(topics.keys().next().value);
        topics.set(topic, state);
      }
      try { state.decoder.push(encoded); state.decoder.finish(); state.expires = Date.now() + TTL; if (state.decoder.done) topics.delete(topic); }
      catch { topics.delete(topic); if (state.p) { state.p.r.status = 'WebSocket 解析失败'; schedule(); save(); } }
    }
  }
  let wrappedWS;
  if (native.ws) {
    wrappedWS = new Proxy(native.ws, { construct(Target, args, newTarget) {
      const socket = Reflect.construct(Target, args, newTarget), topics = new Map();
      const onMessage = event => { try { socketFrame(event.data, topics); } catch {} };
      const onClose = () => { topics.clear(); sockets.delete(socket); };
      socket.addEventListener('message', onMessage); socket.addEventListener('close', onClose, { once: true });
      sockets.set(socket, { topics, onMessage, onClose }); return socket;
    } });
    window.WebSocket = wrappedWS;
  }

  function current() {
    const id = conv();
    return records.find(r => r.source === view && (id ? r.conversationId === id : r.visit === visit));
  }
  // Positions contain only panel coordinates and are independent of network records.
  const POSITION_KEY = KEY + '.positions';
  const positions = {};
  let dragState = null, suppressClickUntil = 0, panelResizeObserver;
  try {
    const savedPositions = JSON.parse(localStorage.getItem(POSITION_KEY) || '{}');
    for (const name of ['full', 'compact', 'edge']) {
      const p = savedPositions?.[name];
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) positions[name] = { x: p.x, y: p.y };
    }
  } catch { /* A damaged layout must not prevent network inspection. */ }
  function savePositions() {
    try { localStorage.setItem(POSITION_KEY, JSON.stringify(positions)); }
    catch { /* Dragging remains available when storage is unavailable. */ }
  }
  function clampPosition(x, y, width, height) {
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    return {
      x: mode === 'edge' ? Math.max(0, viewportWidth - width) : Math.max(0, Math.min(x, Math.max(0, viewportWidth - width))),
      y: Math.max(0, Math.min(y, Math.max(0, viewportHeight - height)))
    };
  }
  function setPanelPosition(p) {
    host.style.left = mode === 'edge' ? 'auto' : p.x + 'px';
    host.style.right = mode === 'edge' ? '0px' : 'auto';
    host.style.top = p.y + 'px';
    host.style.bottom = 'auto';
  }
  function positionPanel() {
    if (!alive || !host?.isConnected || dragState) return;
    host.style.width = mode === 'edge' ? '36px' : 'auto';
    const savedPosition = positions[mode];
    if (savedPosition) setPanelPosition(savedPosition);
    else {
      host.style.left = 'auto'; host.style.right = mode === 'edge' ? '0px' : '16px';
      host.style.top = 'auto'; host.style.bottom = '24px';
    }
    const rect = host.getBoundingClientRect();
    setPanelPosition(clampPosition(rect.left, rect.top, rect.width, rect.height));
  }
  function startPanelDrag(event) {
    suppressClickUntil = 0;
    if (dragState || event.button !== 0 || !event.isPrimary) return;
    const handle = event.target.closest('[data-drag-handle]');
    if (!handle || (handle.matches('header') && event.target.closest('button, a, input, select, textarea'))) return;
    const rect = host.getBoundingClientRect();
    dragState = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: rect.left, y: rect.top, width: rect.width, height: rect.height, moving: false };
    event.stopPropagation();
  }
  function movePanelDrag(event) {
    const state = dragState;
    if (!state || state.pointerId !== event.pointerId) return;
    const dx = event.clientX - state.startX, dy = event.clientY - state.startY;
    if (!state.moving && Math.hypot(dx, dy) < 5) return;
    if (!state.moving) { try { host.setPointerCapture(event.pointerId); } catch { /* Window listeners retain the drag. */ } }
    state.moving = true;
    host.setAttribute('data-dragging', '');
    const p = clampPosition(state.x + dx, state.y + dy, state.width, state.height);
    setPanelPosition(p); positions[mode] = p;
    event.preventDefault(); event.stopPropagation();
  }
  function finishPanelDrag(event) {
    const state = dragState;
    if (!state || state.pointerId !== event.pointerId) return;
    dragState = null;
    host.removeAttribute('data-dragging');
    if (state.moving) { suppressClickUntil = performance.now() + 400; savePositions(); }
    if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
    positionPanel(); schedule();
  }
  function suppressDragClick(event) {
    if (event.detail !== 0 && performance.now() < suppressClickUntil) {
      suppressClickUntil = 0; event.preventDefault(); event.stopImmediatePropagation();
    }
  }
  function mount() {
    if (!alive || host?.isConnected || !document.documentElement) return;
    host = document.createElement('div'); host.id = 'cgri-userscript'; host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:24px;z-index:2147483646;max-width:calc(100vw - 24px);';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host{color-scheme:dark}#shell{font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#f1f5f9}header strong,dd,.item{color:#f1f5f9}dt{font-weight:500}dd{font-weight:500}
      [data-drag-handle]{cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}:host([data-dragging]) [data-drag-handle]{cursor:grabbing}
      *{box-sizing:border-box}button,select{font:inherit}button{cursor:pointer;border:1px solid #425169;border-radius:7px;background:#263348;color:#edf4ff;padding:5px 9px}button:hover{background:#364861}button:focus-visible,summary:focus-visible{outline:2px solid #59c8ff;outline-offset:2px}
      #panel{width:366px;max-width:calc(100vw - 24px);background:#111c2d;border:1px solid #526580;border-radius:13px;box-shadow:0 8px 32px #0006;overflow:hidden}header{display:flex;align-items:center;gap:6px;padding:10px 12px;background:#1c2a3e}header strong{flex:1;font-size:14px}nav{display:flex;gap:5px;padding:9px 12px 0}nav button[aria-pressed=true]{border-color:#50c5e7;color:#a5f3fc}.body{padding:10px 12px}.badge{color:#a5e1ff;font-weight:600;margin-bottom:8px}dl{display:grid;grid-template-columns:83px 1fr;gap:6px 10px;margin:0}dt{color:#c1cede}dd{margin:0;overflow-wrap:anywhere}small,.muted{color:#b8c6d9}footer{display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px 12px}details{margin-top:9px}summary{cursor:pointer;color:#c6d8ed}pre{color:#e2e8f0;white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.6 ui-monospace,monospace;max-height:220px;overflow:auto;background:#090f1b;border-radius:6px;padding:8px}.history{max-height:min(370px,55vh);overflow:auto;border-top:1px solid #3b4e66;padding:10px 12px}.item{padding:7px 0;border-bottom:1px solid #33445b;overflow-wrap:anywhere}.item small{display:block}#compact{max-width:270px;background:#18263d;color:#f1f5f9;padding:10px 14px;border-radius:12px;text-align:left;overflow-wrap:anywhere}#edge{display:block;width:100%;border-radius:10px 0 0 10px;padding:13px 7px;background:#1c3b52;color:#a9eaff;writing-mode:vertical-rl}#notice{color:#fcd34d;font-size:12px;margin-top:6px}#notice:empty{display:none}#panel{max-height:85vh;overflow:auto}@media(max-width:480px){#panel{width:330px}header{padding:8px}header strong{font-size:13px}}
      </style><section id="shell"></section>`;
    root.addEventListener('pointerdown', startPanelDrag);
    window.addEventListener('pointermove', movePanelDrag, true);
    window.addEventListener('pointerup', finishPanelDrag, true);
    window.addEventListener('pointercancel', finishPanelDrag, true);
    host.addEventListener('lostpointercapture', finishPanelDrag);
    host.addEventListener('click', suppressDragClick, true);
    window.addEventListener('resize', positionPanel);
    panelResizeObserver?.disconnect();
    if (typeof ResizeObserver === 'function') {
      panelResizeObserver = new ResizeObserver(positionPanel);
      panelResizeObserver.observe(host);
    }
    root.addEventListener('click', event => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      if (action === 'compact' || action === 'edge' || action === 'full') {
        if (!positions[action]) { const rect = host.getBoundingClientRect(); positions[action] = { x: rect.left, y: rect.top }; }
        mode = action; savePositions(); save();
      }
      if (action === 'live' || action === 'reload') view = action;
      if (action === 'history') historyOpen = !historyOpen;
      if (action === 'pause') { paused = !paused; epoch++; pending.clear(); for (const reader of readers) void reader.cancel().catch(() => {}); for (const state of sockets.values()) state.topics.clear(); }
      if (action === 'json' || action === 'md') download(action);
      if (action === 'clear' && window.confirm('清空本机保存的路由记录？')) { epoch++; clearedAt = Date.now(); records = []; pending.clear(); for (const reader of readers) void reader.cancel().catch(() => {}); for (const state of sockets.values()) state.topics.clear(); save(); }
      render();
    });
    root.addEventListener('change', event => { if (event.target.id === 'evidence') root.querySelector('pre')?.scrollTo(0, 0); });
    document.documentElement.append(host); render();
  }
  function escape(value) { return String(value ?? '—').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
  function date(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'; }
  function evidence(r) { return r ? { ...clean(r), assessment: assessment(r) } : {}; }
  function render() {
    if (!alive || !root || dragState) return;
    const shell = root.querySelector('#shell'), r = current(), a = assessment(r || {}), val = x => escape(x);
    if (mode === 'edge') { shell.innerHTML = '<button id="edge" data-drag-handle data-action="full" title="上下拖动；点击展开路由检测器">路由检测</button>'; positionPanel(); return; }
    if (mode === 'compact') { shell.innerHTML = `<button id="compact" data-drag-handle data-action="full" title="拖动移动；点击展开完整面板">${paused ? '已暂停 · ' : ''}${val(a.route || r?.modelLabel || '等待路由')}<br><small>PoW ${val(pow?.decimal)} · 点击展开</small></button>`; positionPanel(); return; }
    const open = root.querySelector('details')?.open;
    const q = r?.quota || quota;
    shell.innerHTML = `<section id="panel" aria-label="ChatGPT 路由检测器"><header data-drag-handle title="拖动移动面板"><strong>◉ ChatGPT 路由检测</strong><button data-action="compact" title="极简模式" aria-label="极简模式">−</button><button data-action="edge" title="收纳到边缘" aria-label="收纳到边缘">›</button></header>
      <nav aria-label="记录来源"><button data-action="live" aria-pressed="${view === 'live'}">实时请求</button><button data-action="reload" aria-pressed="${view === 'reload'}">会话重载</button><button data-action="pause">${paused ? '恢复采集' : '暂停'}</button></nav>
      <div class="body"><div class="badge">${paused ? '采集已暂停' : val(a.verdict)}</div><dl>
      <dt>请求模型</dt><dd>${val(r?.requestedModel)}</dd><dt>响应路由</dt><dd>${val(a.route)}</dd><dt>证据来源</dt><dd>${val(a.basis)}</dd><dt>模型标签</dt><dd>${val(r?.modelLabel || r?.domLabel)}</dd><dt>推理强度</dt><dd>${val(r?.thinkingEffort)}</dd><dt>状态</dt><dd>${val(r?.status || '等待当前会话的网络响应')}</dd><dt>PoW 难度</dt><dd>${val(pow?.decimal)}${pow ? ` <small>(0x${val(pow.hex.replace(/^0x/i, ''))})</small>` : ''}</dd>
      </dl><details ${open ? 'open' : ''}><summary>字段证据与额度快照</summary><small>重置时间使用浏览器本地时区；额度为捕获时的快照。</small><div>深度研究：${val(q?.deep_research?.remaining)} · 重置 ${val(date(q?.deep_research?.reset))}<br>图片生成：${val(q?.image_gen?.remaining)} · 重置 ${val(date(q?.image_gen?.reset))}<br>额度采集时间：${val(date(q?.time))}</div><pre>${val(JSON.stringify(evidence(r), null, 2))}</pre></details>
      <div id="notice">${val(storageError || '')}</div><small>仅观察页面已有网络响应 · 本机最多 ${MAX_HISTORY} 条记录</small></div>
      <footer><button data-action="history">${historyOpen ? '收起记录' : `本机记录 (${records.length})`}</button><button data-action="json">导出 JSON</button><button data-action="md">导出 Markdown</button></footer>
      ${historyOpen ? `<section class="history" aria-label="本机记录"><button data-action="clear">清空记录</button>${records.map(item => { const x = assessment(item); return `<div class="item"><small>${val(date(item.time))} · ${item.source === 'live' ? '实时' : '重载'} · ${val(item.status)}</small>${val(item.requestedModel)} → ${val(x.route || item.modelLabel)}<small>${val(x.verdict)}</small></div>`; }).join('') || '<p>暂无记录</p>'}</section>` : ''}</section>`;
    positionPanel();
  }
  function report(format) {
    const payload = { tool: 'ChatGPT Route Inspector Userscript', version: '1.1.0', exportedAt: now(), records: records.map(evidence) };
    if (format === 'json') return JSON.stringify(payload, null, 2);
    return '# ChatGPT 路由检测报告\n\n导出时间：' + payload.exportedAt + '\n\n' + payload.records.map(r => `## ${r.time}\n\n- 来源：${r.source}\n- 请求模型：${r.requestedModel || '—'}\n- 响应路由：${r.assessment.route || '—'}\n- 判断：${r.assessment.verdict}\n\n\x60\x60\x60json\n${JSON.stringify(r, null, 2)}\n\x60\x60\x60`).join('\n\n');
  }
  function download(format) {
    const url = URL.createObjectURL(new Blob([report(format)], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'chatgpt-routes-' + new Date().toISOString().replace(/[:.]/g, '-') + '.' + format; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function tick() {
    if (!alive) return;
    mount(); prune();
    if (path !== location.pathname + location.search) { path = location.pathname + location.search; visit = crypto.randomUUID(); domSignature = ''; schedule(); }
    // DOM labels supplement an actual captured record; never synthesize a route
    // for a page whose request was not observed.
    const r = current();
    if (r && !paused && !['采集中', '等待 WebSocket'].includes(r.status)) {
      const elements = document.querySelectorAll('[data-message-author-role="assistant"][data-message-model-slug]');
      const label = str(elements[elements.length - 1]?.getAttribute('data-message-model-slug'));
      const signature = r.id + ':' + label;
      if (label && signature !== domSignature) { domSignature = signature; r.domLabel = label; schedule(); save(); }
    }
  }
  function destroy() {
    if (!alive) return;
    alive = false; epoch++;
    dragState = null;
    panelResizeObserver?.disconnect();
    window.removeEventListener('resize', positionPanel);
    window.removeEventListener('pointermove', movePanelDrag, true);
    window.removeEventListener('pointerup', finishPanelDrag, true);
    window.removeEventListener('pointercancel', finishPanelDrag, true);
    clearInterval(timer); clearTimeout(renderTimer); clearTimeout(saveTimer);
    for (const reader of readers) void reader.cancel().catch(() => {});
    for (const [socket, state] of sockets) { socket.removeEventListener('message', state.onMessage); socket.removeEventListener('close', state.onClose); state.topics.clear(); }
    if (window.fetch === wrappedFetch) window.fetch = native.fetch;
    if (window.WebSocket === wrappedWS) window.WebSocket = native.ws;
    if (XMLHttpRequest.prototype.open === wrappedOpen) XMLHttpRequest.prototype.open = native.open;
    if (XMLHttpRequest.prototype.send === wrappedSend) XMLHttpRequest.prototype.send = native.send;
    pending.clear(); sockets.clear(); host?.remove();
    if (window[API]?.destroy === destroy) delete window[API];
  }
  // Developer API exposes only the same filtered metadata available in the UI.
  Object.defineProperty(window, API, { configurable: true, value: Object.freeze({ version: '1.1.0', destroy, snapshot: () => ({ paused, mode, records: records.map(evidence), pow, quota }), report }) });
  timer = setInterval(tick, 1000); tick();
})();
