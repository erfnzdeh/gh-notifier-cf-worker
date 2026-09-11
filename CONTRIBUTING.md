# Contributing

Bugs, ideas and patches are welcome. This is a small Worker with a few
invariants that are easy to break and expensive to notice, so read those
before changing how a tick or a webhook behaves.

## Before you write code

Open an [issue](https://github.com/erfnzdeh/gh-notifier-cf-worker/issues) if
the change is more than a typo or an obvious bug. The free-plan ceilings
(50 subrequests per invocation, 1,000 KV writes a day, 5,000 GitHub requests
an hour) decide more of the design than taste does, and a proposal that
ignores them will not land.

Two properties to keep if you touch polling or delivery:

- **Delivery happens before the snapshot advances.** A failed send must cost
  a duplicate on the next tick, never a swallowed follower.
- **The snapshot is written only when it changed.** An unconditional write
  per account per tick spends the daily KV budget on silence.

Tests fake GitHub and Telegram on purpose. A test that hits the network is a
regression: the old single-tenant suite did that, and an anonymous rate
limit looked like a code bug.

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars
```

Fill in `.dev.vars`. It is gitignored; `.dev.vars.example` is the checked-in
list of names and why each one exists. Then:

```bash
npm test
npx wrangler dev
```

`wrangler dev` needs the secrets and a KV namespace binding. You do not need
a live deploy to run the tests.

## Pull requests

- One change per PR. A refactor mixed with a behaviour change is two PRs.
- Add or extend a test in `test/` for anything that is not docs.
- Match the surrounding prose. Comments here explain *why*; they are not
  restating the next line. Do not introduce em dashes.
- Do not commit `.dev.vars`, tokens, or a `wrangler.jsonc` pointed at
  someone else's KV namespace.

Use the pull request template. Say what you changed and why, not a walk
through the diff.

## Surfaces

| Path | What it is |
|---|---|
| `src/github.js` | Poll and diff. Shared with the original single-tenant worker. |
| `src/store.js` | KV shape: `sub:`, `watch:`, `state:`. |
| `src/bot.js` | Telegram commands. |
| `src/index.js` | Cron shards, webhook, admin routes. |
| `src/admin-forward.js` | Optional operator mirror. Must never fail a webhook. |
| `test/*.mjs` | Offline smoke tests. `npm test` runs both. |
| `docs/BOT.md` | How the public bot is deployed and what it stores. |

Contributions are under the same MIT license as the rest of the repo.
