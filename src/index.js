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
 * forks come from /users/{user}/repos instead: one request, exact, and immune
 * to any retention window.
 *
 * The counts on that response tell us *that* something moved; naming *who*
 * needs the stargazer and fork lists, so we keep those logins in the snapshot
 * and diff them as sets. Only repos whose count actually changed get refetched,
 * so the request budget is the same as when we merely counted — but every
 * event carries an account, unstars and deleted forks included.
 *
 * Known gap: only net change between ticks is visible. A star added and
 * removed inside one window cancels out, as does a follow-then-unfollow.
 */

const GH_API = "https://api.github.com";
const KV_KEY = "state:v3";
const PER_PAGE = 100;
const MAX_PAGES = 20;
const MAX_LOOKUPS = 8; // refetches for repos whose count moved, per tick
const MAX_BACKFILL = 20; // list fetches for repos we have no baseline for, per tick

function ghHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    // GitHub rejects requests without a User-Agent.
    "User-Agent": "gh-notifier",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function ghFetch(url, token) {
  const res = await fetch(url, { headers: ghHeaders(token) });
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
 * The two per-repo actor lists, described once so the diff can treat them
 * identically: which snapshot fields hold them, and what to call the people
 * arriving and leaving.
 */
const ACTOR_LISTS = [
  {
    field: "stargazers",
    countField: "stars",
    path: "stargazers",
    pick: (u) => u.login,
    added: "star",
    removed: "unstar",
    eventType: "WatchEvent",
  },
  {
    field: "forkers",
    countField: "forks",
    path: "forks",
    pick: (f) => f.owner?.login,
    added: "fork",
    removed: "unfork",
    eventType: "ForkEvent",
  },
];

/**
 * Every login on one of a repo's actor lists, or undefined if the list is
 * longer than we are willing to page through — past that the snapshot stops
 * being worth its request cost and we fall back to reporting counts.
 */
async function fetchActors(spec, fullName, count, token) {
  if (count > MAX_PAGES * PER_PAGE) return undefined;
  try {
    const rows = await ghPaginate(`/repos/${fullName}/${spec.path}`, token);
    return rows.map(spec.pick).filter(Boolean);
  } catch (err) {
    // Degrading to a count-only event is fine; doing it silently is not. The
    // stargazers endpoint requires authentication (forks does not), so a
    // missing or expired GITHUB_TOKEN shows up here and nowhere else.
    console.warn(`could not list ${spec.path} for ${fullName}: ${err.message}`);
    return undefined;
  }
}

/**
 * Fallback for naming arrivals when the actor list is out of reach — which is
 * the normal case for stargazers, since that endpoint demands a token with
 * `contents=write` (fine-grained) or `public_repo` (classic) while everything
 * else here reads fine anonymously.
 *
 * /repos/{owner}/{repo}/events needs no authentication at all and carries
 * WatchEvent and ForkEvent with the actor attached. Two caveats keep it a
 * fallback rather than the primary source: it retains only ~300 events for
 * ~90 days, and there is no event for *un*starring, so it can never name a
 * departure. Newest-first, so the first matches are the ones we want.
 */
async function fetchRepoEvents(fullName, token) {
  try {
    const events = await ghFetch(
      `${GH_API}/repos/${fullName}/events?per_page=${PER_PAGE}`,
      token,
    );
    return Array.isArray(events) ? events : [];
  } catch (err) {
    console.warn(`could not read events for ${fullName}: ${err.message}`);
    return [];
  }
}

const actorsFromEvents = (events, type, wanted) =>
  events
    .filter((e) => e.type === type)
    .map((e) => e.actor?.login)
    .filter(Boolean)
    .slice(0, wanted);

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

/**
 * Diff repo snapshots into star/unstar/fork/unfork events, and return the
 * snapshot to store next. Returns { events, repos }.
 *
 * A repo whose count moved gets its actor list refetched and set-diffed, which
 * names both arrivals and departures. When we cannot do that — budget spent,
 * request failed, list too long, or no baseline stored yet — we emit the old
 * count-only event and drop the stored list rather than keep one we know is
 * stale, so the next tick backfills a fresh baseline.
 */
async function diffRepos(prev, curr, token) {
  const events = [];
  const repos = {};
  let lookups = 0;
  let backfills = 0;

  for (const [fullName, now] of Object.entries(curr)) {
    const before = prev[fullName];
    const entry = { stars: now.stars, forks: now.forks };

    // Stars and forks share one events request; fetched only if a fallback
    // actually needs it, and only once per repo.
    let cachedEvents;
    const repoEvents = async () => {
      if (cachedEvents === undefined) cachedEvents = await fetchRepoEvents(fullName, token);
      return cachedEvents;
    };

    for (const spec of ACTOR_LISTS) {
      const count = now[spec.countField];
      const wasList = before?.[spec.field];
      // A brand new repo has nothing to compare against — no events, but we
      // still want a baseline so the next tick can name whoever shows up.
      const delta = before ? count - before[spec.countField] : 0;

      let list;
      if (delta !== 0) {
        if (lookups < MAX_LOOKUPS) {
          lookups++;
          list = await fetchActors(spec, fullName, count, token);
        }
      } else if (wasList === undefined && count > 0 && backfills < MAX_BACKFILL) {
        backfills++;
        list = await fetchActors(spec, fullName, count, token);
      } else {
        list = wasList;
      }

      if (list !== undefined) entry[spec.field] = list;

      if (delta === 0) continue;

      const named = [];
      if (list && wasList) {
        const gone = new Set(wasList);
        const here = new Set(list);
        for (const actor of list) {
          if (!gone.has(actor)) named.push({ kind: spec.added, actor, repo: fullName });
        }
        for (const actor of wasList) {
          if (!here.has(actor)) named.push({ kind: spec.removed, actor, repo: fullName });
        }
      }

      // The set diff is authoritative and covers both directions. Only when it
      // could not run do we fall back to the events feed, which names arrivals
      // and nothing else — a departure stays a bare count either way.
      if (!named.length && delta > 0) {
        const actors = actorsFromEvents(await repoEvents(), spec.eventType, delta);
        for (const actor of actors) {
          named.push({ kind: spec.added, actor, repo: fullName });
        }
      }

      events.push(
        ...(named.length
          ? named
          : [
              {
                kind: delta > 0 ? spec.added : spec.removed,
                count: Math.abs(delta),
                repo: fullName,
              },
            ]),
      );
    }

    repos[fullName] = entry;
  }

  return { events, repos };
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
  { kind: "unstar", icon: "💔", title: "Unstarred", sign: "−" },
  { kind: "fork", icon: "🍴", title: "Forked" },
  { kind: "unfork", icon: "🗑", title: "Fork deleted", sign: "−" },
  { kind: "follow", icon: "➕", title: "New followers" },
  { kind: "unfollow", icon: "➖", title: "Unfollowed" },
  { kind: "deleted", icon: "👻", title: "Account deleted" },
];

// Telegram caps a message at 4096 characters; a viral day must not lose the
// follower total off the end.
const MAX_LINES = 20;

function formatMessage(events, followerCount) {
  const parts = [];
  for (const { kind, icon, title, sign = "+" } of SECTIONS) {
    const group = events.filter((e) => e.kind === kind);
    if (!group.length) continue;
    const lines = group.map((e) => {
      if (e.actor && e.repo) return `${icon} ${userLink(e.actor)} → ${repoLink(e.repo)}`;
      if (e.actor) return `${icon} ${userLink(e.actor)}`;
      // Count-only fallback when we could not name the actor.
      return `${icon} ${repoLink(e.repo)} <b>${sign}${e.count}</b>`;
    });
    const shown = lines.slice(0, MAX_LINES);
    if (lines.length > shown.length) {
      shown.push(`<i>…and ${lines.length - shown.length} more</i>`);
    }
    parts.push(`<b>${title}</b>\n${shown.join("\n")}`);
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

  // On a first run every repo is unknown, so diffRepos raises no events — it
  // just collects the actor lists that let the *next* tick name people.
  const { events: repoEvents, repos: repoState } = await diffRepos(
    firstRun ? {} : prev.repos ?? {},
    repos,
    token,
  );

  // Seed silently — otherwise every existing follower and star arrives as new.
  if (firstRun) {
    await env.FOLLOWERS.put(KV_KEY, JSON.stringify({ followers, repos: repoState }));
    return { seeded: true, followerCount: followers.length, repoCount: Object.keys(repos).length, events: [] };
  }

  const before = new Set(prev.followers);
  const after = new Set(followers);

  const events = [
    ...repoEvents,
    ...followers.filter((l) => !before.has(l)).map((actor) => ({ kind: "follow", actor })),
    ...(await classifyDepartures(prev.followers.filter((l) => !after.has(l)), token)),
  ];

  // Deliver before advancing the snapshot. If the send throws, KV keeps the
  // old baseline and the next tick re-detects the same events — the failure
  // mode is a duplicate message, not a silently swallowed follower.
  if (events.length) await sendTelegram(env, formatMessage(events, followers.length));

  await env.FOLLOWERS.put(KV_KEY, JSON.stringify({ followers, repos: repoState }));

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
