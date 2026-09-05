import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  deliverEmail,
  deliverStdout,
  deliverTelegram,
  validateDestination,
} from '../delivery-providers.js';

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('stdout writes only when invoked and returns a non-secret receipt', async () => {
  const writes = [];
  const result = await deliverStdout('digest body', { write: (value) => writes.push(value) });
  assert.deepEqual(writes, ['digest body']);
  assert.deepEqual(result, { status: 'delivered', receipt: { type: 'stdout' } });
});

test('Telegram splits at 4000 chars and partial success followed by uncertainty stays uncertain', async () => {
  const calls = [];
  const results = [
    response(200, { ok: true, result: { message_id: 11 } }),
    Promise.reject(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' })),
  ];
  const result = await deliverTelegram('x'.repeat(7000), {
    botToken: 'test-only-token', chatId: '123',
    transport: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return results.shift();
    },
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ body }) => body.text.length <= 4000));
  assert.ok(calls.every(({ body }) => !Object.hasOwn(body, 'parse_mode')));
  assert.deepEqual(result, { status: 'uncertain', reasonCode: 'provider-result-unknown' });
});

test('Telegram confirmed chunks return all message IDs without logging credentials or bodies', async () => {
  let sequence = 20;
  const logs = [];
  const result = await deliverTelegram('x'.repeat(4001), {
    botToken: 'test-only-token', chatId: '123', logger: (line) => logs.push(line),
    transport: async () => response(200, { ok: true, result: { message_id: sequence += 1 } }),
  });
  assert.deepEqual(result, {
    status: 'delivered', receipt: { type: 'telegram', messageIds: [21, 22] },
  });
  assert.doesNotMatch(logs.join('\n'), /test-only-token|x{20}|123/);
});

test('Telegram rejection after a confirmed earlier chunk is still uncertain', async () => {
  const responses = [
    response(200, { ok: true, result: { message_id: 31 } }),
    response(400, { ok: false, description: 'bad request' }),
  ];
  assert.deepEqual(await deliverTelegram('x'.repeat(4001), {
    botToken: 'test-only-token', chatId: '123',
    transport: async () => responses.shift(),
  }), { status: 'uncertain', reasonCode: 'provider-result-unknown' });
});

test('stdout write failure is an uncertain handoff result', async () => {
  assert.deepEqual(await deliverStdout('digest body', {
    write() { throw new Error('stream disconnected'); },
  }), { status: 'uncertain', reasonCode: 'provider-result-unknown' });
});

test('stdout waits for callback and drain and treats asynchronous EPIPE as uncertain', async () => {
  const stream = new EventEmitter();
  stream.write = (_message, callback) => {
    queueMicrotask(() => stream.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' })));
    queueMicrotask(() => callback());
    return false;
  };
  assert.deepEqual(await deliverStdout('digest body', stream), {
    status: 'uncertain', reasonCode: 'provider-result-unknown',
  });
});

test('email distinguishes success, explicit rejection, and unknown provider results', async () => {
  const common = { apiKey: 'test-only-key', to: 'reader@example.com' };
  assert.deepEqual(await deliverEmail('digest', {
    ...common, transport: async () => response(200, { id: 'email_123' }),
  }), { status: 'delivered', receipt: { type: 'resend', id: 'email_123' } });
  assert.deepEqual(await deliverEmail('digest', {
    ...common, transport: async () => response(422, { message: 'invalid recipient' }),
  }), { status: 'failed', reasonCode: 'provider-rejected' });
  assert.deepEqual(await deliverEmail('digest', {
    ...common, transport: async () => response(503, { message: 'unavailable' }),
  }), { status: 'uncertain', reasonCode: 'provider-result-unknown' });
  assert.deepEqual(await deliverEmail('digest', {
    ...common, transport: async () => { throw Object.assign(new Error('timeout'), { name: 'AbortError' }); },
  }), { status: 'uncertain', reasonCode: 'provider-result-unknown' });
});

test('destination configuration is validated locally before provider handoff', () => {
  assert.throws(() => validateDestination({ method: 'telegram', chatId: '1' }, {}), /credential/i);
  assert.throws(() => validateDestination({ method: 'email', email: 'bad\r\nBcc:x' }, { RESEND_API_KEY: 'x' }), /email/i);
  assert.doesNotThrow(() => validateDestination({ method: 'stdout' }, {}));
});

test('Telegram and Resend abort transport and response parsing timeouts', async () => {
  for (const operation of [
    () => deliverTelegram('digest', {
      botToken: 'test-only-token', chatId: '123', timeoutMs: 5,
      transport: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    }),
    () => deliverEmail('digest', {
      apiKey: 'test-only-key', to: 'reader@example.com', timeoutMs: 5,
      transport: async () => ({ ok: true, status: 200, json: async () => new Promise(() => {}) }),
    }),
  ]) {
    assert.deepEqual(await operation(), {
      status: 'uncertain', reasonCode: 'provider-result-unknown',
    });
  }
});

test('HTTP rejection is classified before best-effort error body parsing', async () => {
  const malformed = { ok: false, status: 422, json: async () => { throw new Error('bad json'); } };
  const empty = { ok: false, status: 400, json: async () => null };
  assert.deepEqual(await deliverEmail('digest', {
    apiKey: 'test-only-key', to: 'reader@example.com', transport: async () => malformed,
  }), { status: 'failed', reasonCode: 'provider-rejected' });
  assert.deepEqual(await deliverTelegram('digest', {
    botToken: 'test-only-token', chatId: '123', transport: async () => empty,
  }), { status: 'failed', reasonCode: 'provider-rejected' });
  assert.deepEqual(await deliverEmail('digest', {
    apiKey: 'test-only-key', to: 'reader@example.com',
    transport: async () => ({ ok: false, status: 503, json: async () => { throw new Error('secret=leak'); } }),
  }), { status: 'uncertain', reasonCode: 'provider-result-unknown' });
});
