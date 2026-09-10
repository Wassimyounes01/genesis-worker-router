'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { WorkerRouter, createSessionCliAdapter } = require('../index.cjs');

test('router rejects malformed limits and partial provider successes', async () => {
  assert.throws(() => new WorkerRouter({ providers: [{ invoke: async () => ({ ok: true, text: 'x' }) }], maxAttempts: NaN }), /finite positive integer/);
  const router = new WorkerRouter({ providers: [{ name: 'bad', invoke: async () => ({}) }], maxAttempts: 1, accountCooldownMs: 0 });
  const result = await router.run({ prompt: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid-provider-result');
  const empty = new WorkerRouter({ providers: [{ name: 'empty', invoke: async () => ({ ok: true, text: '' }) }], maxAttempts: 1, accountCooldownMs: 0 }).run({ prompt: 'x' });
  assert.equal((await empty).error.code, 'invalid-provider-result');
  const partial = await new WorkerRouter({ providers: [{ name: 'partial', invoke: async () => ({ ok: true, text: 'x', partial: true }) }], maxAttempts: 1, accountCooldownMs: 0 }).run({ prompt: 'x' });
  assert.equal(partial.error.code, 'partial-provider-result');
  const markedTruncated = await new WorkerRouter({ providers: [{ name: 'truncated', invoke: async () => ({ ok: true, text: 'x', truncated: true }) }], maxAttempts: 1, accountCooldownMs: 0 }).run({ prompt: 'x' });
  assert.equal(markedTruncated.error.code, 'output-limit');
  assert.throws(() => new WorkerRouter({ providers: [{ invoke: async () => ({ ok: true, text: 'x' }) }], maxAttempts: 1000001 }), /<=/);
});

test('pre-aborted requests do not reserve budget or call providers, and nonretryable errors stop', async () => {
  let calls = 0;
  const controller = new AbortController(); controller.abort();
  const router = new WorkerRouter({ providers: [{ name: 'p', invoke: async () => { calls++; return { ok: false, retryable: false, error: { code: 'permanent', message: 'no' } }; } }], maxAttempts: 3, accountCooldownMs: 0 });
  const aborted = await router.run({ prompt: 'x', signal: controller.signal });
  assert.equal(aborted.error.code, 'aborted');
  assert.equal(router.snapshot().usage.p === undefined, true);
  const failed = await router.run({ prompt: 'x' });
  assert.equal(failed.error.code, 'permanent');
  assert.equal(failed.attempts, 1);
  assert.equal(calls, 1);
});

test('non-cooperative provider keeps the concurrency slot after timeout', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const router = new WorkerRouter({ providers: [{ name: 'slow', invoke: async () => { await pending; return { ok: true, text: 'late' }; } }], maxAttempts: 1, maxConcurrency: 1, accountCooldownMs: 0 });
  const first = await router.run({ prompt: 'x', deadlineMs: 10 });
  assert.equal(first.error.code, 'deadline-exceeded');
  const second = await router.run({ prompt: 'y', deadlineMs: 10 });
  assert.equal(second.error.code, 'deadline-exceeded');
  release();
});

test('router shares attempts, daily cap, and keeps unknown usage unknown', async () => {
  let calls = 0;
  const router = new WorkerRouter({
    providers: [{ name: 'one', accountId: 'acct-a', invoke: async () => { calls++; return { ok: false, error: { code: 'busy', message: 'temporarily unavailable' } }; } }, { name: 'two', accountId: 'acct-b', invoke: async () => ({ ok: true, text: 'done' }) }],
    maxAttempts: 2, dailyCap: 1, accountCooldownMs: 0, deadlineMs: 1000,
  });
  const result = await router.run({ prompt: 'hello', model: 'model-x' });
  assert.equal(result.ok, true);
  assert.equal(result.actualModel, null);
  assert.equal(result.monetaryCost, null);
  assert.equal(calls, 1);
  assert.equal(router.snapshot().usage[`${new Date().toISOString().slice(0, 10)}\0acct-a`], 1);
});

test('concurrency cap rejects after shared deadline', async () => {
  let release;
  const blocker = new Promise(resolve => { release = resolve; });
  const router = new WorkerRouter({ providers: [{ name: 'p', invoke: async () => { await blocker; return { ok: true, text: 'ok' }; } }], maxConcurrency: 1, maxAttempts: 1, deadlineMs: 30, accountCooldownMs: 0 });
  const first = router.run({ prompt: 'first', deadlineMs: 200 });
  await new Promise(resolve => setTimeout(resolve, 3));
  const second = await router.run({ prompt: 'second', deadlineMs: 10 });
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'deadline-exceeded');
  release();
  await first;
});

test('session adapter uses shell=false, strips API keys, bounds output, and cleans temp cwd', async () => {
  let captured;
  const spawn = (exe, args, options) => {
    captured = { exe, args, options };
    const child = new EventEmitter();
    child.pid = 999999;
    child.stdin = { end() {} };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => { child.stdout.emit('data', 'reply'); child.emit('close', 0); });
    return child;
  };
  const tempRoot = os.tmpdir();
  const adapter = createSessionCliAdapter({ executable: 'session-tool', askMode: 'ask', tempRoot, env: { PATH: 'safe', DEMO_API_KEY: 'do-not-pass' }, spawn });
  const result = await adapter.invoke({ prompt: 'question' });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'reply');
  assert.equal(captured.options.shell, false);
  assert.deepEqual(captured.args, ['ask']);
  assert.equal(captured.options.env.DEMO_API_KEY, undefined);
  assert.equal(captured.options.env.GH_TOKEN, undefined);
  assert.equal(captured.options.env.CURSOR_AUTH, undefined);
  assert.equal(fsExists(captured.options.cwd), false);
});

test('CLI output exactly at the cap succeeds without double-counting a chunk', async () => {
  const spawn = (exe, args, options) => {
    const child = new EventEmitter(); child.pid = 999998; child.stdin = { end() {} }; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    queueMicrotask(() => { child.stdout.emit('data', '123'); child.stdout.emit('data', '45'); child.emit('close', 0); }); return child;
  };
  const adapter = createSessionCliAdapter({ executable: 'session-tool', askMode: 'ask', stdoutCap: 5, spawn });
  const result = await adapter.invoke({ prompt: 'question' });
  assert.equal(result.ok, true); assert.equal(result.text, '12345');
});

function fsExists(value) { try { require('node:fs').accessSync(value); return true; } catch (_) { return false; } }
