/**
 * gh-notifier — Cloudflare Workers port of andreausu/git-notifier (MIT),
 * unmaintained since 2019.
 *
 * GitHub emits no notification for stars, forks, follows or unfollows, so we
 * poll and diff against a snapshot in KV.
 *
 * The original detected stars and forks by walking the received-events feed
 * and cursoring on event id. That was sound for Sidekiq polling continuously,
 * but measured against this account the feed turns over 100 events roughly
 * every six hours — a daily cron would miss almost everything. So stars and
 * forks come from the counts on /users/{user}/repos instead: one request,
 * exact, and immune to any retention window. We only spend a follow-up
 * request naming names on repos whose count actually moved.
 *
 * Known gap: only net change between ticks is visible. A star added and
 * removed inside one window cancels out, as does a follow-then-unfollow.
 */

const GH_API = "https://api.github.com";
const KV_KEY = "state:v2";
const PER_PAGE = 100;
const MAX_PAGES = 20;
const MAX_LOOKUPS = 8; // cap follow-up requests naming actors, per category

function ghHeaders(token, accept = "application/vnd.github+json") {
  const headers = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    // GitHub rejects requests without a User-Agent.
    "User-Agent": "gh-notifier",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function ghFetch(url, token, accept) {
  const res = await fetch(url, { headers: ghHeaders(token, accept) });
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function ghPaginate(path, token, max = MAX_PAGES) {
  const out = [];
  for (let page = 1; page <= max; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = await ghFetch(`${GH_API}${path}${sep}per_page=${PER_PAGE}&page=${page}`, token);
    if (!Array.isArray(batch)) throw new Error(`Unexpected response for ${path}`);
    out.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  return out;
}

/** login -> nothing; we only need the set. */
async function fetchFollowers(user, token) {
  const list = await ghPaginate(`/users/${encodeURIComponent(user)}/followers`, token);
  return list.map((u) => u.login);
}

/** "owner/name" -> { stars, forks } for every repo we own. */
async function fetchRepoStats(user, token) {
  const repos = await ghPaginate(
    `/users/${encodeURIComponent(user)}/repos?type=owner`,
    token,
  );
  const stats = {};
  for (const r of repos) {
    stats[r.full_name] = { stars: r.stargazers_count, forks: r.forks_count };
  }
  return stats;
}

/**
 * Name the most recent stargazers of a repo. The stargazers endpoint returns
 * oldest-first with no sort option, so the newest sit at the end of the last
 * page — which we can address directly from the total count.
 */
async function recentStargazers(fullName, totalCount, wanted, token) {
  const lastPage = Math.max(1, Math.ceil(totalCount / PER_PAGE));
  const page = await ghFetch(
    `${GH_API}/repos/${fullName}/stargazers?per_page=${PER_PAGE}&page=${lastPage}`,
    token,
    "application/vnd.github.star+json",
  );
  if (!Array.isArray(page)) return [];
  // Entries carry { starred_at, user } under the star+json media type.
  return page.slice(-wanted).map((e) => e.user?.login ?? e.login).filter(Boolean);
}

/** Forks does support sort=newest, so this one is straightforward. */
async function recentForkers(fullName, wanted, token) {
  const forks = await ghFetch(
    `${GH_API}/repos/${fullName}/forks?sort=newest&per_page=${Math.min(wanted, PER_PAGE)}`,
    token,
  );
  return Array.isArray(forks) ? forks.map((f) => f.owner?.login).filter(Boolean) : [];
}

/**
 * A login missing from the follower list either unfollowed or deleted their
 * account. git-notifier distinguished the two and it is worth keeping: a 404
 * means the account is gone, not that they walked away.
 */
async function classifyDepartures(logins, token) {
  const out = [];
  for (const [i, login] of logins.entries()) {
    if (i >= MAX_LOOKUPS) {
      out.push({ kind: "unfollow", actor: login });
      continue;
    }
    try {
      await ghFetch(`${GH_API}/users/${encodeURIComponent(login)}`, token);
      out.push({ kind: "unfollow", actor: login });
    } catch (err) {
      out.push({ kind: err.status === 404 ? "deleted" : "unfollow", actor: login });
    }
  }
  return out;
}

/** Diff repo stats into star/fork/unstar events, naming actors where cheap. */
async function diffRepos(prev, curr, token) {
  const events = [];
  let lookups = 0;

  for (const [fullName, now] of Object.entries(curr)) {
    const before = prev[fullName];
    if (!before) continue; // brand new repo — nothing to compare against

    const starDelta = now.stars - before.stars;
    const forkDelta = now.forks - before.forks;

    if (starDelta > 0) {
      let actors = [];
      if (lookups < MAX_LOOKUPS) {
        lookups++;
        actors = await recentStargazers(fullName, now.stars, starDelta, token).catch(() => []);
      }
      events.push(
        ...(actors.length
          ? actors.map((a) => ({ kind: "star", actor: a, repo: fullName }))
          : [{ kind: "star", count: starDelta, repo: fullName }]),
      );
    } else if (starDelta < 0) {
      events.push({ kind: "unstar", count: -starDelta, repo: fullName });
    }

    if (forkDelta > 0) {
      let actors = [];
      if (lookups < MAX_LOOKUPS) {
        lookups++;
        actors = await recentForkers(fullName, forkDelta, token).catch(() => []);
      }
      events.push(
        ...(actors.length
          ? actors.map((a) => ({ kind: "fork", actor: a, repo: fullName }))
          : [{ kind: "fork", count: forkDelta, repo: fullName }]),
      );
    }
  }

  return events;
}

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const userLink = (login) =>
  `<a href="https://github.com/${encodeURIComponent(login)}">${esc(login)}</a>`;

const repoLink = (full) => {
  const [o, r] = full.split("/");
  return `<a href="https://github.com/${encodeURIComponent(o)}/${encodeURIComponent(
    r ?? "",
  )}">${esc(full)}</a>`;
};

const SECTIONS = [
  { kind: "star", icon: "⭐", title: "Starred" },
  { kind: "unstar", icon: "💔", title: "Unstarred" },
  { kind: "fork", icon: "🍴", title: "Forked" },
  { kind: "follow", icon: "➕", title: "New followers" },
  { kind: "unfollow", icon: "➖", title: "Unfollowed" },
  { kind: "deleted", icon: "👻", title: "Account deleted" },
];

function formatMessage(events, followerCount) {
  const parts = [];
  for (const { kind, icon, title } of SECTIONS) {
    const group = events.filter((e) => e.kind === kind);
    if (!group.length) continue;
    const lines = group.map((e) => {
      if (e.actor && e.repo) return `${icon} ${userLink(e.actor)} → ${repoLink(e.repo)}`;
      if (e.actor) return `${icon} ${userLink(e.actor)}`;
      // Count-only fallback when we could not name the actor.
      return `${icon} ${repoLink(e.repo)} <b>+${e.count}</b>`;
    });
    parts.push(`<b>${title}</b>\n${lines.join("\n")}`);
  }
  parts.push(`<i>${followerCount} followers total</i>`);
  return parts.join("\n\n");
}

async function sendTelegram(env, text) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`Telegram ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

async function check(env) {
  const user = env.GITHUB_USER;
  if (!user) throw new Error("GITHUB_USER var is not set");
  const token = env.GITHUB_TOKEN;

  const prev = await env.FOLLOWERS.get(KV_KEY, { type: "json" });
  const firstRun = !prev || !Array.isArray(prev.followers);

  const [followers, repos] = await Promise.all([
    fetchFollowers(user, token),
    fetchRepoStats(user, token),
  ]);

  // Seed silently — otherwise every existing follower and star arrives as new.
  if (firstRun) {
    await env.FOLLOWERS.put(KV_KEY, JSON.stringify({ followers, repos }));
    return { seeded: true, followerCount: followers.length, repoCount: Object.keys(repos).length, events: [] };
  }

  const before = new Set(prev.followers);
  const after = new Set(followers);

  const events = [
    ...(await diffRepos(prev.repos ?? {}, repos, token)),
    ...followers.filter((l) => !before.has(l)).map((actor) => ({ kind: "follow", actor })),
    ...(await classifyDepartures(prev.followers.filter((l) => !after.has(l)), token)),
  ];

  // Deliver before advancing the snapshot. If the send throws, KV keeps the
  // old baseline and the next tick re-detects the same events — the failure
  // mode is a duplicate message, not a silently swallowed follower.
  if (events.length) await sendTelegram(env, formatMessage(events, followers.length));

  await env.FOLLOWERS.put(KV_KEY, JSON.stringify({ followers, repos }));

  return { seeded: false, followerCount: followers.length, events };
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      check(env).catch(async (err) => {
        // A silent cron failure looks exactly like "nothing happened".
        console.error(err);
        try {
          await sendTelegram(
            env,
            `⚠️ <b>gh-notifier failed</b>\n<code>${esc(err.message)}</code>`,
          );
        } catch (e) {
          console.error("could not report failure:", e);
        }
      }),
    );
  },

  /**
   * Manual trigger for seeding and testing. Gated behind TRIGGER_SECRET so a
   * leaked workers.dev URL cannot burn the rate limit or spam the chat.
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/run") {
      return new Response("gh-notifier. GET /run?key=… to check now.\n", { status: 404 });
    }
    if (!env.TRIGGER_SECRET || url.searchParams.get("key") !== env.TRIGGER_SECRET) {
      return new Response("forbidden\n", { status: 403 });
    }
    try {
      return Response.json(await check(env));
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  },
};
