/**
 * Mirror every incoming message to the operator's chat.
 *
 * A port of the AdminForwardMiddleware in RichTextEchoBot: a header carrying
 * everything we know about the sender, then the message itself forwarded
 * verbatim. The header exists because a forward alone is not enough to answer
 * "who sent this". A sender with forward privacy on arrives anonymous, and
 * even a named one tells you nothing about their locale or client.
 *
 * Two properties are load-bearing, both inherited from the original:
 *
 * Best-effort. Nothing in here throws. A mirror that fails costs an operator
 * one message they never knew was coming; a mirror that throws would cost the
 * sender their reply. The header and the forward are attempted independently,
 * so a failed header still gets you the message.
 *
 * Off by default. With ADMIN_CHAT_ID unset the whole thing is a no-op, exactly
 * as the Python bot treats `admin_chat_id: int | None = None`.
 *
 * Cost, on the free plan: two external subrequests per incoming message and no
 * KV at all, which matters because KV writes are the scarce resource here. The
 * real ceiling is Telegram's own, roughly a message a second into any one
 * chat, so mirroring at two messages per update halves how many subscribers
 * can be talking at once before the admin chat starts collecting 429s. At the
 * scale this bot is aimed at that is far away, and the failures are logged
 * rather than retried, so hitting it costs visibility rather than delivery.
 */

import { esc } from "./format.js";
import { forwardMessage, sendMessageRaw } from "./telegram.js";

/**
 * Everything we know about a sender, as pretty JSON in a code block. Telegram
 * renders that syntax-highlighted and tap-to-copy, which is what makes the
 * user_id usable. It is the one field you actually reach for, whether to
 * answer someone or to find them in the logs.
 */
export function formatUserInfo(msg) {
  const user = msg.from ?? {};
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ") || null;
  const info = {
    name: fullName,
    username: user.username ?? null,
    user_id: user.id ?? null,
    // tg:// links open the profile directly, including for users with no @handle.
    profile_link: user.id == null ? null : `tg://user?id=${user.id}`,
    language_code: user.language_code ?? null,
    is_premium: Boolean(user.is_premium),
    is_bot: Boolean(user.is_bot),
    forwarded: Boolean(msg.forward_origin || msg.forward_date),
  };
  return `<pre><code class="language-json">${esc(JSON.stringify(info, null, 2))}</code></pre>`;
}

/**
 * Mirror one update. Returns what it did, for tests and for the caller's logs;
 * callers are not expected to await it. See the webhook in index.js.
 */
export async function forwardToAdmin(env, update) {
  const admin = env.ADMIN_CHAT_ID;
  if (!admin) return { skipped: "disabled" };

  // setWebhook asks for `message` updates only, so this is every update we get.
  // Edits are deliberately not mirrored: they would arrive as a second copy of
  // a message already forwarded, with nothing marking which is the newer.
  const msg = update?.message;
  if (!msg?.chat || msg.message_id == null) return { skipped: "not a message" };

  // The operator talking to their own bot, and the tick's failure alerts
  // landing in this same chat, must not mirror back into it.
  if (String(msg.chat.id) === String(admin)) return { skipped: "admin" };

  const from = msg.chat.id;
  let headerId;

  try {
    // Silent: the forward that follows raises the notification, so mirroring
    // would otherwise buzz the operator twice for every message.
    const header = await sendMessageRaw(env, admin, formatUserInfo(msg), {
      disable_notification: true,
    });
    if (header.ok) headerId = header.messageId;
    else console.warn(`admin header failed from chat=${from}: ${header.status} ${header.body.slice(0, 200)}`);
  } catch (err) {
    console.warn(`admin header error from chat=${from}: ${err.message}`);
  }

  try {
    const res = await forwardMessage(env, admin, from, msg.message_id, headerId);
    if (res.ok) return { forwarded: true, headerId };
    console.warn(`admin forward failed from chat=${from}: ${res.status} ${res.body.slice(0, 200)}`);
    return { forwarded: false, headerId };
  } catch (err) {
    console.warn(`admin forward error from chat=${from}: ${err.message}`);
    return { forwarded: false, headerId };
  }
}
