# gh-notifier-cf-worker

![license](https://img.shields.io/github/license/erfnzdeh/gh-notifier-cf-worker) ![ci](https://github.com/erfnzdeh/gh-notifier-cf-worker/actions/workflows/ci.yml/badge.svg) ![platform](https://img.shields.io/badge/platform-Cloudflare_Workers-F38020?logo=cloudflareworkers&logoColor=white) ![alerts](https://img.shields.io/badge/alerts-Telegram-26A5E4?logo=telegram&logoColor=white) ![cost](https://img.shields.io/badge/cost-free_tier-brightgreen)

<p align="center">
  <img src="docs/banner.png" alt="Telegram message from the bot listing new followers and an unfollow" width="700">
</p>

Telegram alerts when someone **stars**, **forks**, **follows** or **unfollows** you on
GitHub. One Cloudflare Worker on a cron trigger. Free tier, no server, no database.

GitHub has no notification event for any of these. Its notification system is built
entirely around repository conversations, CI and mentions. `/notifications/settings`
doesn't even exist as an endpoint, so the only way to know is to poll and diff.

> **Looking for the Telegram bot version?** The `multi-tenant` branch runs this as a
> bot anyone can subscribe to, with `/watch <username>`. See [docs/BOT.md](docs/BOT.md).

## How it works

One cron tick fetches your follower list and your repo list, diffs both against a
snapshot in Workers KV, and reports what changed.

```
cron ─▶ GET /users/{user}/followers ─┐
        GET /users/{user}/repos ─────┼─▶ diff vs KV ─▶ Telegram ─▶ commit new snapshot
                                     ┘
```

Two design decisions worth knowing, both learned the hard way:

**Stars and forks come from repo counts, not the events feed.** The obvious approach is
to walk `/users/{user}/received_events` for `WatchEvent` and `ForkEvent`. That feed is
capped at ~300 events and, on an account that follows a few active people, turns over 100
events in about six hours, so a daily cron would miss almost everything. Diffing
`stargazers_count` and `forks_count` from `/users/{user}/repos` is one request, exact, and
has no retention window. Naming *who* means keeping each repo's stargazer and fork logins
in the snapshot and diffing them as sets: one extra request, and only for repos whose
count actually moved. That set diff is what makes an unstar or a deleted fork name an
account instead of a bare number.

**Delivery happens before the snapshot advances.** Commit-then-send means a failed send
silently consumes the events it failed to report. Send-then-commit means a failure costs
a duplicate message on the next tick instead. Losing a follower notification is worse than
seeing one twice.

## Setup

```bash
npm install
```

**1. Telegram bot.** Message [@BotFather](https://t.me/BotFather), `/newbot`, keep the
token. Send your new bot any message, then read your chat id:

```bash
curl -s "https://api.telegram.org/bot<BOT_TOKEN>/getUpdates" | jq '.result[0].message.chat.id'
```

**2. KV namespace.** Create it and paste the printed `id` into `wrangler.jsonc`:

```bash
npx wrangler kv namespace create FOLLOWERS
```

**3. Set `GITHUB_USER`** in `wrangler.jsonc` to your own username.

**4. Secrets.** Run each and paste at the prompt. The value is *not* a command argument:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put TRIGGER_SECRET
```

`TRIGGER_SECRET` is any random string; it guards the manual endpoint. Generate one with
`openssl rand -hex 16`.

**5. `GITHUB_TOKEN`** is required. Followers, repo counts and forks are all readable
anonymously, but **`/repos/{owner}/{repo}/stargazers` is not**: unauthenticated it returns
`401 Requires authentication`. Without a working token you get stars reported as a bare
`+1` with no name. A token also lifts the 60 requests/hour **per source IP** anonymous
limit to 5,000/hour, which matters because Workers share egress IPs with other tenants.

Token type matters, and the obvious choice is the wrong one:

| Token | `/stargazers` |
|---|---|
| None | `401 Requires authentication` |
| Any fine-grained PAT without `contents=write` | `403 Resource not accessible by personal access token` |
| Classic PAT, **no scopes ticked** | works |

Fine-grained tokens are the wrong tool here. The 403 response carries
`x-accepted-github-permissions: metadata=read; contents=write`, to read a *public* list of
stargazers, a fine-grained token must hold **write access to your repository contents**.
That is a poor trade for a read-only notifier.

A classic token with `public_repo` is the practical minimum. A classic token with *no*
scopes authenticates fine and lifts the rate limit, but still gets `404` on stargazers,
because GitHub hides the resource rather than returning `403`. Create one at
[github.com/settings/tokens](https://github.com/settings/tokens).

**Without `public_repo` the worker still names starrers**, falling back to
`/repos/{owner}/{repo}/events`, which is fully anonymous and carries `WatchEvent` and
`ForkEvent` with the actor attached. What you lose is unstars: GitHub emits no event when
someone unstars, so naming a departure requires diffing the stargazer list, which requires
the scope. Pick accordingly:

| Token | Starrers named | Unstarrers named |
|---|---|---|
| None | yes (events feed) | no |
| Classic, no scopes | yes (events feed) | no |
| Classic, `public_repo` | yes (list diff) | **yes** |

The events feed retains roughly 300 events for ~90 days, which an hourly cron comfortably
outruns on a personal account, but it is a fallback, not the primary path.

```bash
npx wrangler secret put GITHUB_TOKEN
```

Check it took, on a repo you own that has at least one star:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  https://api.github.com/repos/<owner>/<repo>/stargazers
```

**6. Deploy and seed.** The first run stores a baseline silently; without it every existing
follower and star would arrive at once:

```bash
npx wrangler deploy
curl "https://<worker>.<subdomain>.workers.dev/run?key=<TRIGGER_SECRET>"
```

Secrets are read fresh on every invocation, so rotating one never needs a redeploy.

## Cost

One tick per day: 2 GitHub requests, 1 KV read, 1 KV write, plus one lookup per repo whose
counts moved.

| Resource | Free limit | Used |
|---|---|---|
| Cron Triggers | 5 per account | 1 |
| Worker requests | 100,000/day | ~1/day |
| KV reads | 100,000/day | 1/day |
| KV writes | 1,000/day | 1/day |
| KV storage | 1 GB | ~4 KB |

## Limits

- Only **net change between ticks** is visible. A follow and unfollow inside one window
  cancel out. Any polling design has this gap.
- Repos with more than 2,000 stargazers or forks are tracked by count only; paging the
  whole list every time it moves is not worth the requests. Their events fall back to
  `repo −1` with no name.
- `/users/{user}/repos` covers repos you own. A token with `repo` scope would include
  private ones, but that is far more access than this needs.

## Operating it

`GET /run?key=<TRIGGER_SECRET>` triggers a run and returns the diff as JSON; anything else
returns 403 or 404. `npx wrangler tail` streams live logs. Cron failures report themselves
to Telegram rather than failing silently, though if the *bot token itself* is missing,
that report has no way out, so check `wrangler tail` when debugging a quiet Worker.

## Credit

A rewrite of the notification logic from
[andreausu/git-notifier](https://github.com/andreausu/git-notifier) (MIT, unmaintained
since 2019), which was multi-tenant SaaS: Sinatra, Redis, Sidekiq, Puma and nginx across
five Dockerfiles, with OAuth signup and HTML email digests. Single-user on Workers, that
collapses to one cron handler and one KV key.

Kept from the original: distinguishing an unfollow from a deleted account, since a 404 on
the user lookup means they're gone rather than that they left.

Fixed from the original: owned-repo matching used a substring test against `owner/name`,
which also fires on anyone else's repo whose *name* contains your username. This compares
the owner segment exactly.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bugs and ideas go in
[issues](https://github.com/erfnzdeh/gh-notifier-cf-worker/issues); a pull
request should come with a test. Security reports are private: see
[SECURITY.md](SECURITY.md).

## License

MIT, inheriting from git-notifier. See [LICENSE](LICENSE).
