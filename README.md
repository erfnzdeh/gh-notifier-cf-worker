# gh-notifier

Telegram alerts when someone **stars**, **forks**, **follows** or **unfollows** you on GitHub.
Runs as a single Cloudflare Worker on a cron trigger. Free tier, no server.

GitHub has no notification event for any of these — its notification system is built
entirely around repository conversations, CI and mentions — so the only way to know is
to poll and diff.

## Lineage

A rewrite of the notification logic from [andreausu/git-notifier](https://github.com/andreausu/git-notifier)
(MIT, unmaintained since 2019), which was multi-tenant SaaS: Sinatra + Redis + Sidekiq +
Puma + nginx across five Dockerfiles, with GitHub OAuth signup and HTML email digests.
Single-user on Workers, that collapses to one cron handler and one KV key.

Two deliberate departures from the original:

**Star and fork detection.** git-notifier walked the received-events feed, cursoring on
event id. Measured against a real account, that feed turns over 100 events roughly every
six hours — fine for Sidekiq polling continuously, but a daily cron would miss almost
everything. This version diffs `stargazers_count` and `forks_count` from
`/users/{user}/repos` instead: one request, exact, and immune to any retention window.
Naming *who* costs one extra request, and only for repos whose count actually moved.

**Owned-repo matching.** The original tested `event.repo.name.include?(login)`, a substring
match against `owner/name` that also fires on anyone else's repo whose *name* contains your
username. This compares the owner segment exactly.

Kept from the original: distinguishing an unfollow from a deleted account (a 404 on the
user lookup means they're gone, not that they left).

## Setup

```bash
npm install
```

**1. Telegram bot** — message [@BotFather](https://t.me/BotFather), send `/newbot`, keep the
token. Then send your new bot any message and read your chat id from:

```bash
curl -s "https://api.telegram.org/bot<BOT_TOKEN>/getUpdates" | jq '.result[0].message.chat.id'
```

**2. KV namespace** — create it and paste the printed `id` into `wrangler.jsonc`:

```bash
npx wrangler kv namespace create FOLLOWERS
```

**3. Secrets:**

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put TRIGGER_SECRET
```

`GITHUB_TOKEN` is optional — every endpoint used is public. But Workers share egress IPs
and unauthenticated GitHub is 60 req/hr per IP, so a scopeless token is worth adding:

```bash
npx wrangler secret put GITHUB_TOKEN
```

**4. Deploy and seed.** The first run stores a baseline silently; without it every existing
follower and star would arrive as a notification.

```bash
npx wrangler deploy
curl "https://gh-notifier.<your-subdomain>.workers.dev/run?key=<TRIGGER_SECRET>"
```

Set `vars.GITHUB_USER` in `wrangler.jsonc` if you are not `erfnzdeh`.

## Cost

One cron tick per day: ~2 GitHub requests, 1 KV read, 1 KV write, plus one lookup per repo
whose counts moved.

| Resource | Free limit | Used |
|---|---|---|
| Cron Triggers | 5 per account | 1 |
| Worker requests | 100,000/day | ~1/day |
| KV reads | 100,000/day | 1/day |
| KV writes | 1,000/day | 1/day |
| KV storage | 1 GB | ~3 KB |

## Limits

- Only **net change between ticks** is visible. A star added and removed inside one window
  cancels out, as does a follow-then-unfollow. Any polling design has this gap.
- Unstars are reported as a count, not a name — GitHub exposes no way to see who left
  without storing every stargazer login.
- `/users/{user}/repos` covers repos you own. Add a token with `repo` scope to include
  private ones.

## Testing

`src/index.js` exposes `GET /run?key=<TRIGGER_SECRET>` for manual runs, returning the diff
as JSON. `npx wrangler tail` streams live logs. Cron failures report themselves to Telegram
rather than failing silently, since a silent failure is indistinguishable from "nothing
happened".

## License

MIT, inheriting from git-notifier. See `LICENSE`.
