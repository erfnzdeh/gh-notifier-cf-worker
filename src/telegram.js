/** Telegram Bot API calls. */

const API = "https://api.telegram.org";

async function call(env, method, body) {
  const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text };
}

/**
 * A send can fail in two very different ways, and the difference decides
 * whether the subscriber keeps their subscription.
 *
 * Terminal: the user blocked the bot, deleted the chat, or was deactivated.
 * Retrying will never work, so we report `gone` and the caller unsubscribes
 * them. This is the only way we ever learn someone left — Telegram sends no
 * event for being blocked.
 *
 * Transient: rate limits, Telegram 5xx, network trouble. Those throw, and the
 * caller leaves the snapshot un-advanced so the next tick retries.
 */
const GONE = /bot was blocked|user is deactivated|chat not found|bot was kicked|PEER_ID_INVALID/i;

export async function sendMessage(env, chatId, text) {
  const res = await call(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });

  if (res.ok) return { delivered: true };
  if ((res.status === 403 || res.status === 400) && GONE.test(res.body)) {
    return { delivered: false, gone: true };
  }
  throw new Error(`Telegram ${res.status}: ${res.body.slice(0, 200)}`);
}

/**
 * Point Telegram at this Worker. `secret` is echoed back on every update in
 * the X-Telegram-Bot-Api-Secret-Token header, which is what lets the webhook
 * tell a real update from anyone who guessed the URL.
 */
export async function setWebhook(env, url, secret) {
  const res = await call(env, "setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ["message"],
  });
  return { ok: res.ok, body: res.body };
}
