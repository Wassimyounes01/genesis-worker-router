'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: nodeSpawn } = require('node:child_process');

const MAX_ERROR = 4000;
const MAX_TEXT = 64 * 1024;
const MAX_BOUND = 1_000_000;

function bounded(value, max = MAX_ERROR) {
  return String(value == null ? '' : value).slice(0, max);
}

function errorResult(code, message, extra = {}) {
  return { ok: false, error: { code, message: bounded(message) }, ...extra };
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function safeKey(value, fallback = 'unknown-account') {
  const text = String(value == null ? '' : value).trim();
  return text ? text.slice(0, 160) : fallback;
}

function positiveInt(value, name, fallback, maximum = MAX_BOUND) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 1 || number > maximum) throw new TypeError(`${name} must be a finite positive integer <= ${maximum}`);
  return number;
}

class WorkerRouter {
  constructor(options = {}) {
    if (!Array.isArray(options.providers) || options.providers.length === 0) {
      throw new TypeError('providers must be a non-empty array');
    }
    this.providers = options.providers.map((provider, index) => {
      if (!provider || typeof provider.invoke !== 'function') throw new TypeError(`provider ${index} requires invoke`);
      return Object.freeze({ ...provider, name: safeKey(provider.name, `provider-${index}`) });
    });
    this.maxAttempts = positiveInt(options.maxAttempts, 'maxAttempts', 2);
    this.maxConcurrency = positiveInt(options.maxConcurrency, 'maxConcurrency', 1);
    this.dailyCap = options.dailyCap == null ? Infinity : Number(options.dailyCap);
    if (options.dailyCap != null && (!Number.isFinite(this.dailyCap) || !Number.isInteger(this.dailyCap) || this.dailyCap < 0 || this.dailyCap > MAX_BOUND)) throw new TypeError(`dailyCap must be a finite non-negative integer <= ${MAX_BOUND} or omitted`);
    this.accountCooldownMs = options.accountCooldownMs == null ? 30_000 : Number(options.accountCooldownMs);
    if (!Number.isFinite(this.accountCooldownMs) || !Number.isInteger(this.accountCooldownMs) || this.accountCooldownMs < 0 || this.accountCooldownMs > MAX_BOUND) throw new TypeError(`accountCooldownMs must be a finite non-negative integer <= ${MAX_BOUND}`);
    this.outputCap = positiveInt(options.outputCap, 'outputCap', MAX_TEXT);
    this.errorCap = positiveInt(options.errorCap, 'errorCap', MAX_ERROR);
    this.deadlineMs = positiveInt(options.deadlineMs, 'deadlineMs', 120_000);
    this.clock = typeof options.now === 'function' ? options.now : () => Date.now();
    this.active = 0;
    this.nextProvider = 0;
    this.usage = new Map();
    this.cooldowns = new Map();
  }

  dayKey() {
    return new Date(this.clock()).toISOString().slice(0, 10);
  }

  accountKey(provider) { return safeKey(provider.accountId || provider.account || provider.name); }

  usageKey(provider) { return `${this.dayKey()}\0${this.accountKey(provider)}`; }

  isCoolingDown(provider, now = this.clock()) {
    return (this.cooldowns.get(this.accountKey(provider)) || 0) > now;
  }

  remainingDaily(provider) {
    if (!Number.isFinite(this.dailyCap)) return Infinity;
    return this.dailyCap - (this.usage.get(this.usageKey(provider)) || 0);
  }

  pickProviders(request = {}) {
    const model = request.model == null ? null : String(request.model);
    const ordered = [];
    for (let i = 0; i < this.providers.length; i++) ordered.push(this.providers[(this.nextProvider + i) % this.providers.length]);
    this.nextProvider = (this.nextProvider + 1) % this.providers.length;
    return ordered.filter(provider => {
      if (model && Array.isArray(provider.models) && provider.models.length && !provider.models.includes(model)) return false;
      return true;
    });
  }

  async acquire(deadline) {
    while (this.active >= this.maxConcurrency) {
      if (this.clock() >= deadline) return false;
      await sleep(Math.min(10, Math.max(1, deadline - this.clock())));
    }
    this.active++;
    return true;
  }

  release() { this.active = Math.max(0, this.active - 1); }

  async invoke(provider, request, deadline) {
    if (request.signal?.aborted) return errorResult('aborted', 'request was aborted before provider dispatch', { retryable: false });
    const acquired = await this.acquire(deadline);
    if (!acquired) return errorResult('deadline-exceeded', 'shared deadline elapsed while waiting for concurrency');
    if (request.signal?.aborted) { this.release(); return errorResult('aborted', 'request was aborted before provider dispatch', { retryable: false }); }
    const controller = new AbortController();
    const remaining = Math.max(1, deadline - this.clock());
    const externalSignal = request.signal;
    let removeExternal;
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort(externalSignal.reason);
      else {
        removeExternal = () => controller.abort(externalSignal.reason);
        externalSignal.addEventListener('abort', removeExternal, { once: true });
      }
    }
    const timer = setTimeout(() => controller.abort(new Error('deadline exceeded')), remaining);
    let result;
    let providerSettled = false;
    try {
      const providerPromise = Promise.resolve().then(() => provider.invoke({ ...request, signal: controller.signal, deadlineAt: deadline }));
      const timeoutPromise = new Promise(resolve => {
        const timer = setTimeout(() => resolve({ ok: false, error: { code: 'deadline-exceeded', message: 'shared deadline elapsed' } }), remaining + 1);
        providerPromise.finally(() => clearTimeout(timer)).catch(() => {});
      });
      providerPromise.then(() => { providerSettled = true; }, () => { providerSettled = true; });
      result = await Promise.race([providerPromise, timeoutPromise]);
      if (!providerSettled && result?.error?.code === 'deadline-exceeded') {
        controller.abort(new Error('deadline exceeded'));
        // Keep the concurrency slot reserved until a non-cooperative provider actually settles.
        providerPromise.finally(() => this.release()).catch(() => {});
      }
    } catch (error) {
      result = errorResult('provider-error', error && error.message ? error.message : String(error));
    } finally {
      clearTimeout(timer);
      if (removeExternal) externalSignal.removeEventListener('abort', removeExternal);
      if (providerSettled || result?.error?.code !== 'deadline-exceeded') this.release();
    }
    if (!result || typeof result !== 'object' || result.ok !== true && result.ok !== false) result = errorResult('invalid-provider-result', 'provider must return an object with explicit ok:true or ok:false');
    if (result.ok === true && (typeof result.text !== 'string' || result.text.length === 0)) result = errorResult('invalid-provider-result', 'provider ok:true result requires non-empty string text');
    if (result.ok === true && result.partial === true) result = errorResult('partial-provider-result', 'provider marked its result partial', { retryable: false });
    if (result.ok === true && result.truncated === true) result = errorResult('output-limit', 'provider marked its result truncated', { retryable: false });
    if (result.ok === true && result.text.length > this.outputCap) result = errorResult('output-limit', 'provider text exceeded configured output cap', { retryable: false });
    if (result.ok === false) {
      const account = this.accountKey(provider);
      if (this.accountCooldownMs > 0) this.cooldowns.set(account, this.clock() + this.accountCooldownMs);
      return errorResult(result.error?.code || 'provider-failed', result.error?.message || result.error || 'provider failed', { provider: provider.name, retryable: result.retryable !== false });
    }
    const text = bounded(result.text, this.outputCap);
    return {
      ok: true,
      text,
      truncated: String(result.text || '').length > this.outputCap,
      provider: provider.name,
      // Providers must explicitly report these; absence is intentionally unknown.
      actualModel: result.actualModel ?? null,
      monetaryCost: result.monetaryCost ?? null,
      usage: result.usage ?? null,
    };
  }

  reserve(provider) {
    if (this.remainingDaily(provider) <= 0) return false;
    const key = this.usageKey(provider);
    this.usage.set(key, (this.usage.get(key) || 0) + 1);
    return true;
  }

  async run(request = {}) {
    if (!request || typeof request.prompt !== 'string' || !request.prompt.trim()) return errorResult('invalid-request', 'prompt must be a non-empty string');
    if (request.signal?.aborted) return errorResult('aborted', 'request was aborted before provider dispatch');
    const startedAt = this.clock();
    const duration = Number(request.deadlineMs ?? this.deadlineMs);
    if (!Number.isFinite(duration) || !Number.isInteger(duration) || duration < 1) return errorResult('invalid-request', 'deadlineMs must be a finite positive integer');
    const deadline = startedAt + duration;
    const providers = this.pickProviders(request);
    const attempted = [];
    let last = null;
    for (let attempt = 0; attempt < this.maxAttempts && this.clock() < deadline; attempt++) {
      const eligible = providers.filter(provider => !this.isCoolingDown(provider) && this.remainingDaily(provider) > 0);
      const fresh = eligible.filter(provider => !attempted.includes(provider.name));
      const candidates = fresh.length ? fresh : eligible;
      if (!candidates.length) break;
      const provider = candidates[0];
      attempted.push(provider.name);
      if (!this.reserve(provider)) continue;
      const result = await this.invoke(provider, { ...request, attempt: attempt + 1 }, deadline);
      last = result;
      if (result.ok) return { ...result, requestedModel: request.model ?? null, attempts: attempt + 1, elapsedMs: this.clock() - startedAt };
      if (result.retryable === false) break;
      if (result.error?.code === 'aborted') break;
      if (result.error?.code === 'deadline-exceeded') break;
    }
    const code = this.clock() >= deadline ? 'deadline-exceeded' : last?.error?.code || 'no-provider-available';
    const message = last?.error?.message || (attempted.length ? 'all eligible providers failed or cooled down' : 'all providers are capped, cooling down, or incompatible');
    return errorResult(code, message, {
      requestedModel: request.model ?? null,
      actualModel: null,
      monetaryCost: null,
      attempts: attempted.length,
      providersTried: attempted,
      elapsedMs: this.clock() - startedAt,
    });
  }

  snapshot() {
    return {
      active: this.active,
      maxConcurrency: this.maxConcurrency,
      dailyCap: Number.isFinite(this.dailyCap) ? this.dailyCap : null,
      usage: Object.fromEntries(this.usage),
      cooldowns: Object.fromEntries(this.cooldowns),
    };
  }
}

function scrubEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => !/(?:API[_-]?KEY|ACCESS[_-]?TOKEN|SECRET|(?:^|_)TOKEN$|GH_TOKEN)/i.test(key) && !(key === 'CURSOR_AUTH' && String(value).toLowerCase() === 'key')));
}

function killTree(child, spawnImpl = nodeSpawn) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') spawnImpl('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { shell: false, windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch (_) {
    try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
  }
}

function createSessionCliAdapter(options = {}) {
  if (!options.executable || typeof options.executable !== 'string') throw new TypeError('executable is required');
  if (!options.askMode || typeof options.askMode !== 'string') throw new TypeError('askMode is required');
  const tempRoot = path.resolve(options.tempRoot || os.tmpdir());
  const spawnImpl = options.spawn || nodeSpawn;
  const stdoutCap = positiveInt(options.stdoutCap, 'stdoutCap', MAX_TEXT);
  const stderrCap = positiveInt(options.stderrCap, 'stderrCap', MAX_ERROR);
  return {
    name: options.name || 'session-cli',
    accountId: options.accountId || 'session',
    async invoke(request = {}) {
      let cwd;
      try { cwd = fs.mkdtempSync(path.join(tempRoot, 'genesis-session-')); }
      catch (error) { return errorResult('temp-cwd-failed', error.message); }
      let child;
      let stdout = '';
      let stderr = '';
      let settled = false;
      let childClosed = false;
      const finish = value => { if (settled) return; settled = true; return value; };
      try {
        const extraArgs = typeof options.buildArgs === 'function' ? options.buildArgs(request) : [];
        if (!Array.isArray(extraArgs) || extraArgs.some(value => typeof value !== 'string')) throw new TypeError('buildArgs must return string[]');
        if (request.signal?.aborted) return errorResult('aborted', 'request was aborted before CLI spawn');
        const timeoutMs = request.timeoutMs == null ? 120_000 : Number(request.timeoutMs);
        if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_BOUND) return errorResult('invalid-request', `timeoutMs must be a finite positive integer <= ${MAX_BOUND}`);
        child = spawnImpl(options.executable, [options.askMode, ...extraArgs], { cwd, shell: false, detached: process.platform !== 'win32', windowsHide: true, env: scrubEnvironment(options.env || process.env), stdio: ['pipe', 'pipe', 'pipe'] });
        const result = await new Promise(resolve => {
          let timedOut = false;
          let limited = false;
          const timer = setTimeout(() => { timedOut = true; killTree(child, spawnImpl); }, timeoutMs);
          const abort = () => { timedOut = true; killTree(child, spawnImpl); };
          request.signal?.addEventListener('abort', abort, { once: true });
          const clean = () => { clearTimeout(timer); request.signal?.removeEventListener('abort', abort); };
          child.stdout?.on('data', chunk => { const text = String(chunk); const available = stdoutCap - stdout.length; if (text.length > available) { stdout += text.slice(0, available); limited = true; killTree(child, spawnImpl); } else stdout += text; });
          child.stderr?.on('data', chunk => { const text = String(chunk); const available = stderrCap - stderr.length; if (text.length > available) { stderr += text.slice(0, available); limited = true; killTree(child, spawnImpl); } else stderr += text; });
          child.on('error', error => { clean(); resolve(errorResult('spawn-error', error.message)); });
          child.on('close', code => {
            childClosed = true;
            clean();
            if (limited) return resolve(errorResult('output-limit', 'CLI output exceeded configured cap', { stdout: bounded(stdout, stdoutCap), stderr: bounded(stderr, stderrCap) }));
            if (timedOut) return resolve(errorResult('deadline-exceeded', 'CLI process exceeded its deadline', { stdout: bounded(stdout, stdoutCap), stderr: bounded(stderr, stderrCap) }));
            if (code !== 0) return resolve(errorResult('cli-exit', `CLI exited with code ${code}`, { stdout: bounded(stdout, stdoutCap), stderr: bounded(stderr, stderrCap) }));
            resolve({ ok: true, text: bounded(stdout, stdoutCap), stderr: bounded(stderr, stderrCap), actualModel: null, monetaryCost: null });
          });
          if (child.stdin) { child.stdin.end(String(request.prompt || '')); }
        });
        return result;
      } catch (error) {
        return errorResult('adapter-error', error.message);
      } finally {
        try { if (child && !childClosed) killTree(child, spawnImpl); } catch (_) {}
        try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
      }
    },
  };
}

module.exports = { WorkerRouter, createRouter: options => new WorkerRouter(options), createSessionCliAdapter, scrubEnvironment, bounded };
