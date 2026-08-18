/**
 * Everything that talks to GitHub: polling an account and diffing it against
 * the previous snapshot. Lifted from the single-tenant worker unchanged except
 * for the entry point — `pollAccount` takes the login and the previous
 * snapshot as arguments instead of reading them from env and KV, so one tick
 * can poll many accounts.
 *
 * GitHub emits no notification for stars, forks, follows or unfollows, so we
 * poll and diff. Stars and forks come from the counts on /users/{user}/repos:
 * one request, exact, and immune to any retention window. The counts tell us
 * *that* something moved; naming *who* needs the stargazer and fork lists, so
 * we keep those logins in the snapshot and diff them as sets.
 *
 * Known gap: only net change between ticks is visible. A star added and
 * removed inside one window cancels out, as does a follow-then-unfollow.
 */

const GH_API = "https://api.github.com";
const PER_PAGE = 100;
const MAX_PAGES = 20;
const MAX_LOOKUPS = 8; // refetches for repos whose count moved, per account
const MAX_BACKFILL = 20; // list fetches for repos we have no baseline for

/** The ceiling `ghPaginate` can actually reach, and so the largest account we
 *  can snapshot honestly. `/watch` refuses anything above it rather than
 *  silently watching a truncated follower list. */
export const MAX_TRACKABLE = MAX_PAGES * PER_PAGE;

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

/**
 * The profile, or null if there is no such account. Used by `/watch` both to
 * reject typos and to learn the account's size before agreeing to track it.
 * Returns GitHub's canonical spelling of the login, which is what we store.
 */
export async function fetchUser(login, token) {
  try {
    const u = await ghFetch(`${GH_API}/users/${encodeURIComponent(login)}`, token);
    return { login: u.login, followers: u.followers, repos: u.public_repos, type: u.type };
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function fetchFollowers(user, token) {
  const list = await ghPaginate(`/users/${encodeURIComponent(user)}/followers`, token);
  return list.map((u) => u.login);
}

/** "owner/name" -> { stars, forks } for every repo the account owns. */
async function fetchRepoStats(user, token) {
  const repos = await ghPaginate(`/users/${encodeURIComponent(user)}/repos?type=owner`, token);
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
  if (count > MAX_TRACKABLE) return undefined;
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
 * Fallback for naming arrivals when the actor list is out of reach — the
 * normal case for stargazers, since that endpoint demands a token with
 * `public_repo` while everything else here reads fine anonymously.
 *
 * /repos/{owner}/{repo}/events needs no authentication and carries WatchEvent
 * and ForkEvent with the actor attached. It retains only ~300 events for ~90
 * days and has no event for *un*starring, so it can never name a departure.
 */
async function fetchRepoEvents(fullName, token) {
  try {
    const events = await ghFetch(`${GH_API}/repos/${fullName}/events?per_page=${PER_PAGE}`, token);
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
 * account. A 404 means the account is gone, not that they walked away.
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
 * snapshot to store next. A repo whose count moved gets its actor list
 * refetched and set-diffed, which names both arrivals and departures. When we
 * cannot do that — budget spent, request failed, list too long, or no baseline
 * yet — we emit the count-only event and drop the stored list rather than keep
 * one we know is stale, so the next tick backfills a fresh baseline.
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
          : [{ kind: delta > 0 ? spec.added : spec.removed, count: Math.abs(delta), repo: fullName }]),
      );
    }

    repos[fullName] = entry;
  }

  return { events, repos };
}

/**
 * Poll one account and diff it against `prev`. Returns the events to report
 * and the snapshot to store — but writes nothing and sends nothing, so the
 * caller keeps control of the send-before-commit ordering.
 *
 * `prev` of null means we have never seen this account: the caller must store
 * the snapshot and stay quiet, or the first message would list every existing
 * follower and star as new.
 */
export async function pollAccount(login, prev, token) {
  const firstRun = !prev || !Array.isArray(prev.followers);

  const [followers, repos] = await Promise.all([
    fetchFollowers(login, token),
    fetchRepoStats(login, token),
  ]);

  // On a first run every repo is unknown, so diffRepos raises no events — it
  // just collects the actor lists that let the *next* tick name people.
  const { events: repoEvents, repos: repoState } = await diffRepos(
    firstRun ? {} : prev.repos ?? {},
    repos,
    token,
  );

  const snapshot = { followers, repos: repoState };
  const summary = { followerCount: followers.length, repoCount: Object.keys(repos).length };

  if (firstRun) return { seeded: true, snapshot, events: [], ...summary };

  const before = new Set(prev.followers);
  const after = new Set(followers);

  const events = [
    ...repoEvents,
    ...followers.filter((l) => !before.has(l)).map((actor) => ({ kind: "follow", actor })),
    ...(await classifyDepartures(prev.followers.filter((l) => !after.has(l)), token)),
  ];

  return { seeded: false, snapshot, events, ...summary };
}
