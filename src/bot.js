/** Telegram command handling. */

import { fetchUser, MAX_TRACKABLE } from "./github.js";
import { addWatch, getSubscription, removeWatch } from "./store.js";
import { esc } from "./format.js";
import { sendMessage } from "./telegram.js";

const MAX_WATCHES = 10; // accounts one subscriber may watch
const MAX_REPOS = 200; // an account with more costs too much to snapshot

// GitHub's own rule: alphanumerics and single inner hyphens, up to 39 chars.
const LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

const HELP = [
  "<b>gh-notifier</b> — GitHub activity GitHub does not notify you about:",
  "stars, forks, follows and unfollows.",
  "",
  "<b>/watch</b> <i>username</i> — start watching a GitHub account",
  "<b>/unwatch</b> <i>username</i> — stop watching one",
  "<b>/list</b> — what you are watching",
  "<b>/stop</b> — unwatch everything and delete your data",
  "",
  `You can watch up to ${MAX_WATCHES} accounts. Only public activity is visible,`,
  "and only the net change between checks — a star added and removed within",
  "the same window cancels out.",
].join("\n");

const PRIVACY = [
  "<b>What I store</b>",
  "Your Telegram chat id and the GitHub usernames you asked me to watch.",
  "Nothing else — no GitHub login, no token, no email. Everything I read is",
  "public on github.com.",
  "",
  "<b>/stop</b> deletes all of it.",
].join("\n");

/**
 * Only true when the operator has switched mirroring on, so it is appended
 * rather than baked in — a bot running without ADMIN_CHAT_ID would be claiming
 * a disclosure it does not make. Said plainly: someone deciding what to type
 * into a stranger's bot is owed the blunt version, not a clause about
 * "operational purposes".
 */
const MIRRORED = [
  "",
  "<b>What the operator sees</b>",
  "Every message you send me is copied to the person who runs this bot,",
  "with your Telegram name, username and id. <b>/stop</b> erases your data",
  "here but cannot unsend those copies — so do not send me anything you",
  "would not want read.",
].join("\n");

/** The notice, plus the mirroring paragraph when mirroring is actually on. */
const privacy = (env) => (env.ADMIN_CHAT_ID ? `${PRIVACY}\n${MIRRORED}` : PRIVACY);

const reply = (text) => ({ text });

async function watch(env, chatId, arg) {
  if (!arg) return reply("Usage: <b>/watch</b> <i>username</i>\nFor example: <code>/watch erfnzdeh</code>");
  if (!LOGIN.test(arg)) return reply(`<code>${esc(arg)}</code> is not a valid GitHub username.`);

  const watching = await getSubscription(env, chatId);
  if (watching.length >= MAX_WATCHES) {
    return reply(
      `You are already watching ${watching.length} accounts, which is the limit. ` +
        "Use <b>/unwatch</b> to make room.",
    );
  }

  const user = await fetchUser(arg, env.GITHUB_TOKEN);
  if (!user) return reply(`No GitHub account called <code>${esc(arg)}</code>.`);

  // Refuse accounts we cannot snapshot honestly rather than watching a
  // truncated follower list and reporting phantom unfollows off the end of it.
  if (user.followers > MAX_TRACKABLE) {
    return reply(
      `<b>${esc(user.login)}</b> has ${user.followers.toLocaleString()} followers, ` +
        `more than the ${MAX_TRACKABLE.toLocaleString()} I can track accurately.`,
    );
  }
  if (user.repos > MAX_REPOS) {
    return reply(
      `<b>${esc(user.login)}</b> has ${user.repos} public repos, ` +
        `more than the ${MAX_REPOS} I can check on every pass.`,
    );
  }

  const added = await addWatch(env, chatId, user.login);
  if (!added) return reply(`Already watching <b>${esc(user.login)}</b>.`);

  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  return reply(
    `Watching <b>${esc(user.login)}</b> — ${plural(user.followers, "follower")}, ` +
      `${plural(user.repos, "public repo")}.\n\n` +
      "I take a baseline first, then message you when something changes.",
  );
}

async function unwatch(env, chatId, arg) {
  if (!arg) return reply("Usage: <b>/unwatch</b> <i>username</i>");
  const removed = await removeWatch(env, chatId, arg);
  return reply(
    removed
      ? `Stopped watching <b>${esc(arg)}</b>.`
      : `You are not watching <code>${esc(arg)}</code>. Try <b>/list</b>.`,
  );
}

async function list(env, chatId) {
  const watching = await getSubscription(env, chatId);
  if (!watching.length) return reply("You are not watching anything yet. Try <b>/watch</b> <i>username</i>.");
  const lines = watching.map((l) => `• <a href="https://github.com/${encodeURIComponent(l)}">${esc(l)}</a>`);
  return reply(`<b>Watching ${watching.length}</b>\n${lines.join("\n")}`);
}

async function stop(env, chatId) {
  const watching = await getSubscription(env, chatId);
  for (const login of watching) await removeWatch(env, chatId, login);
  return reply(
    watching.length
      ? `Stopped watching ${watching.length} account${watching.length === 1 ? "" : "s"}. Your data is deleted.`
      : "Nothing to stop — I hold no data for you.",
  );
}

/**
 * Route one Telegram message. Returns the text to reply with, or null when
 * the update is not something we answer.
 */
export async function handleMessage(env, message) {
  const chatId = message?.chat?.id;
  const text = (message?.text ?? "").trim();
  // Nullish, not falsy: a chat id is a number, and 0 is a legal one.
  if (chatId == null || !text.startsWith("/")) return null;

  // In groups Telegram appends the bot's username: "/watch@my_bot erfnzdeh".
  const [rawCommand, ...rest] = text.split(/\s+/);
  const command = rawCommand.split("@")[0].toLowerCase();
  const arg = rest[0] ?? "";

  switch (command) {
    case "/start":
      return reply(`${HELP}\n\n${privacy(env)}`);
    case "/help":
      return reply(HELP);
    case "/privacy":
      return reply(privacy(env));
    case "/watch":
      return watch(env, chatId, arg);
    case "/unwatch":
      return unwatch(env, chatId, arg);
    case "/list":
      return list(env, chatId);
    case "/stop":
      return stop(env, chatId);
    default:
      return reply("I do not know that command. <b>/help</b> lists them.");
  }
}

/**
 * Handle an update and deliver the answer. Errors are reported to the user
 * rather than swallowed — a command that silently does nothing is worse than
 * one that says it failed.
 */
export async function handleUpdate(env, update) {
  const message = update?.message;
  const chatId = message?.chat?.id;
  if (chatId == null) return;

  let answer;
  try {
    answer = await handleMessage(env, message);
  } catch (err) {
    console.error(`command failed: ${err.message}`);
    answer = reply("Something went wrong handling that. Try again in a moment.");
  }
  if (!answer) return;

  try {
    await sendMessage(env, chatId, answer.text);
  } catch (err) {
    console.error(`could not reply to ${chatId}: ${err.message}`);
  }
}
