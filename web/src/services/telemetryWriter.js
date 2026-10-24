const DEFAULT_MAX_QUEUE = 5000;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_BASE_MS = 50;

const channels = new Map();

const batchHandlers = new Map();

function registerBatchHandler(name, handler) {
  batchHandlers.set(name, handler);
}

function channelState(name) {
  if (!channels.has(name)) {
    channels.set(name, {
      name,
      queue: [],
      activeBatch: null,
      active: false,
      accepted: 0,
      written: 0,
      failed: 0,
      dropped: 0,
      retries: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastErrorCode: null,
    });
  }
  return channels.get(name);
}

/**
 * Bounded, per-channel telemetry queue with retry and observable health state.
 * Tasks must already be sanitized and must not contain credentials.
 */
function enqueueTelemetry(channel, payload, options = {}) {
  const state = channelState(channel);
  const maxQueue = positiveInt(process.env.SENTINEL_WRITER_MAX_QUEUE, options.maxQueue || DEFAULT_MAX_QUEUE);
  if (state.queue.length >= maxQueue) {
    state.dropped += 1;
    state.lastFailureAt = new Date().toISOString();
    state.lastErrorCode = 'QUEUE_CAPACITY_EXCEEDED';
    logFailure(channel, state.lastErrorCode, 0);
    return Promise.resolve(false);
  }

  state.accepted += 1;
  return new Promise((resolve) => {
    state.queue.push({
      payload,
      resolve,
      maxAttempts: positiveInt(
        process.env.SENTINEL_WRITER_MAX_ATTEMPTS,
        options.maxAttempts || DEFAULT_MAX_ATTEMPTS
      ),
      retryBaseMs: positiveInt(
        process.env.SENTINEL_WRITER_RETRY_BASE_MS,
        options.retryBaseMs || DEFAULT_RETRY_BASE_MS
      ),
    });
    pump(state);
  });
}

function pump(state) {
  if (state.active || (!state.queue.length && !state.activeBatch)) return;
  state.active = true;

  if (!state.activeBatch) {
    const size = Math.min(state.queue.length, 500);
    const items = state.queue.splice(0, size);
    state.activeBatch = {
      items,
      attempt: 0,
      maxAttempts: items[0]?.maxAttempts || DEFAULT_MAX_ATTEMPTS,
      retryBaseMs: items[0]?.retryBaseMs || DEFAULT_RETRY_BASE_MS,
    };
  }

  const batch = state.activeBatch;
  batch.attempt += 1;

  const registeredHandler = batchHandlers.get(state.name);
  const payloads = batch.items.map(i => i.payload);
  const handler = registeredHandler || (payloads.every((payload) => typeof payload === 'function')
    ? async (tasks) => {
        for (const task of tasks) await task();
      }
    : null);
  if (!handler) {
    state.activeBatch = null;
    state.active = false;
    state.failed += payloads.length;
    state.lastFailureAt = new Date().toISOString();
    state.lastErrorCode = 'WRITER_HANDLER_MISSING';
    logFailure(state.name, state.lastErrorCode, 0);
    for (const item of batch.items) item.resolve(false);
    return pump(state);
  }

  Promise.resolve()
    .then(() => handler(payloads))
    .then(() => {
      state.written += payloads.length;
      state.lastSuccessAt = new Date().toISOString();
      state.lastErrorCode = null;
      state.activeBatch = null;
      state.active = false;
      for (const item of batch.items) item.resolve(true);
      pump(state);
    })
    .catch((error) => {
      state.active = false;
      const code = safeErrorCode(error);
      state.lastFailureAt = new Date().toISOString();
      state.lastErrorCode = code;
      
      if (batch.attempt < batch.maxAttempts) {
        state.retries += 1;
        const delay = Math.min(batch.retryBaseMs * (2 ** (batch.attempt - 1)), 5000);
        setTimeout(() => pump(state), delay);
        return;
      }
      
      state.failed += payloads.length;
      state.activeBatch = null;
      logFailure(state.name, code, batch.attempt);
      for (const item of batch.items) item.resolve(false);
      pump(state);
    });
}

function getTelemetryWriterStatus() {
  const writers = {};
  let pending = 0;
  let failed = 0;
  let dropped = 0;
  for (const [name, state] of channels.entries()) {
    const snapshot = {
      pending: state.queue.length,
      active: state.active,
      accepted: state.accepted,
      written: state.written,
      failed: state.failed,
      dropped: state.dropped,
      retries: state.retries,
      lastSuccessAt: state.lastSuccessAt,
      lastFailureAt: state.lastFailureAt,
      lastErrorCode: state.lastErrorCode,
    };
    writers[name] = snapshot;
    pending += snapshot.pending;
    failed += snapshot.failed;
    dropped += snapshot.dropped;
  }
  return { pending, failed, dropped, writers };
}

async function waitForTelemetryIdle(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = getTelemetryWriterStatus();
    if (status.pending === 0 && !Object.values(status.writers).some((item) => item.active)) return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Telemetry writers did not become idle before timeout');
}

function resetTelemetryWriterStatus() {
  channels.clear();
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function safeErrorCode(error) {
  const raw = error && (error.code || error.name) ? String(error.code || error.name) : 'WRITE_FAILED';
  return raw.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'WRITE_FAILED';
}

function logFailure(channel, code, attempts) {
  // Deliberately excludes SQL, parameters, identities, URLs, and exception messages.
  console.error(`[sentinel] telemetry write failed channel=${channel} code=${code} attempts=${attempts}`);
}

module.exports = {
  registerBatchHandler,
  enqueueTelemetry,
  getTelemetryWriterStatus,
  waitForTelemetryIdle,
  resetTelemetryWriterStatus,
  safeErrorCode,
};
