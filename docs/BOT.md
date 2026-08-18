# Running it as a public bot

The `multi-tenant` branch turns the single-account notifier into a Telegram bot that
anyone can subscribe to. Same polling and diffing (`src/github.js` is carried over
unchanged); what is new is that accounts and subscribers are data rather than config.

## What a subscriber does

```
/watch erfnzdeh      start watching a GitHub account
/unwatch erfnzdeh    stop watching one
/list                what you are watching
/stop                unwatch everything and delete your data
/help  /privacy
```

Up to 10 accounts each. `/watch` refuses accounts over 2,000 followers or 200 public
repos — past that the snapshot would be truncated, and a truncated follower list
reports phantom unfollows off its end.

## What they share

Their Telegram chat id and the GitHub usernames they typed. That is the whole record.

No OAuth, no personal access token, no scopes, no email. Every endpoint the poller
touches is public: `/users/{u}/followers`, `/users/{u}/repos`, `/repos/{o}/{r}/forks`
and `/repos/{o}/{r}/events`. The one exception is `/stargazers`, which needs
authentication — but the *bot's* token satisfies it for any public repo, so
subscribers still supply nothing.

`/stop` deletes the record. It is a real delete, not a flag.

**Unless you switch on mirroring.** With `ADMIN_CHAT_ID` set, every message a
subscriber sends is copied to that chat, with their Telegram name, username and id —
see [the admin mirror](#the-admin-mirror). That copy lives in your chat history and
`/stop` cannot reach it, so the paragraph above stops being the whole story. The
bot's `/privacy` text says so on its own whenever the variable is set; if you run a
fork that strips that disclosure, you are collecting messages people were told you
were not.

This is an open tracker: anyone can watch any public account, including one they do
not own. Everything reported is already public on github.com, but it is worth being
deliberate about — the alternative is a one-time verification code in the GitHub
profile bio, which would make it "notifications for my own accounts" instead.

## How the fan-out works

The unit of work is the **account**, not the subscriber. Forty people watching the
same account cost one poll and forty sends.

```
sub:{chat_id}   -> ["erfnzdeh", "octocat"]      what one subscriber watches
watch:{login}   -> { login, chats: [id, ...] }  who to notify — the fan-out index
state:{login}   -> { followers, repos }         the snapshot, one per account
```

`watch:` and `sub:` are written by the webhook; `state:` only by the cron. Separate
keys mean a `/watch` arriving mid-tick cannot clobber a snapshot write.

Accounts are hashed into 12 shards and the cron runs every five minutes, so each
account is polled once an hour while any single tick wakes only a twelfth of them.
That is what keeps a tick inside the free plan's **50 external subrequests per
invocation** — the limit that actually binds here.

Two properties worth preserving if you change this:

- **Delivery happens before the snapshot advances.** If every send fails, the
  snapshot stays put and the next tick re-detects the same events. The failure mode
  is a duplicate message, never a swallowed follower.
- **The snapshot is written only when it changed.** KV allows 1,000 writes a day on
  the free plan. An unconditional write per account per tick would spend that budget
  on ticks where nothing happened, capping the bot at ~40 accounts; writing only on
  change moves the ceiling to "real events per day".

A blocked or deleted chat is the only way the bot learns someone left — Telegram
sends no event for being blocked — so a terminal send error unsubscribes them, and
the last watcher leaving takes the account's snapshot with it.

## Deploying

This branch deliberately uses a **different Worker name** (`gh-notifier-bot`) and its
own KV namespace. Deploying it as `gh-notifier` would replace the single-tenant
notifier on `main` and orphan its secrets, which are per-Worker.

```bash
npx wrangler kv namespace create STORE
```

Put the returned id in `wrangler.jsonc`, then set the secrets — `.dev.vars.example`
documents what each one is for:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put TRIGGER_SECRET
npx wrangler secret put GITHUB_TOKEN
```

`ADMIN_CHAT_ID` is optional and does two jobs: it receives the per-tick failure
summary, and it turns on the admin mirror. Leave it unset and neither happens.

```bash
npx wrangler secret put ADMIN_CHAT_ID
```

Deploy, then point Telegram at the Worker:

```bash
npx wrangler deploy
```

```bash
curl "https://gh-notifier-bot.<subdomain>.workers.dev/admin/set-webhook?key=$TRIGGER_SECRET"
```

`/admin/tick?key=…` runs a pass immediately, which is how you seed without waiting
for the cron.

## The admin mirror

With `ADMIN_CHAT_ID` set, every incoming message is copied to that chat: a JSON
header naming the sender, then the message itself forwarded verbatim. It is the
operator's window into what people are actually typing — which is how you find the
commands they expect and the bot does not have.

Ported from RichTextEchoBot's `AdminForwardMiddleware`, and best-effort in the same
way: nothing it does can fail a webhook or cost a subscriber their reply. The header
and the forward are attempted independently, so a failed header still gets you the
message, and both are handed to `ctx.waitUntil` so the webhook can acknowledge
Telegram immediately — an update left unacknowledged is one Telegram sends again,
which would mirror it twice.

It costs two Telegram calls per message and no KV at all. The ceiling is Telegram's
own rate limit of roughly one message per second into any single chat: two messages
per update means the admin chat starts collecting 429s at about half the inbound rate
a single chat could otherwise absorb. Far away at this scale, and the failures are
logged rather than retried, so crossing it costs visibility rather than delivery.

Set `ADMIN_CHAT_ID` to your own numeric chat id, and press /start on the bot first —
it cannot message you until you do.

## Limits

Measured against the free plan, with the write and sharding behavior above:

| Resource | Free limit | Cost | Binds at |
|---|---|---|---|
| Subrequests | 50 per invocation | ~2 per account | 12 accounts per tick |
| KV reads | 100,000/day | 24 per account/day | ~4,000 accounts |
| KV writes | 1,000/day | one per real event | ~1,000 events/day |
| GitHub API | 5,000/hour per token | 2 per account/hour | ~2,500 accounts |

Comfortable to a few hundred accounts. The first thing to break past that is the
fan-out: one popular account gaining a follower means one poll and N sends, and
those sends are external subrequests against the same 50. The fix when it matters is
Cloudflare Queues, which joined the free plan in February 2026.
