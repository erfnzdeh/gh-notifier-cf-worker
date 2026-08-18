/**
 * Tests for the admin mirror.
 *
 * Telegram is faked, so these are deterministic and cost nothing. Kept in
 * their own file rather than folded into run.mjs so the two suites can be
 * edited independently.
 */

import { forwardToAdmin } from "../src/admin-forward.js";
import { handleUpdate } from "../src/bot.js";
import worker from "../src/index.js";

// ── fake Telegram ──────────────────────────────────────────────────────────
const world = { calls: [], fail: {} };

const reset = () => {
  world.calls = [];
  world.fail = {};
};

globalThis.fetch = async (input, init) => {
  const method = new URL(String(input)).pathname.split("/").pop();
  const body = JSON.parse(init.body);
  world.calls.push({ method, body });

  const failure = world.fail[method];
  if (failure) {
    if (failure === "throw") throw new Error("network down");
    return { ok: false, status: failure, text: async () => `{"description":"nope ${failure}"}` };
  }
  // message_id counts up so a forward's reply target is unambiguous.
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, result: { message_id: 500 + world.calls.length } }),
  };
};

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

const env = (extra = {}) => ({
  STORE: {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true }),
  },
  TELEGRAM_BOT_TOKEN: "t",
  TELEGRAM_WEBHOOK_SECRET: "s",
  ADMIN_CHAT_ID: "77",
  ...extra,
});

const msg = (over = {}) => ({
  message_id: 12,
  chat: { id: 9, type: "private" },
  from: { id: 9, first_name: "Ada", last_name: "Lovelace", username: "ada", language_code: "en" },
  text: "/list",
  ...over,
});

const only = (method) => world.calls.filter((c) => c.method === method);

console.log("\nadmin mirror tests\n");

// 1 — off unless the operator asked for it
{
  reset();
  const r = await forwardToAdmin(env({ ADMIN_CHAT_ID: undefined }), { message: msg() });
  check("no ADMIN_CHAT_ID means no mirroring", r.skipped === "disabled" && world.calls.length === 0);
}

// 2 — the shape of a mirrored message
{
  reset();
  const r = await forwardToAdmin(env(), { message: msg() });
  const [header, fwd] = world.calls;
  check("a message is mirrored", r.forwarded === true);
  check("header first, then the forward", header?.method === "sendMessage" && fwd?.method === "forwardMessage");
  check("both go to the admin chat", String(header.body.chat_id) === "77" && String(fwd.body.chat_id) === "77");
  check("the forward names its source", fwd.body.from_chat_id === 9 && fwd.body.message_id === 12);
  // The header is call 1, so the fake gave it message_id 501.
  check(
    "the forward is bound to its header",
    fwd.body.reply_parameters?.message_id === 501,
    `reply to ${fwd.body.reply_parameters?.message_id}`,
  );
  check("and tolerates that header being gone", fwd.body.reply_parameters?.allow_sending_without_reply === true);
  check("the header does not buzz", header.body.disable_notification === true);
}

// 3 — the header contents
{
  reset();
  await forwardToAdmin(env(), { message: msg({ from: { ...msg().from, is_premium: true } }) });
  const text = only("sendMessage")[0].body.text;
  const json = JSON.parse(text.replace(/^<pre><code class="language-json">/, "").replace(/<\/code><\/pre>$/, ""));
  check("header carries the full name", json.name === "Ada Lovelace");
  check("header carries the username", json.username === "ada");
  check("header carries a tappable profile link", json.profile_link === "tg://user?id=9");
  check("header reports premium", json.is_premium === true);
  check("header reports the message was not itself a forward", json.forwarded === false);
}

// 4 — a forwarded message is flagged as one
{
  reset();
  await forwardToAdmin(env(), { message: msg({ forward_origin: { type: "user" } }) });
  const text = only("sendMessage")[0].body.text;
  check("a forwarded message is marked", /"forwarded": true/.test(text));
}

// 5 — HTML in a display name cannot break the header
{
  reset();
  await forwardToAdmin(env(), { message: msg({ from: { id: 9, first_name: "<b>evil</b>" } }) });
  const text = only("sendMessage")[0].body.text;
  check("a name with markup is escaped", text.includes("&lt;b&gt;evil&lt;/b&gt;") && !text.includes("<b>evil"));
}

// 6 — the operator's own chat is not mirrored back into itself
{
  reset();
  const r = await forwardToAdmin(env(), { message: msg({ chat: { id: 77 } }) });
  check("the admin's own messages are skipped", r.skipped === "admin" && world.calls.length === 0);
}

// 7 — best effort: neither half can break the other, or the caller
{
  reset();
  world.fail.sendMessage = 400;
  const r = await forwardToAdmin(env(), { message: msg() });
  check("a failed header still forwards the message", r.forwarded === true && only("forwardMessage").length === 1);
  check("and the forward goes out unbound", only("forwardMessage")[0].body.reply_parameters === undefined);

  reset();
  world.fail.forwardMessage = "throw";
  const r2 = await forwardToAdmin(env(), { message: msg() });
  check("a thrown forward is reported, not raised", r2.forwarded === false);

  reset();
  world.fail.sendMessage = "throw";
  world.fail.forwardMessage = "throw";
  const r3 = await forwardToAdmin(env(), { message: msg() });
  check("total Telegram failure still resolves", r3.forwarded === false);
}

// 8 — updates that are not messages
{
  reset();
  const r = await forwardToAdmin(env(), { edited_message: msg() });
  check("an edit is not mirrored a second time", r.skipped === "not a message" && world.calls.length === 0);
  const r2 = await forwardToAdmin(env(), {});
  check("an empty update is ignored", r2.skipped === "not a message");
}

// 9 — through the real webhook, which is where it actually runs
{
  reset();
  const e = env();
  const res = await worker.fetch(
    new Request("https://bot.example/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "s" },
      body: JSON.stringify({ message: msg() }),
    }),
    e,
    { waitUntil: () => {} },
  );
  check("the webhook still returns 200", res.status === 200);
  check("and the message was mirrored", only("forwardMessage").length === 1);
  check("and the sender still got their reply", only("sendMessage").length === 2);
}

// 10 — a broken mirror must never cost the sender their reply
{
  reset();
  world.fail.forwardMessage = "throw";
  const e = env();
  const res = await worker.fetch(
    new Request("https://bot.example/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "s" },
      body: JSON.stringify({ message: msg() }),
    }),
    e,
    { waitUntil: () => {} },
  );
  check("the webhook survives a dead mirror", res.status === 200);
  check("and the command was still handled", only("sendMessage").length === 2);
}

// 11 — the promise the runtime is asked to wait on is the mirror's
{
  reset();
  let waited = null;
  await worker.fetch(
    new Request("https://bot.example/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "s" },
      body: JSON.stringify({ message: msg() }),
    }),
    env(),
    { waitUntil: (p) => (waited = p) },
  );
  check("the mirror is handed to waitUntil", waited instanceof Promise);
  check("and it resolves", (await waited)?.forwarded === true);
}

// 12 — the privacy notice has to match what the bot actually does
{
  const saidTo = async (e) => {
    reset();
    await handleUpdate(e, { message: msg({ text: "/privacy" }) });
    return only("sendMessage").pop()?.body.text ?? "";
  };
  const on = await saidTo(env());
  const off = await saidTo(env({ ADMIN_CHAT_ID: undefined }));
  check("mirroring is disclosed when it is on", /copied to the person who runs this bot/.test(on));
  check("and not claimed when it is off", !/copied to the person who runs this bot/.test(off));
  check("the notice admits /stop cannot unsend", /cannot unsend/.test(on));
  check("the storage notice survives either way", /What I store/.test(on) && /What I store/.test(off));
}

console.log(failures ? `\n${failures} failing\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
