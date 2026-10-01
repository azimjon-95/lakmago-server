import { config } from '../config/index.js';

/*
 * ═══════════════════════════════════════════════════════════
 * TELEGRAM BOT API — UMUMIY CHAQIRUV (JSON va FAYL yuborish)
 * ═══════════════════════════════════════════════════════════
 *
 * Video reklama, yordam guruhi va bazani zaxiralash shu yerdan foydalanadi.
 * (Boshqa xizmatlar o'z `fetch` chaqiruvlarini saqlab qolgan — ularga tegilmadi.)
 *
 *   tgCall   — JSON body (sendMessage, editMessageText, deleteMessage, pinChatMessage…)
 *   tgUpload — multipart (sendVideo, sendDocument): fayl `Blob`, xotirani
 *              keraksiz ko'paytirmaydi (fs.openAsBlob fayl-tayanchli Blob beradi)
 *
 * Xato: Error(`${method}: ${description}`) + `.code` (Telegram error_code),
 * `.retryAfter` (429 bo'lsa soniya) — chaqiruvchi "xabar topilmadi"/"o'zgarmadi"
 * kabi kutilgan holatlarni ajrata olsin.
 */

export const tgBase = () => `${config.telegramApiBase}/bot${config.telegramBotToken}`;

async function finish(method, res) {
  let data = null;
  try { data = await res.json(); } catch { /* JSON emas */ }
  if (data?.ok) return data.result;
  const err = new Error(`${method}: ${data?.description || `HTTP ${res.status}`}`);
  err.code = data?.error_code || res.status;
  err.description = data?.description || '';
  err.retryAfter = data?.parameters?.retry_after;
  throw err;
}

function withTimeout(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

export async function tgCall(method, body, { timeoutMs = 30_000 } = {}) {
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetch(`${tgBase()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: t.signal,
    });
    return await finish(method, res);
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error(`${method}: vaqt tugadi`), { code: 0 });
    throw e;
  } finally {
    t.done();
  }
}

/**
 * @param {string} method — 'sendVideo' | 'sendDocument'
 * @param {Record<string, unknown>} fields — oddiy maydonlar (obyektlar JSON qilinadi: reply_markup)
 * @param {{ field: string, blob: Blob, filename: string }} file
 */
export async function tgUpload(method, fields, file, { timeoutMs = 300_000 } = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  form.append(file.field, file.blob, file.filename);

  const t = withTimeout(timeoutMs);
  try {
    const res = await fetch(`${tgBase()}/${method}`, { method: 'POST', body: form, signal: t.signal });
    return await finish(method, res);
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error(`${method}: yuklash vaqti tugadi`), { code: 0 });
    throw e;
  } finally {
    t.done();
  }
}
