import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { apply, inject, name } from '../predict-server.js';

const user = (text) => ({ type: 'user/message', data: { content: [{ type: 'text', text }] } });
const assistant = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
const route = { provider: 'test-provider', model: 'test-model' };

function setup(options = {}) {
  const calls = [];
  let handler;
  let token;
  const session = {
    id: 'session-1',
    snapshotEvents: () => options.events ?? [user('帮我完成登录功能'), assistant('已完成登录功能。')],
    requestHeader: () => ({ config: Object.hasOwn(options, 'route') ? options.route : route }),
  };
  const ctx = {
    agents: { get: (id) => !options.missing && id === session.id ? { session } : undefined },
    get: () => ({ currentSelection: () => options.defaultRoute }),
    llm: {
      stream: (args) => {
        calls.push(args);
        if (options.stream) return options.stream(args);
        return (async function* () {
          yield { type: 'text-delta', text: options.text ?? '请补充登录失败的错误提示。' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    },
    inject: (services, activate) => {
      assert.deepEqual(services, ['webServer']);
      activate({
        webServer: { register: (entry) => { handler = entry.handler; assert.equal(entry.path, '/composer-predictions/predict'); return () => {}; } },
        effect: (callback) => callback(),
        on: (event, callback) => {
          assert.equal(event, 'webserver/index-inject');
          const table = [];
          callback(table);
          assert.equal(table[0].name, '__DSH_COMPOSER_PREDICTIONS_TOKEN__');
          token = table[0].value;
        },
      });
    },
  };
  apply(ctx);
  function begin({ method = 'POST', auth = token } = {}) {
    const req = new PassThrough();
    req.method = method;
    req.headers = { 'x-composer-predictions-token': auth };
    const res = new EventEmitter();
    Object.assign(res, { writableEnded: false, destroyed: false, headers: {}, writes: 0 });
    res.setHeader = (key, value) => { res.headers[key] = value; };
    res.end = (text) => { res.writes += 1; res.writableEnded = true; res.body = JSON.parse(text); };
    const done = handler(req, res);
    return { req, res, done };
  }
  async function request(body = { sessionId: session.id }, options) {
    const pending = begin(options);
    pending.req.end(typeof body === 'string' ? body : JSON.stringify(body));
    await pending.done;
    return pending.res;
  }
  return { request, begin, calls };
}

test('keeps the host injection and HTTP response contract', async () => {
  assert.equal(name, 'composerPredictions');
  assert.deepEqual(inject, ['llm', 'agents']);
  const host = setup();
  const response = await host.request();
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body.suggestion, '请补充登录失败的错误提示。');
  assert.deepEqual(response.body.model, route);
  assert.equal(host.calls[0].maxTokens, 1500);
  assert.equal(host.calls[0].sessionId, 'session-1');
});

test('rejects an invalid method or capability token before calling the model', async () => {
  const host = setup();
  const method = await host.request({}, { method: 'GET' });
  assert.equal(method.statusCode, 405);
  assert.equal(method.headers.allow, 'POST');
  const unauthorized = await host.request({}, { auth: 'wrong-token' });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(host.calls.length, 0);
});

test('rejects malformed, oversized, and missing-session requests', async () => {
  const host = setup();
  assert.equal((await host.request('{broken')).statusCode, 400);
  assert.equal((await host.request({ sessionId: '   ' })).statusCode, 400);
  assert.equal((await host.request(null)).statusCode, 400);
  assert.equal((await host.request('中'.repeat(23000))).statusCode, 413);
  assert.equal(host.calls.length, 0);
});

test('returns a useful error for request-body stream failures', async () => {
  const host = setup();
  const pending = host.begin();
  pending.req.emit('error', new Error('stream failed'));
  await pending.done;
  assert.equal(pending.res.statusCode, 400);
  assert.match(pending.res.body.error.message, /could not be read/);
  assert.equal(pending.req.listenerCount('data'), 0);
});

test('returns no suggestion without conversation text', async () => {
  const host = setup({ events: [{ type: 'tool/result', data: { content: 'not conversation' } }] });
  const response = await host.request();
  assert.equal(response.body.reason, 'empty-thread');
  assert.equal(response.body.suggestion, null);
  assert.equal(host.calls.length, 0);
});

test('rejects a missing session or missing model route', async () => {
  assert.equal((await setup({ missing: true }).request()).statusCode, 409);
  const host = setup({ route: { provider: '', model: '  ' }, defaultRoute: { provider: 'x' } });
  assert.equal((await host.request()).statusCode, 409);
  assert.equal(host.calls.length, 0);
});

test('validates the current route and falls back to the latest valid event', async () => {
  const host = setup({
    route: { provider: 'provider-with-no-model' },
    events: [
      user('继续完善功能'),
      { type: 'request/header', data: { header: { config: { provider: ' old ', model: ' model ' } } } },
      { type: 'request/header', data: { header: { config: { provider: ' ', model: 'bad' } } } },
      assistant('功能已完成。'),
    ],
  });
  await host.request();
  assert.equal(host.calls[0].provider, 'old');
  assert.equal(host.calls[0].model, 'model');
});

test('uses the default model when no session route is valid', async () => {
  const host = setup({ route: {}, defaultRoute: { provider: ' default ', model: ' fast ' } });
  await host.request();
  assert.equal(host.calls[0].provider, 'default');
  assert.equal(host.calls[0].model, 'fast');
});

test('keeps the latest user goal and assistant reply in bounded JSON context', async () => {
  const events = [user('保留这个用户目标')];
  for (let i = 0; i < 24; i += 1) events.push(assistant(`中间回复 ${i}: ${'x'.repeat(8000)}`));
  events.push(assistant('最新回复：已经完成。'));
  const host = setup({ events });
  await host.request();
  const text = host.calls[0].messages[0].content[0].text;
  const transcript = text.split('Conversation transcript (JSON data):\n')[1].split('\n\nSuggest one useful')[0];
  const rows = JSON.parse(transcript);
  assert.ok(transcript.length <= 12000);
  assert.ok(rows.length <= 18);
  assert.equal(rows[0].text, '保留这个用户目标');
  assert.equal(rows.at(-1).text, '最新回复：已经完成。');
  assert.match(host.calls[0].system, /Do not invent user preferences/);
});

test('supports plain text message content and heavily escaped text', async () => {
  const host = setup({ events: [
    { type: 'user/message', data: { content: '\u0001'.repeat(10000) + '用户目标' } },
    { type: 'assistant/message', data: { content: '已完成' } },
  ] });
  await host.request();
  const text = host.calls[0].messages[0].content[0].text;
  const transcript = text.split('Conversation transcript (JSON data):\n')[1].split('\n\nSuggest one useful')[0];
  const rows = JSON.parse(transcript);
  assert.ok(transcript.length <= 12000);
  assert.equal(rows[0].role, 'user');
  assert.match(rows[0].text, /用户目标$/);
  assert.equal(rows[1].text, '已完成');
});

test('preserves meaningful quotes and trailing code backticks', async () => {
  for (const suggestion of ['把 "foo" 改成 "bar"', '请解释 `npm test`', '“快速开始” 改成 “开始使用”', 'SKIP the optional download and explain the result.']) {
    const response = await setup({ text: ` \n${suggestion}\n ` }).request();
    assert.equal(response.body.suggestion, suggestion);
  }
});

test('only the exact SKIP token or empty output is treated as skipped', async () => {
  for (const text of ['SKIP', ' skip\n', '\n ']) {
    const response = await setup({ text }).request();
    assert.equal(response.body.suggestion, null);
    assert.equal(response.body.reason, 'skipped');
  }
});

test('discards oversized output instead of returning a truncated command', async () => {
  for (const length of [401, 2000]) {
    const response = await setup({ text: 'a'.repeat(length) }).request();
    assert.equal(response.body.suggestion, null);
    assert.equal(response.body.reason, 'too-long');
  }
  const response = await setup({ text: '🙂'.repeat(300) }).request();
  assert.equal(Array.from(response.body.suggestion).length, 300);
});

test('supports text block completion when a provider has no text deltas', async () => {
  const host = setup({ stream: () => (async function* () { yield { type: 'block-end', block: { type: 'text', text: '请增加一个示例。' } }; })() });
  assert.equal((await host.request()).body.suggestion, '请增加一个示例。');
});

test('reports provider errors and cancellation without returning partial text', async () => {
  const failed = setup({ stream: () => (async function* () {
    yield { type: 'text-delta', text: 'partial' };
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider unavailable' } } };
  })() });
  const response = await failed.request();
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.error.message, 'provider unavailable');
  const cancelled = setup({ stream: () => (async function* () { yield { type: 'finish', reason: { kind: 'aborted' } }; })() });
  assert.equal((await cancelled.request()).statusCode, 499);
});

test('rejects short but incomplete output when the token budget is exhausted', async () => {
  const host = setup({ stream: () => (async function* () {
    yield { type: 'text-delta', index: 0, text: '请执行 `npm' };
    yield { type: 'finish', reason: { kind: 'max-tokens' } };
  })() });
  const response = await host.request();
  assert.equal(response.body.suggestion, null);
  assert.equal(response.body.reason, 'incomplete');
});

test('collects multiple completed text blocks with or without indexes', async () => {
  for (const indexed of [true, false]) {
    const host = setup({ stream: () => (async function* () {
      yield { type: 'block-end', ...(indexed ? { index: 0 } : {}), block: { type: 'text', text: '请补充测试，' } };
      yield { type: 'block-end', ...(indexed ? { index: 1 } : {}), block: { type: 'text', text: '然后解释结果。' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })() });
    assert.equal((await host.request()).body.suggestion, '请补充测试，然后解释结果。');
  }
});

test('assembles interleaved blocks in index order without duplicating deltas', async () => {
  const host = setup({ stream: () => (async function* () {
    yield { type: 'text-delta', index: 2, text: '再检查' };
    yield { type: 'text-delta', index: 0, text: '先测试，' };
    yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'private reasoning' } };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '先测试，' } };
    yield { type: 'block-end', index: 2, block: { type: 'text', text: '再检查结果。' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })() });
  assert.equal((await host.request()).body.suggestion, '先测试，再检查结果。');
});

test('bounds a model stream that ignores cancellation to 30 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let signal;
  const host = setup({ stream: (args) => (async function* () {
    signal = args.signal;
    started();
    await new Promise(() => {});
  })() });
  const request = host.request();
  await ready;
  t.mock.timers.tick(30000);
  const response = await request;
  assert.equal(response.statusCode, 504);
  assert.equal(response.body.error.code, 'prediction-timeout');
  assert.equal(signal.aborted, true);
});

test('also bounds a request body that never finishes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = setup().begin();
  pending.req.write('{');
  t.mock.timers.tick(30000);
  await pending.done;
  assert.equal(pending.res.statusCode, 504);
  assert.equal(pending.req.listenerCount('data'), 0);
  assert.equal(pending.req.listenerCount('end'), 0);
});

test('cancels on disconnect without writing to a destroyed response', async () => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let signal;
  const host = setup({ stream: (args) => (async function* () {
    signal = args.signal;
    started();
    await new Promise(() => {});
  })() });
  const pending = host.begin();
  pending.req.end(JSON.stringify({ sessionId: 'session-1' }));
  await ready;
  pending.res.destroyed = true;
  pending.res.emit('close');
  await pending.done;
  assert.equal(signal.aborted, true);
  assert.equal(pending.res.writes, 0);
  assert.equal(pending.res.listenerCount('close'), 0);
  assert.equal(pending.req.listenerCount('aborted'), 0);
});
