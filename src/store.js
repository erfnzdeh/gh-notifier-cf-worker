/**
 * The KV data model.
 *
 *   sub:{chat_id}   -> ["erfnzdeh", "octocat"]     what one subscriber watches
 *   watch:{login}   -> { login, chats: [id, ...] }  who to notify — the fan-out index
 *   state:{login}   -> { followers, repos }         the snapshot, one per account
 *
 * The reverse index is the point: the cron iterates *accounts*, not
 * subscribers, so an account watched by forty people is still polled once.
 *
 * `watch:` and `sub:` are owned by the webhook; `state:` is owned by the cron.
 * Keeping them in separate keys means a /watch arriving mid-tick cannot clobber
 * a snapshot write, and vice versa.
 *
 * Login case: GitHub logins are case-insensitive to look up but case-preserving
 * to display, so keys are lowercased and the canonical spelling GitHub returned
 * is carried inside the value.
 *
 * Known gap: KV has no compare-and-swap, so two subscribers sending /watch for
 * the same account in the same instant can lose one of the two writes. Rare
 * enough to accept for now; the fix is a Durable Object per account.
 */

const key = {
  sub: (chatId) => `sub:${chatId}`,
  watch: (login) => `watch:${login.toLowerCase()}`,
  state: (login) => `state:${login.toLowerCase()}`,
};

export async function getSubscription(env, chatId) {
  return (await env.STORE.get(key.sub(chatId), { type: "json" })) ?? [];
}

async function putSubscription(env, chatId, logins) {
  if (logins.length) await env.STORE.put(key.sub(chatId), JSON.stringify(logins));
  else await env.STORE.delete(key.sub(chatId));
}

export async function getWatchers(env, login) {
  return await env.STORE.get(key.watch(login), { type: "json" });
}

/**
 * Subscribe a chat to an account. Returns false when it was already watching,
 * so the caller can say so instead of reporting a fresh subscription.
 */
export async function addWatch(env, chatId, login) {
  const logins = await getSubscription(env, chatId);
  if (logins.some((l) => l.toLowerCase() === login.toLowerCase())) return false;

  const entry = (await getWatchers(env, login)) ?? { login, chats: [] };
  if (!entry.chats.includes(chatId)) entry.chats.push(chatId);
  entry.login = login; // refresh the canonical spelling

  await env.STORE.put(key.watch(login), JSON.stringify(entry));
  await putSubscription(env, chatId, [...logins, login]);
  return true;
}

/**
 * Unsubscribe a chat. When the last watcher leaves, the account's snapshot is
 * deleted too — otherwise the cron would keep paying to poll an account nobody
 * is listening to.
 */
export async function removeWatch(env, chatId, login) {
  const logins = await getSubscription(env, chatId);
  const kept = logins.filter((l) => l.toLowerCase() !== login.toLowerCase());
  if (kept.length === logins.length) return false;

  const entry = await getWatchers(env, login);
  if (entry) {
    entry.chats = entry.chats.filter((c) => c !== chatId);
    if (entry.chats.length) {
      await env.STORE.put(key.watch(login), JSON.stringify(entry));
    } else {
      await env.STORE.delete(key.watch(login));
      await env.STORE.delete(key.state(login));
    }
  }

  await putSubscription(env, chatId, kept);
  return true;
}

/** Every account with at least one watcher. */
export async function listWatched(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.STORE.list({ prefix: "watch:", cursor });
    for (const k of page.keys) out.push(k.name.slice("watch:".length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

export async function getState(env, login) {
  return await env.STORE.get(key.state(login), { type: "json" });
}

/**
 * Write the snapshot only when it actually differs from what is stored.
 *
 * This is what makes the free tier viable: KV allows 1,000 writes a day, and
 * an unconditional write per account per tick spends that budget on ticks
 * where nothing happened. Writing only on change moves the ceiling from
 * "accounts × ticks per day" to "real events per day".
 */
export async function putStateIfChanged(env, login, snapshot) {
  const next = JSON.stringify(snapshot);
  const current = await env.STORE.get(key.state(login));
  if (current === next) return false;
  await env.STORE.put(key.state(login), next);
  return true;
}
