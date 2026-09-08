const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u;

function credential(value, label) {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n]/u.test(value)) {
    throw new Error(`${label} credential is missing or invalid`);
  }
  return value;
}

export function validateDestination(destination = {}, credentials = {}) {
  const method = destination.method ?? 'stdout';
  if (method === 'stdout') return { method };
  if (method === 'telegram') {
    return {
      method, botToken: credential(credentials.TELEGRAM_BOT_TOKEN, 'Telegram'),
      chatId: credential(destination.chatId, 'Telegram chat ID'),
    };
  }
  if (method === 'email') {
    const to = credential(destination.email, 'Email');
    if (!EMAIL.test(to)) throw new Error('Email destination is invalid');
    return { method, apiKey: credential(credentials.RESEND_API_KEY, 'Resend'), to };
  }
  throw new Error('Delivery method is invalid');
}

function splitTelegramMessage(message, maximum = 4000) {
  const characters = Array.from(message);
  const chunks = [];
  for (let offset = 0; offset < characters.length; offset += maximum) {
    chunks.push(characters.slice(offset, offset + maximum).join(''));
  }
  return chunks;
}

async function withTimeout(operation, {
  controller, timeoutMs, setTimeoutImpl, clearTimeoutImpl,
}) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeoutImpl(() => {
      controller.abort();
      reject(Object.assign(new Error('provider timeout'), { name: 'AbortError' }));
    }, timeoutMs);
  });
  try { return await Promise.race([operation(), timeout]); }
  finally { clearTimeoutImpl(timer); }
}

async function readBoundedJson(response, maximum = 16 * 1024) {
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maximum) throw new Error('provider response exceeds byte limit');
        chunks.push(value);
      }
    } finally {
      reader.releaseLock?.();
    }
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'));
  }
  const value = await response.json();
  if (Buffer.byteLength(JSON.stringify(value ?? null)) > maximum) {
    throw new Error('provider response exceeds byte limit');
  }
  return value;
}

async function requestProvider(url, options, {
  transport, timeoutMs, AbortControllerImpl = AbortController,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Provider timeout must be a positive integer');
  }
  const controller = new AbortControllerImpl();
  const timeoutOptions = { controller, timeoutMs, setTimeoutImpl, clearTimeoutImpl };
  const response = await withTimeout(
    () => transport(url, { ...options, signal: controller.signal }), timeoutOptions,
  );
  return {
    response,
    readJson: () => withTimeout(() => readBoundedJson(response), timeoutOptions),
  };
}

function classifyHttp(status) {
  return status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429
    ? 'failed' : 'uncertain';
}

export async function deliverStdout(message, output) {
  if (!output || typeof output.write !== 'function') {
    return { status: 'uncertain', reasonCode: 'provider-result-unknown' };
  }
  if (typeof output.once !== 'function') {
    try {
      await output.write(message);
      return { status: 'delivered', receipt: { type: 'stdout' } };
    } catch {
      return { status: 'uncertain', reasonCode: 'provider-result-unknown' };
    }
  }
  try {
    return await new Promise((resolve) => {
      let settled = false;
      let callbackDone = false;
      let drainDone = false;
      const cleanup = () => {
        output.off?.('error', onError);
        output.off?.('drain', onDrain);
      };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const maybeFinish = () => {
        if (callbackDone && drainDone) finish({ status: 'delivered', receipt: { type: 'stdout' } });
      };
      const onError = () => finish({ status: 'uncertain', reasonCode: 'provider-result-unknown' });
      const onDrain = () => { drainDone = true; maybeFinish(); };
      output.once('error', onError);
      output.once('drain', onDrain);
      let accepted;
      try {
        accepted = output.write(message, (error) => {
          if (error) onError();
          else { callbackDone = true; maybeFinish(); }
        });
      } catch {
        onError();
        return;
      }
      drainDone = accepted !== false;
      if (drainDone) output.off?.('drain', onDrain);
      maybeFinish();
    });
  } catch {
    return { status: 'uncertain', reasonCode: 'provider-result-unknown' };
  }
}

export async function deliverTelegram(message, {
  botToken, chatId, transport = fetch, logger = () => {}, timeoutMs = 15_000,
  AbortControllerImpl, setTimeoutImpl, clearTimeoutImpl,
} = {}) {
  const messageIds = [];
  for (const chunk of splitTelegramMessage(message)) {
    try {
      const { response, readJson } = await requestProvider(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: chunk, disable_web_page_preview: true }),
        }, {
          transport, timeoutMs, AbortControllerImpl,
          setTimeoutImpl, clearTimeoutImpl,
        },
      );
      if (!response.ok) {
        const classified = messageIds.length > 0 ? 'uncertain' : classifyHttp(response.status);
        await readJson().catch(() => null);
        logger(`telegram outcome=${classified}`);
        return {
          status: classified,
          reasonCode: classified === 'failed' ? 'provider-rejected' : 'provider-result-unknown',
        };
      }
      const body = await readJson();
      if (body?.ok !== true) {
        return { status: 'uncertain', reasonCode: 'provider-result-unknown' };
      }
      const messageId = body?.result?.message_id;
      if (!Number.isSafeInteger(messageId) || messageId < 0) {
        return { status: 'uncertain', reasonCode: 'provider-result-unknown' };
      }
      messageIds.push(messageId);
    } catch {
      return { status: 'uncertain', reasonCode: 'provider-result-unknown' };
    }
  }
  return {
    status: 'delivered',
    receipt: {
      type: 'telegram', messageCount: messageIds.length,
      firstMessageId: messageIds[0], lastMessageId: messageIds.at(-1),
    },
  };
}

export async function deliverEmail(message, {
  apiKey, to, transport = fetch, now = () => new Date(), logger = () => {},
  timeoutMs = 15_000, AbortControllerImpl, setTimeoutImpl, clearTimeoutImpl,
} = {}) {
  try {
    const { response, readJson } = await requestProvider('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        from: 'AI Builders Digest <digest@resend.dev>', to: [to],
        subject: `AI Builders Digest - ${now().toISOString().slice(0, 10)}`, text: message,
      }),
    }, {
      transport, timeoutMs, AbortControllerImpl, setTimeoutImpl, clearTimeoutImpl,
    });
    if (!response.ok) {
      const status = classifyHttp(response.status);
      await readJson().catch(() => null);
      logger(`resend outcome=${status}`);
      return { status, reasonCode: status === 'failed' ? 'provider-rejected' : 'provider-result-unknown' };
    }
    const body = await readJson();
    if (!RECEIPT_ID.test(body?.id ?? '')) {
      return { status: 'uncertain', reasonCode: 'provider-result-unknown' };
    }
    return { status: 'delivered', receipt: { type: 'resend', id: body.id } };
  } catch {
    return { status: 'uncertain', reasonCode: 'provider-result-unknown' };
  }
}

export async function deliverWithProvider(message, validated, options = {}) {
  if (validated.method === 'stdout') return deliverStdout(message, options.providerStdout);
  if (validated.method === 'telegram') return deliverTelegram(message, { ...validated, ...options });
  return deliverEmail(message, { ...validated, ...options });
}
