'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const { setMaxListeners } = require('node:events');
const scope = new AsyncLocalStorage();
const error = (status, message) => Object.assign(new Error(message), { status });

function checkpoint() {
  const context = scope.getStore();
  if (!context) return;
  if (performance.now() >= context.deadline) context.expire();
  if (context.signal.aborted) throw context.signal.reason;
}

// Wrap individual requests, never shared pools: cancellation must not affect another job.
function request(parent) {
  checkpoint();
  const req = parent.request();
  const signal = scope.getStore()?.signal;
  if (!signal) return req;
  for (const method of ['query', 'batch']) {
    const original = req[method];
    req[method] = async function (...args) {
      checkpoint();
      const cancel = () => { try { req.cancel(); } catch (_) {} };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        const result = await original.apply(req, args);
        checkpoint();
        return result;
      } finally {
        signal.removeEventListener('abort', cancel);
      }
    };
  }
  return req;
}

class WorkLimits {
  constructor({ maxQueued = 2, queueTimeoutMs = 30000, jobTimeoutMs = 180000 } = {}) {
    Object.assign(this, { maxQueued, queueTimeoutMs, jobTimeoutMs });
    this.groups = new Map();
  }

  isBusy(key) {
    return this.groups.get(key)?.active === true;
  }

  run(key, fn, { signal, noQueue = false, onTimeout } = {}) {
    let group = this.groups.get(key);
    if (!group) this.groups.set(key, group = { active: false, queue: [] });
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (group.active && (noQueue || group.queue.length >= this.maxQueued)) {
      return Promise.reject(error(503, `${key}: 工作忙碌，請稍後重試`));
    }
    return new Promise((resolve, reject) => {
      const job = { fn, resolve, reject, onTimeout };
      const remove = (reason) => {
        const index = group.queue.indexOf(job);
        if (index < 0) return;
        group.queue.splice(index, 1);
        job.cleanup();
        reject(reason);
      };
      const abort = () => remove(signal.reason);
      job.cleanup = () => {
        clearTimeout(job.timer);
        signal?.removeEventListener('abort', abort);
      };
      if (!group.active) this.start(group, job);
      else {
        group.queue.push(job);
        signal?.addEventListener('abort', abort, { once: true });
        job.timer = setTimeout(() => remove(error(503, `${key}: 排隊等待逾時`)), this.queueTimeoutMs);
      }
    });
  }

  start(group, job) {
    group.active = true;
    job.cleanup();
    const controller = new AbortController();
    // One listener per parallel SQL request; each is removed when its request settles.
    setMaxListeners(0, controller.signal);
    const expire = () => {
      if (controller.signal.aborted) return;
      const reason = error(504, '整輪執行逾時；已要求取消查詢，請確認寫入狀態後再補撈');
      controller.abort(reason);
      try { job.onTimeout?.(reason); } catch (_) {}
      job.reject(reason);
    };
    const timer = setTimeout(expire, this.jobTimeoutMs);
    scope.run({ signal: controller.signal, deadline: performance.now() + this.jobTimeoutMs, expire }, async () => {
      try {
        const result = await job.fn();
        checkpoint();
        job.resolve(result);
      } catch (e) {
        job.reject(e);
      } finally {
        clearTimeout(timer);
        // Keep the slot occupied until cancellation/rollback really finishes.
        group.active = false;
        const next = group.queue.shift();
        if (next) this.start(group, next);
      }
    });
  }
}

module.exports = { WorkLimits, checkpoint, request };
