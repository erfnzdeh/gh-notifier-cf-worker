/**
 * Smoke tests for the multi-tenant bot.
 *
 * Both GitHub and Telegram are faked, so these are deterministic and cost no
 * rate limit. That is deliberate: the single-tenant suite polled real GitHub,
 * and an anonymous rate limit would surface as an assertion failure that
 * looked like a code bug.
 */

import worker, { tick } from "../src/index.js";
import { handleUpdate } from "../src/bot.js";

const TICK_MS = 5 * 60 * 1000;
const SHARDS = 12;

// ── fake KV ────────────────────────────────────────────────────────────────

function makeKV() {
  const data = new Map();
  const counts = { get: 0, put: 0, delete: 0, list: 0 };
  return {
    counts,
    dump: () => Object.fromEntries(data),
    async get(key, opts) {
      counts.get++;
      const raw = data.get(key);
      if (raw === undefined) return null;
      return opts?.type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      counts.put++;
      data.set(key, value);
    },
    async delete(key) {
      counts.delete++;
      data.delete(key);
    },
    async list({ prefix = "" } = {}) {
      counts.list++;
      const keys = [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

// ── fake GitHub + Telegram ─────────────────────────────────────────────────

const world = {
  accounts: {},   // login -> { followers: [], repos: { "o/r": { stargazers: [], forkers: [] } } }
  telegram: "ok", // "ok" | "blocked" | "down"
  sent: [],
};

const account = (login) => world.accounts[login.toLowerCase()];

function ghResponse(path) {
  const seg = path.split("/").filter(Boolean);

  if (seg[0] === "users" && seg.length === 2) {
    const a = account(seg[1]);
    if (!a) return null;
    return {
      login: a.login,
      followers: a.followers.length,
      public_repos: Object.keys(a.repos).length,
      type: "User",
    };
  }
  if (seg[0] === "users" && seg[2] === "followers") {
    const a = account(seg[1]);
    return a ? a.followers.map((login) => ({ login })) : null;
  }
  if (seg[0] === "users" && seg[2] === "repos") {
    const a = account(seg[1]);
    if (!a) return null;
    return Object.entries(a.repos).map(([name, r]) => ({
      full_name: `${a.login}/${name}`,
      stargazers_count: r.stargazers.length,
      forks_count: r.forkers.length,
    }));
  }
  if (seg[0] === "repos" && seg[3] === "stargazers") {
    return (account(seg[1])?.repos[seg[2]]?.stargazers ?? []).map((login) => ({ login }));
  }
  if (seg[0] === "repos" && seg[3] === "forks") {
    return (account(seg[1])?.repos[seg[2]]?.forkers ?? []).map((login) => ({ owner: { login } }));
  }
  if (seg[0] === "repos" && seg[3] === "events") return [];
  return null;
}

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);

  if (url.hostname === "api.telegram.org") {
    if (url.pathname.endsWith("/sendMessage")) {
      const body = JSON.parse(init.body);
      if (world.telegram === "blocked") {
        return new Response('{"description":"Forbidden: bot was blocked by the user"}', { status: 403 });
      }
      if (world.telegram === "down") {
        return new Response("upstream", { status: 502 });
      }
      world.sent.push({ chat: body.chat_id, text: body.text });
      return new Response('{"ok":true}');
    }
    return new Response('{"ok":true}');
  }

  const payload = ghResponse(url.pathname);
  if (payload === null) return new Response('{"message":"Not Found"}', { status: 404 });
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
};

// ── harness ────────────────────────────────────────────────────────────────

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!cond) failures++;
};

const env = () => ({
  STORE: makeKV(),
  GITHUB_TOKEN: "t",
  TELEGRAM_BOT_TOKEN: "t",
  TELEGRAM_WEBHOOK_SECRET: "s",
  TRIGGER_SECRET: "k",
});

const say = (e, chatId, text) => handleUpdate(e, { message: { chat: { id: chatId }, text } });
const lastReply = () => world.sent[world.sent.length - 1]?.text ?? "";

/** One full cycle of the cron: every shard, so every account comes round once. */
async function fullCycle(e) {
  const results = [];
  for (let i = 0; i < SHARDS; i++) results.push(await tick(e, i * TICK_MS));
  return results;
}

function reset() {
  world.accounts = {
    erfnzdeh: {
      login: "erfnzdeh",
      followers: ["ada", "linus"],
      repos: { "smart-dns-ir": { stargazers: ["ada"], forkers: [] } },
    },
    octocat: { login: "octocat", followers: ["ada"], repos: {} },
  };
  world.telegram = "ok";
  world.sent = [];
}

console.log("\ngh-notifier bot smoke tests\n");

// 1: commands
{
  reset();
  const e = env();

  await say(e, 1, "/start");
  check("/start explains what is stored", /What I store/.test(lastReply()));

  await say(e, 1, "/watch foo!bar");
  check("rejects a malformed username", /not a valid GitHub username/.test(lastReply()));

  await say(e, 1, "/watch my name is bob");
  check("reads only the first word as the username", /No GitHub account called <code>my<\/code>/.test(lastReply()));

  await say(e, 1, "/watch ghost-that-does-not-exist");
  check("rejects an account that does not exist", /No GitHub account/.test(lastReply()));

  await say(e, 1, "/watch erfnzdeh");
  check("watch confirms with real counts", /2 followers, 1 public repo\b/.test(lastReply()));
  check("watch stores the subscription", JSON.parse(e.STORE.dump()["sub:1"]).length === 1);
  check("watch stores the fan-out index", JSON.parse(e.STORE.dump()["watch:erfnzdeh"]).chats[0] === 1);

  await say(e, 1, "/watch ERFNZDEH");
  check("watching is case-insensitive", /Already watching/.test(lastReply()));

  await say(e, 1, "/list");
  check("/list shows the account", /erfnzdeh/.test(lastReply()));

  await say(e, 1, "/unwatch erfnzdeh");
  check("unwatch confirms", /Stopped watching/.test(lastReply()));
  check("unwatch clears the subscription", e.STORE.dump()["sub:1"] === undefined);
  check("unwatch clears the fan-out index", e.STORE.dump()["watch:erfnzdeh"] === undefined);
}

// 2: seeding, dedup and delivery
{
  reset();
  const e = env();
  await say(e, 1, "/watch erfnzdeh");
  await say(e, 2, "/watch erfnzdeh"); // second subscriber, same account
  world.sent = [];

  await fullCycle(e);
  check("first pass seeds silently", world.sent.length === 0);
  check("first pass stores a snapshot", e.STORE.dump()["state:erfnzdeh"] !== undefined);

  const before = e.STORE.counts.put;
  await fullCycle(e);
  check("an unchanged pass sends nothing", world.sent.length === 0);
  check("an unchanged pass writes nothing", e.STORE.counts.put === before);

  world.accounts.erfnzdeh.followers.push("grace");
  await fullCycle(e);
  check("a new follower reaches both subscribers", world.sent.length === 2);
  check("the message names the follower", /grace/.test(world.sent[0].text));
  check("the message names the account", /erfnzdeh/.test(world.sent[0].text));
  check(
    "both subscribers got the same message",
    world.sent[0].text === world.sent[1].text && world.sent[0].chat !== world.sent[1].chat,
  );

  world.sent = [];
  world.accounts.erfnzdeh.repos["smart-dns-ir"].stargazers.push("grace");
  await fullCycle(e);
  check("a new star is named", /grace/.test(world.sent[0]?.text ?? ""));
}

// 3: each account is polled once per cycle, not once per tick
{
  reset();
  const e = env();
  for (let i = 0; i < 6; i++) {
    world.accounts[`acct${i}`] = { login: `acct${i}`, followers: [], repos: {} };
    await say(e, 1, `/watch acct${i}`);
  }
  const cycle = await fullCycle(e);
  const polled = cycle.flatMap((t) => t.results.map((r) => r.login));
  check("every account is polled once per cycle", polled.length === 6 && new Set(polled).size === 6);
  check("no single tick polls them all", cycle.every((t) => t.polled < 6));
}

// 4: a blocked subscriber is dropped, a flaky one is retried
{
  reset();
  const e = env();
  await say(e, 1, "/watch octocat");
  await fullCycle(e); // seed

  world.telegram = "blocked";
  world.accounts.octocat.followers.push("grace");
  await fullCycle(e);
  check("a blocked chat is unsubscribed", e.STORE.dump()["watch:octocat"] === undefined);
  check("its snapshot is cleaned up too", e.STORE.dump()["state:octocat"] === undefined);

  reset();
  const e2 = env();
  await say(e2, 1, "/watch octocat");
  await fullCycle(e2);
  const snapshot = e2.STORE.dump()["state:octocat"];

  world.telegram = "down";
  world.accounts.octocat.followers.push("grace");
  await fullCycle(e2);
  check("a failed send does not advance the snapshot", e2.STORE.dump()["state:octocat"] === snapshot);

  world.telegram = "ok";
  world.sent = [];
  await fullCycle(e2);
  check("the event survives the outage", /grace/.test(world.sent[0]?.text ?? ""));
}

// 5: /stop
{
  reset();
  const e = env();
  await say(e, 1, "/watch erfnzdeh");
  await say(e, 1, "/watch octocat");
  await say(e, 1, "/stop");
  check("/stop reports what it removed", /Stopped watching 2 accounts/.test(lastReply()));
  check(
    "/stop leaves nothing behind",
    Object.keys(e.STORE.dump()).filter((k) => !k.startsWith("state:")).length === 0,
  );
}

// 6: the per-subscriber cap
{
  reset();
  const e = env();
  for (let i = 0; i < 11; i++) {
    world.accounts[`acct${i}`] = { login: `acct${i}`, followers: [], repos: {} };
    await say(e, 1, `/watch acct${i}`);
  }
  check("the eleventh watch is refused", /which is the limit/.test(lastReply()));
  check("the cap holds in storage", JSON.parse(e.STORE.dump()["sub:1"]).length === 10);
}

// 6b: an overflowing shard defers accounts, it does not starve them
{
  reset();
  const e = env();
  // 200 accounts is enough that some shard exceeds MAX_ACCOUNTS_PER_TICK (12),
  // spread over 20 chats because one subscriber may only watch 10.
  for (let i = 0; i < 200; i++) {
    world.accounts[`bulk${i}`] = { login: `bulk${i}`, followers: [], repos: {} };
    await say(e, Math.floor(i / 10), `/watch bulk${i}`);
  }

  const firstCycle = await fullCycle(e);
  const overflowed = firstCycle.some((t) => t.due > t.polled);
  check("a busy shard defers part of its batch", overflowed);

  const seen = new Set(firstCycle.flatMap((t) => t.results.map((r) => r.login)));
  for (let c = 1; c < 8; c++) {
    for (let i = 0; i < SHARDS; i++) {
      const t = await tick(e, (c * SHARDS + i) * TICK_MS);
      for (const r of t.results) seen.add(r.login);
    }
  }
  const bulk = [...seen].filter((l) => l.startsWith("bulk"));
  check("every deferred account is polled within a few cycles", bulk.length === 200, `${bulk.length}/200`);
}

// 7: the webhook is the security boundary
{
  reset();
  const e = env();
  const post = (secret) =>
    worker.fetch(
      new Request("https://bot.example/telegram/webhook", {
        method: "POST",
        headers: secret === undefined ? {} : { "X-Telegram-Bot-Api-Secret-Token": secret },
        body: JSON.stringify({ message: { chat: { id: 9 }, text: "/list" } }),
      }),
      e,
    );

  check("an update with no secret is rejected", (await post()).status === 403);
  check("an update with the wrong secret is rejected", (await post("wrong")).status === 403);

  world.sent = [];
  const good = await post("s");
  check("an update with the right secret is accepted", good.status === 200);
  check("and is actually handled", /not watching anything/.test(lastReply()));

  const get = await worker.fetch(new Request("https://bot.example/telegram/webhook"), e);
  check("GET on the webhook is refused", get.status === 405);

  const admin = await worker.fetch(new Request("https://bot.example/admin/tick"), e);
  check("admin routes need the trigger secret", admin.status === 403);
}

console.log(failures ? `\n${failures} failing\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
