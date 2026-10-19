import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientHarness } from './helpers/client-harness.js';

async function setup(t, options) {
  const client = await createClientHarness(options);
  t.after(() => client.dispose());
  return client;
}

async function ready(client, body = '请继续实现并验证这些修改') {
  await client.finishTurn();
  await client.advance();
  assert.equal(client.requests.length, 1, 'completed turn should request one prediction');
  await client.resolve(0, typeof body === 'string' ? { suggestion: body } : body);
  assert.ok(client.ghost(), 'prediction should appear inside the composer');
}

test('mounting an idle session does not predict; each running-to-idle transition predicts once', async (t) => {
  const client = await setup(t);
  await client.advance(5000);
  assert.equal(client.requests.length, 0);
  await client.finishTurn();
  await client.update({ session: { running: false }, input: { draft: '' } });
  await client.advance(5000);
  await client.update({ session: { running: false } });
  await client.advance(5000);
  assert.equal(client.requests.length, 1);
  assert.deepEqual(client.requests[0].request, { sessionId: 'session-a', generationTrigger: 'catch_up' });
  assert.equal(client.requests[0].headers['x-composer-predictions-token'], 'test-token');
  await client.finishTurn();
  await client.advance();
  assert.equal(client.requests.length, 2);
});

test('a draft already present when the assistant finishes suppresses prediction', async (t) => {
  const client = await setup(t, { props: { input: { draft: '我正在编辑下一条消息' } } });
  await client.finishTurn();
  await client.advance(5000);
  assert.equal(client.requests.length, 0);
  await client.update({ input: { draft: '' } });
  await client.advance(5000);
  assert.equal(client.requests.length, 0, 'clearing the draft should not revive a skipped prediction');
});

test('whitespace counts as an existing editable draft', async (t) => {
  const client = await setup(t, { props: { input: { draft: '  ' } } });
  await client.finishTurn();
  await client.advance(5000);
  assert.equal(client.requests.length, 0);
});

test('typing during the settling delay cancels that turn even if the draft is subsequently cleared', async (t) => {
  const client = await setup(t);
  await client.finishTurn();
  await client.advance(200);
  await client.update({ input: { draft: 'x' } });
  await client.update({ input: { draft: '' } });
  await client.advance(5000);
  assert.equal(client.requests.length, 0);
});

test('beforeinput cancels the pending timer before a draft state update arrives', async (t) => {
  const client = await setup(t);
  await client.finishTurn();
  await client.event('beforeinput', { inputType: 'insertText', data: '新' });
  await client.advance(5000);
  assert.equal(client.requests.length, 0);
});

test('disabling predictions during the delay prevents the captured enabled value from requesting', async (t) => {
  const client = await setup(t);
  await client.finishTurn();
  await client.toggle();
  await client.advance(5000);
  assert.equal(client.requests.length, 0);
  await client.toggle();
  await client.advance(5000);
  assert.equal(client.requests.length, 0, 'reenabling waits for the next completed turn');
});

test('disabling predictions aborts the request and ignores a late response', async (t) => {
  const client = await setup(t);
  await client.finishTurn();
  await client.advance();
  await client.toggle();
  assert.equal(client.requests[0].signal.aborted, true);
  await client.resolve(0, { suggestion: '旧请求的迟到结果' });
  await client.toggle();
  assert.equal(client.ghost(), null, 'reenabling must not reveal a disabled request result');
});

test('disabling a visible prediction clears the ghost and restores the placeholder', async (t) => {
  const client = await setup(t);
  await ready(client);
  assert.equal(client.placeholder.hasAttribute('data-prediction-hidden'), true);
  await client.toggle();
  assert.equal(client.ghost(), null);
  assert.equal(client.placeholder.hasAttribute('data-prediction-hidden'), false);
  await client.toggle();
  assert.equal(client.ghost(), null);
});

test('session changes abort requests; late previous-session responses cannot replace current predictions', async (t) => {
  const client = await setup(t);
  await client.finishTurn();
  await client.advance();
  await client.update({ sessionId: 'session-b', session: { running: false } });
  assert.equal(client.requests[0].signal.aborted, true);
  await client.finishTurn();
  await client.advance();
  assert.equal(client.requests.length, 2);
  await client.resolve(1, { suggestion: '当前会话的建议' });
  assert.match(client.ghostText(), /当前会话的建议/);
  await client.resolve(0, { suggestion: '旧会话的建议' });
  assert.match(client.ghostText(), /当前会话的建议/);
  assert.doesNotMatch(client.ghostText(), /旧会话/);
});

test('a new turn in the same session aborts the previous request and rejects its late result', async (t) => {
  const client = await setup(t);
  await client.finishTurn();
  await client.advance();
  await client.finishTurn();
  assert.equal(client.requests[0].signal.aborted, true);
  await client.advance();
  await client.resolve(1, { suggestion: '新一轮建议' });
  await client.resolve(0, { suggestion: '上一轮建议' });
  assert.match(client.ghostText(), /新一轮建议/);
  assert.doesNotMatch(client.ghostText(), /上一轮/);
});

test('unmount aborts the request and late completion never restores a ghost', async (t) => {
  const client = await setup(t);
  await client.finishTurn();
  await client.advance();
  await client.unmount();
  assert.equal(client.requests[0].signal.aborted, true);
  await client.resolve(0, { suggestion: '卸载后的结果' });
  await client.advance(5000);
  assert.equal(client.ghost(), null);
});

test('a request that exceeds the response deadline is aborted and cannot publish late output', async (t) => {
  const client = await setup(t);
  await client.finishTurn();
  await client.advance();
  await client.advance(40000);
  assert.equal(client.requests[0].signal.aborted, true);
  await client.resolve(0, { suggestion: '超时后的结果' });
  assert.equal(client.ghost(), null);
  await client.finishTurn();
  await client.advance();
  await client.resolve(1, { suggestion: '下轮仍能继续' });
  assert.ok(client.ghost());
});

test('session change and unmount both remove a visible ghost', async (t) => {
  const client = await setup(t);
  await ready(client);
  await client.update({ sessionId: 'session-b' });
  assert.equal(client.ghost(), null);
  await client.finishTurn();
  await client.advance();
  await client.resolve(1, { suggestion: '第二个会话' });
  assert.ok(client.ghost());
  await client.unmount();
  assert.equal(client.ghost(), null);
  assert.equal(client.placeholder.hasAttribute('data-prediction-hidden'), false);
});

test('Tab in an empty focused editor inserts one editable draft and never sends', async (t) => {
  const client = await setup(t);
  await ready(client, '请补充一个使用示例');
  const event = await client.event('keydown', { key: 'Tab' });
  assert.equal(event.defaultPrevented, true);
  assert.equal(client.inserted.length, 1);
  assert.equal(client.inserted[0].text, '请补充一个使用示例');
  assert.equal(client.sent.length, 0);
  assert.equal(client.ghost(), null);
  const second = await client.event('keydown', { key: 'Tab' });
  assert.equal(second.defaultPrevented, false);
  assert.equal(client.inserted.length, 1);
});

test('Tab on a composer toolbar button retains keyboard navigation and does not accept', async (t) => {
  const client = await setup(t);
  await ready(client);
  client.button.focus();
  const event = await client.event('keydown', { key: 'Tab' });
  assert.equal(event.defaultPrevented, false);
  assert.equal(client.inserted.length, 0);
});

test('an insertion rejected by the editor preserves native Tab behavior', async (t) => {
  const client = await setup(t, { props: { inputActions: { captureInsertion: () => null, insertText: () => false } } });
  await ready(client);
  const event = await client.event('keydown', { key: 'Tab' });
  assert.equal(event.defaultPrevented, false);
  assert.ok(client.ghost());
});

test('Shift+Tab, modified Tab, and IME Tab are never swallowed', async (t) => {
  const client = await setup(t);
  await ready(client);
  for (const modifier of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { keyCode: 229 }]) {
    const event = await client.event('keydown', { key: 'Tab', ...modifier });
    assert.equal(event.defaultPrevented, false, JSON.stringify(modifier));
    assert.equal(client.inserted.length, 0, JSON.stringify(modifier));
  }
});

test('a nonempty live editor cannot accept while the draft prop still lags behind', async (t) => {
  const client = await setup(t);
  await ready(client);
  client.editor.textContent = '已经输入';
  const event = await client.event('keydown', { key: 'Tab' });
  assert.equal(event.defaultPrevented, false);
  assert.equal(client.inserted.length, 0);
});

test('arrow keys cycle candidates and Tab inserts the selected one', async (t) => {
  const client = await setup(t);
  await ready(client, { suggestions: ['第一条候选', '第二条候选', '第三条候选'] });
  assert.match(client.ghostText(), /第一条候选/);
  assert.match(client.ghostText(), /1\/3/);
  const down = await client.event('keydown', { key: 'ArrowDown' });
  assert.equal(down.defaultPrevented, true);
  assert.match(client.ghostText(), /第二条候选/);
  assert.match(client.ghostText(), /2\/3/);
  await client.event('keydown', { key: 'ArrowDown' });
  assert.match(client.ghostText(), /第三条候选/);
  await client.event('keydown', { key: 'ArrowDown' });
  assert.match(client.ghostText(), /第一条候选/, 'Down wraps to the first candidate');
  await client.event('keydown', { key: 'ArrowUp' });
  assert.match(client.ghostText(), /第三条候选/, 'Up wraps to the last candidate');
  const tab = await client.event('keydown', { key: 'Tab' });
  assert.equal(tab.defaultPrevented, true);
  assert.equal(client.inserted.length, 1);
  assert.equal(client.inserted[0].text, '第三条候选');
  assert.equal(client.sent.length, 0);
  assert.equal(client.ghost(), null);
});

test('a single candidate leaves the arrow keys native', async (t) => {
  const client = await setup(t);
  await ready(client, '唯一的候选');
  const event = await client.event('keydown', { key: 'ArrowDown' });
  assert.equal(event.defaultPrevented, false);
  assert.equal(client.inserted.length, 0);
  assert.match(client.ghostText(), /唯一的候选/);
  assert.doesNotMatch(client.ghostText(), /1\/1/);
});

test('modified arrows and a typed draft keep native arrow behavior', async (t) => {
  const client = await setup(t);
  await ready(client, { suggestions: ['第一候选', '第二候选'] });
  for (const modifier of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
    const event = await client.event('keydown', { key: 'ArrowDown', ...modifier });
    assert.equal(event.defaultPrevented, false, JSON.stringify(modifier));
    assert.match(client.ghostText(), /第一候选/, JSON.stringify(modifier));
  }
  client.editor.textContent = '已经输入';
  const typed = await client.event('keydown', { key: 'ArrowDown' });
  assert.equal(typed.defaultPrevented, false);
  assert.match(client.ghostText(), /第一候选/);
});

test('a new prediction restarts at the first candidate', async (t) => {
  const client = await setup(t);
  await ready(client, { suggestions: ['第一轮甲', '第一轮乙'] });
  await client.event('keydown', { key: 'ArrowDown' });
  assert.match(client.ghostText(), /第一轮乙/);
  await client.event('keydown', { key: 'Escape' });
  assert.equal(client.ghost(), null);
  await client.finishTurn();
  await client.advance();
  await client.resolve(1, { suggestions: ['第二轮甲', '第二轮乙'] });
  assert.match(client.ghostText(), /第二轮甲/);
  assert.match(client.ghostText(), /1\/2/);
});

test('Escape dismisses the ghost without inserting or sending', async (t) => {
  const client = await setup(t);
  await ready(client);
  await client.event('keydown', { key: 'Escape' });
  assert.equal(client.ghost(), null);
  assert.equal(client.inserted.length, 0);
  assert.equal(client.sent.length, 0);
});

for (const type of ['beforeinput', 'compositionstart', 'paste', 'drop']) {
  test(`${type} immediately clears the ghost before draft state catches up`, async (t) => {
    const client = await setup(t);
    await ready(client);
    await client.event(type, { inputType: 'insertCompositionText' });
    assert.equal(client.ghost(), null);
    const tab = await client.event('keydown', { key: 'Tab' });
    assert.equal(tab.defaultPrevented, false);
    assert.equal(client.inserted.length, 0);
  });

  test(`${type} aborts an in-flight request and ignores the late result`, async (t) => {
    const client = await setup(t);
    await client.finishTurn();
    await client.advance();
    await client.event(type);
    assert.equal(client.requests[0].signal.aborted, true);
    await client.resolve(0, { suggestion: '输入开始之后的结果' });
    assert.equal(client.ghost(), null);
  });
}

test('Enter clears the prediction without consuming the editor submit shortcut', async (t) => {
  const client = await setup(t);
  await ready(client);
  const event = await client.event('keydown', { key: 'Enter' });
  assert.equal(event.defaultPrevented, false);
  assert.equal(client.ghost(), null);
  assert.equal(client.inserted.length, 0);
  assert.equal(client.sent.length, 0);
});

test('editor remount in the same container reattaches the ghost and restores the old placeholder', async (t) => {
  const client = await setup(t);
  await ready(client, '编辑器替换后继续显示');
  const originalGhost = client.ghost();
  client.editor.remove();
  client.placeholder.remove();
  const nextEditor = client.document.createElement('div');
  nextEditor.setAttribute('data-composer-input', 'true');
  const nextPlaceholder = client.document.createElement('div');
  nextPlaceholder.setAttribute('data-composer-placeholder', 'true');
  client.grow.append(nextEditor, nextPlaceholder);
  await client.flush();
  await client.advance(20);
  assert.ok(client.ghost());
  assert.notEqual(client.ghost(), originalGhost);
  assert.equal(client.placeholder.hasAttribute('data-prediction-hidden'), false);
  assert.equal(nextPlaceholder.hasAttribute('data-prediction-hidden'), true);
  assert.match(client.ghostText(), /编辑器替换后继续显示/);
  nextEditor.focus();
  await client.event('keydown', { key: 'Tab' });
  assert.equal(client.inserted[0].text, '编辑器替换后继续显示');
  assert.equal(client.ghost(), null);
});

test('layout grows for wrapped text, shrinks after widening, and restores the original styles on dismissal', async (t) => {
  const client = await setup(t);
  client.editor.style.minHeight = '28px';
  await ready(client);
  const text = client.document.querySelector('[data-composer-predictions="inline-text"]');
  text.rectHeight = 80;
  client.editor.clientWidth = 200;
  client.deliverResize(client.editor);
  await client.advance(20);
  assert.equal(client.editor.style.minHeight, '88px');
  assert.equal(text.style.width, '184px');
  text.rectHeight = 20;
  client.editor.clientWidth = 500;
  client.deliverResize(client.editor);
  await client.advance(20);
  assert.equal(client.editor.style.minHeight, '28px');
  assert.equal(text.style.width, '484px');
  await client.event('keydown', { key: 'Escape' });
  assert.equal(client.editor.style.minHeight, '28px');
  assert.equal(client.grow.style.position, '');
});
