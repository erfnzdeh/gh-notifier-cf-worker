/**
 * Smoke tests. Drives the real Worker module against the live GitHub API with
 * KV and Telegram mocked, so the diffing and delivery-ordering logic is
 * exercised end to end without deploying or sending anything.
 *
 *   npm test                       # uses GITHUB_USER from wrangler.jsonc
 *   GITHUB_USER=octocat npm test   # or override
 *   GH_TOKEN=$(gh auth token) npm test   # avoids the 60/hr anonymous limit
 *
 * Requires Node 18+ for global fetch/Request/Response.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const worker = (await import(join(here, "..", "src", "index.js"))).default;

// Read the configured username out of wrangler.jsonc (tolerating comments).
const cfg = readFileSync(join(here, "..", "wrangler.jsonc"), "utf8").replace(
  /^\s*\/\/.*$/gm,
  "",
);
const GITHUB_USER = process.env.GITHUB_USER || JSON.parse(cfg).vars.GITHUB_USER;

let telegramUp = true;
// Simulates a GITHUB_TOKEN that cannot read /stargazers — the response GitHub
// gives any token without `contents=write` / `public_repo`.
let stargazersBlocked = false;
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes("api.telegram.org")) {
    if (!telegramUp) return new Response("Not Found", { status: 404 });
    sent.push(JSON.parse(init.body).text);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  if (stargazersBlocked && String(url).includes("/stargazers")) {
    return new Response(
      JSON.stringify({ message: "Resource not accessible by personal access token" }),
      { status: 403 },
    );
  }
  return realFetch(url, init);
};

const makeKV = (init) => {
  let s = init === undefined ? null : JSON.stringify(init);
  return {
    get: async () => (s === null ? null : JSON.parse(s)),
    put: async (_k, v) => {
      s = v;
    },
    dump: () => (s === null ? null : JSON.parse(s)),
  };
};

const run = (kv) =>
  worker
    .fetch(new Request("https://x/run?key=t"), {
      GITHUB_USER,
      GITHUB_TOKEN: process.env.GH_TOKEN,
      TELEGRAM_BOT_TOKEN: "fake",
      TELEGRAM_CHAT_ID: "1",
      TRIGGER_SECRET: "t",
      FOLLOWERS: kv,
    })
    .then((r) => r.json());

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};

console.log(`\ngh-notifier smoke tests (user: ${GITHUB_USER})\n`);

// 1 — first run seeds silently
const kv = makeKV();
const seed = await run(kv);
check("first run seeds", seed.seeded === true, `${seed.followerCount} followers, ${seed.repoCount} repos`);
check("seeding sends nothing", sent.length === 0);
const base = kv.dump();

// 2 — an unchanged run is a no-op
const r2 = await run(makeKV(base));
check("unchanged run reports nothing", r2.events.length === 0 && sent.length === 0);

// 3 — synthetic star / fork / follow / unfollow are all detected, by name
const starRepo = Object.entries(base.repos).find(([, v]) => v.stars > 0)?.[0];
const forkRepo = Object.entries(base.repos).find(([, v]) => v.forks > 0)?.[0];
const t = structuredClone(base);
// Drop a real stargazer from the baseline: the live list still has them, so
// they must come back named rather than as an anonymous +1.
let starActor;
if (starRepo) {
  t.repos[starRepo].stars -= 1;
  starActor = t.repos[starRepo].stargazers?.pop();
}
if (forkRepo) t.repos[forkRepo].forks -= 1;
const ghost = t.followers.pop();
t.followers.unshift("octocat");
sent.length = 0;
const r3 = await run(makeKV(t));
const kinds = r3.events.map((e) => e.kind);
if (starRepo) check("detects a new star", kinds.includes("star"), starRepo);
if (starActor) {
  const named = r3.events.find((e) => e.kind === "star" && e.actor === starActor);
  check("names the account that starred", Boolean(named), starActor);
}
if (forkRepo) check("detects a new fork", kinds.includes("fork"), forkRepo);
check("detects a new follower", kinds.includes("follow"), ghost);
check("detects a departure", kinds.includes("unfollow") || kinds.includes("deleted"), "octocat");
check("sends exactly one message", sent.length === 1);

// 3b — the reverse: a stargazer the live list no longer has is named as unstar
if (starRepo && base.repos[starRepo].stargazers?.length) {
  const t3b = structuredClone(base);
  t3b.repos[starRepo].stars += 1;
  t3b.repos[starRepo].stargazers.push("octocat");
  sent.length = 0;
  const r3b = await run(makeKV(t3b));
  const gone = r3b.events.find((e) => e.kind === "unstar" && e.actor === "octocat");
  check("names the account that unstarred", Boolean(gone), starRepo);
}

// 3c — with /stargazers blocked, a star is still named from the public events
// feed. This is the degraded mode a token without public_repo runs in.
{
  const ghHeaders = {
    "User-Agent": "gh-notifier",
    ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
  };
  let target, actor;
  for (const full of Object.keys(base.repos)) {
    const evs = await realFetch(
      `https://api.github.com/repos/${full}/events?per_page=100`,
      { headers: ghHeaders },
    ).then((r) => (r.ok ? r.json() : []));
    const w = Array.isArray(evs) && evs.find((e) => e.type === "WatchEvent");
    if (w) {
      target = full;
      actor = w.actor.login;
      break;
    }
  }
  if (!target) {
    console.log("  skip  events fallback — no WatchEvent left in any repo's feed");
  } else {
    const t3c = structuredClone(base);
    t3c.repos[target].stars -= 1;
    delete t3c.repos[target].stargazers; // no baseline, so no set diff is possible
    stargazersBlocked = true;
    sent.length = 0;
    const r3c = await run(makeKV(t3c));
    stargazersBlocked = false;
    check(
      "names starrer from events when /stargazers is blocked",
      r3c.events.some((e) => e.kind === "star" && e.actor === actor),
      `${target} → ${actor}`,
    );
    check("blocked stargazers list is not persisted as a baseline", sent.length === 1);
  }
}

// 4 — the ordering guarantee: a failed send must not consume the events
telegramUp = false;
const t4 = structuredClone(base);
const pending = Object.entries(base.repos).find(([, v]) => v.stars > 0)?.[0];
if (pending) {
  t4.repos[pending].stars -= 1;
  const kv4 = makeKV(t4);
  const before = kv4.dump().repos[pending].stars;
  await run(kv4);
  check("failed delivery preserves the baseline", kv4.dump().repos[pending].stars === before);

  telegramUp = true;
  sent.length = 0;
  const r5 = await run(kv4);
  check("event survives the outage", r5.events.some((e) => e.kind === "star") && sent.length === 1);
  check("baseline advances after success", kv4.dump().repos[pending].stars !== before);
}

console.log(failures ? `\n${failures} failing\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
