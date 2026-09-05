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

async function safeJson(response) {
  try { return await response.json(); } catch { return null; }
}

function classifyHttp(status) {
  return status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429
    ? 'failed' : 'uncertain';
}

export async function deliverStdout(message, output) {
  try {
    await output.write(message);
    return { status: 'delivered', receipt: { type: 'stdout' } };
  } catch {
    return { status: 'uncertain', reasonCode: 'provider-result-unknown' };
  }
}

export async function deliverTelegram(message, {
  botToken, chatId, transport = fetch, logger = () => {},
} = {}) {
  const messageIds = [];
  for (const chunk of splitTelegramMessage(message)) {
    try {
      const response = await transport(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: chunk, disable_web_page_preview: true }),
        },
      );
      const body = await safeJson(response);
      if (!response.ok || body?.ok !== true) {
        const classified = messageIds.length > 0 ? 'uncertain' : classifyHttp(response.status);
        logger(`telegram outcome=${classified}`);
        return {
          status: classified,
          reasonCode: classified === 'failed' ? 'provider-rejected' : 'provider-result-unknown',
        };
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
  return { status: 'delivered', receipt: { type: 'telegram', messageIds } };
}

export async function deliverEmail(message, {
  apiKey, to, transport = fetch, now = () => new Date(), logger = () => {},
} = {}) {
  try {
    const response = await transport('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        from: 'AI Builders Digest <digest@resend.dev>', to: [to],
        subject: `AI Builders Digest - ${now().toISOString().slice(0, 10)}`, text: message,
      }),
    });
    const body = await safeJson(response);
    if (!response.ok) {
      const status = classifyHttp(response.status);
      logger(`resend outcome=${status}`);
      return { status, reasonCode: status === 'failed' ? 'provider-rejected' : 'provider-result-unknown' };
    }
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
