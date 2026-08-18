/**
 * gh-notifier: a multi-tenant Telegram bot for the GitHub activity GitHub
 * does not notify you about: stars, forks, follows and unfollows.
 *
 * Descended from the single-tenant worker, which watched one hardcoded account
 * and messaged one hardcoded chat. The polling and diffing logic is unchanged
 * (see github.js); what is new is that accounts and subscribers are data.
 *
 * The unit of work is the *account*, not the subscriber. Forty people watching
 * the same account cost one poll and forty sends, which is why the fan-out
 * index in store.js exists.
 */

import { pollAccount } from "./github.js";
import { formatMessage, esc } from "./format.js";
import { getState, getWatchers, listWatched, putStateIfChanged, removeWatch } from "./store.js";
import { sendMessage, setWebhook } from "./telegram.js";
import { handleUpdate } from "./bot.js";
import { forwardToAdmin } from "./admin-forward.js";

/**
 * Accounts are spread across ticks by a hash of their login, so each is polled
 * once per full cycle. With a five-minute cron and SHARDS at 12, that is one
 * pass an hour, and any one tick only wakes a twelfth of the accounts.
 */
const TICK_MS = 5 * 60 * 1000;
const SHARDS = 12;

/**
 * The free plan allows 50 external subrequests per invocation. Each account
 * costs two before any actor lookups or sends, so this leaves comfortable
 * headroom. Accounts over the cap are not dropped. They simply come round on
 * the next cycle, and the tick says so in the logs rather than truncating
 * silently.
 */
const MAX_ACCOUNTS_PER_TICK = 12;

/** FNV-1a, only ever used to spread logins evenly across shards. */
function shardOf(login) {
  let h = 0x811c9dc5;
  for (let i = 0; i < login.length; i++) {
    h ^= login.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % SHARDS;
}

/**
 * Poll one account and tell its watchers.
 *
 * Delivery happens before the snapshot advances. If every send fails the
 * snapshot stays put and the next tick re-detects the same events, so the
 * failure mode is a duplicate message rather than a silently swallowed
 * follower. Once anyone has been told, the snapshot advances, because re-sending to
 * the whole list to catch one straggler is the worse trade.
 */
async function pollOne(env, loginKey) {
  const entry = await getWatchers(env, loginKey);
  if (!entry?.chats?.length) return { skipped: true };

  const login = entry.login ?? loginKey;
  const prev = await getState(env, login);
  const { seeded, snapshot, events, followerCount } = await pollAccount(
    login,
    prev,
    env.GITHUB_TOKEN,
  );

  // A first sighting is stored silently, otherwise the opening message would
  // list every existing follower and star as new.
  if (seeded || !events.length) {
    await putStateIfChanged(env, login, snapshot);
    return { seeded, events: 0, delivered: 0 };
  }

  const text = formatMessage(login, events, followerCount);
  const gone = [];
  let delivered = 0;
  let failed = 0;

  for (const chatId of entry.chats) {
    try {
      const res = await sendMessage(env, chatId, text);
      if (res.gone) gone.push(chatId);
      else delivered++;
    } catch (err) {
      failed++;
      console.error(`send to ${chatId} failed: ${err.message}`);
    }
  }

  if (delivered || gone.length) await putStateIfChanged(env, login, snapshot);

  // Blocked or deleted chats are the only way we learn someone left; Telegram
  // sends no event for it. Done after the snapshot write, so the last watcher
  // leaving also takes the snapshot with it.
  for (const chatId of gone) await removeWatch(env, chatId, login);

  return { seeded: false, events: events.length, delivered, failed, dropped: gone.length };
}

/** One cron tick: poll the shard of accounts that is due. */
export async function tick(env, at = Date.now()) {
  const shard = Math.floor(at / TICK_MS) % SHARDS;
  const all = await listWatched(env);
  const due = all.filter((login) => shardOf(login) === shard);

  // KV lists lexicographically, so a plain slice would defer the same tail
  // every cycle and those accounts would never be polled at all. The window
  // advances a full batch per cycle instead, so consecutive cycles cover
  // disjoint runs and an oversized shard is fully covered in ceil(due/batch)
  // cycles rather than crawling forward one account at a time.
  const cycle = Math.floor(at / (TICK_MS * SHARDS));
  const offset = due.length ? (cycle * MAX_ACCOUNTS_PER_TICK) % due.length : 0;
  const batch = [...due.slice(offset), ...due.slice(0, offset)].slice(0, MAX_ACCOUNTS_PER_TICK);

  if (due.length > batch.length) {
    console.warn(
      `shard ${shard}: ${due.length} accounts due, polling ${batch.length} from offset ${offset}; ` +
        `${due.length - batch.length} wait for a later cycle`,
    );
  }

  const results = [];
  for (const login of batch) {
    try {
      results.push({ login, ...(await pollOne(env, login)) });
    } catch (err) {
      // One unreachable account must not cost every other subscriber their tick.
      console.error(`poll ${login} failed: ${err.message}`);
      results.push({ login, error: err.message });
    }
  }

  const failures = results.filter((r) => r.error);
  if (failures.length && env.ADMIN_CHAT_ID) {
    const lines = failures.map((f) => `<code>${esc(f.login)}</code>: ${esc(f.error)}`);
    await sendMessage(
      env,
      env.ADMIN_CHAT_ID,
      `⚠️ <b>${failures.length} account${failures.length === 1 ? "" : "s"} failed</b>\n${lines.join("\n")}`,
    ).catch((e) => console.error(`could not reach admin: ${e.message}`));
  }

  return { shard, watched: all.length, due: due.length, polled: batch.length, results };
}

const authorized = (env, url) =>
  env.TRIGGER_SECRET && url.searchParams.get("key") === env.TRIGGER_SECRET;

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      tick(env, controller.scheduledTime).catch((err) => {
        // A silent cron failure looks exactly like "nothing happened".
        console.error(`tick failed: ${err.message}`);
      }),
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Telegram retries anything that is not a 2xx, so an update we accepted is
    // acknowledged even when handling it went wrong. handleUpdate reports its
    // own failures to the user.
    if (url.pathname === "/telegram/webhook") {
      if (request.method !== "POST") return new Response("method not allowed\n", { status: 405 });
      if (
        !env.TELEGRAM_WEBHOOK_SECRET ||
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET
      ) {
        return new Response("forbidden\n", { status: 403 });
      }
      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("ok\n");
      }
      // Mirrored before handling and never awaited on the response path: the
      // operator should see what arrived even if handling it goes wrong, and
      // an update Telegram has not been acknowledged for is an update it will
      // send again, which would mirror it twice. forwardToAdmin never
      // rejects, so nothing here can fail the webhook.
      const mirrored = forwardToAdmin(env, update);
      if (ctx?.waitUntil) ctx.waitUntil(mirrored);
      else await mirrored; // no ctx outside the runtime; keeps tests deterministic

      await handleUpdate(env, update);
      return new Response("ok\n");
    }

    // Register this Worker with Telegram. Saves keeping the bot token on a
    // laptop just to call setWebhook once.
    if (url.pathname === "/admin/set-webhook") {
      if (!authorized(env, url)) return new Response("forbidden\n", { status: 403 });
      const target = `${url.origin}/telegram/webhook`;
      const res = await setWebhook(env, target, env.TELEGRAM_WEBHOOK_SECRET);
      return Response.json({ target, ...res }, { status: res.ok ? 200 : 502 });
    }

    // Run a tick now, for seeding and for testing without waiting on the cron.
    if (url.pathname === "/admin/tick") {
      if (!authorized(env, url)) return new Response("forbidden\n", { status: 403 });
      try {
        const at = Number(url.searchParams.get("at")) || Date.now();
        return Response.json(await tick(env, at));
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    return new Response("gh-notifier bot. Talk to it on Telegram.\n", { status: 404 });
  },
};
