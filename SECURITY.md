# Security

This Worker holds Telegram and GitHub tokens, and its webhook is on the
public internet. A missed auth check is not a docs bug.

## Reporting

Do not open a public issue for:

- a way to hit `/admin/*` without `TRIGGER_SECRET`
- a way to post a Telegram update without
  `X-Telegram-Bot-Api-Secret-Token`
- anything that would let one subscriber read or change another chat's
  watches
- a leaked token, `.dev.vars` file, or KV dump

Use a
[private vulnerability advisory](https://github.com/erfnzdeh/gh-notifier-cf-worker/security/advisories/new).
Say what you can reach and, if you have it, a minimal request. Do not
include a working token.

## In scope

- Webhook authentication
- Admin route authentication
- Cross-subscriber reads or writes in KV
- The admin mirror (`ADMIN_CHAT_ID`) collecting more than `/privacy`
  discloses, or disclosing it when the variable is unset
- Secrets landing in logs, error messages, or the public repo

## Out of scope

- Anyone can `/watch` any public GitHub account. That is intentional; see
  [docs/BOT.md](docs/BOT.md).
- Stars, forks, follows and unfollows are already public on github.com.
- A follow and unfollow inside one polling window cancelling out. That is
  a polling limit, not a leak.

## Operator notes

`.dev.vars` is gitignored. Rotate `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_WEBHOOK_SECRET`, `TRIGGER_SECRET` and `GITHUB_TOKEN` with
`npx wrangler secret put` if any of them have been in a ticket, a chat or
a screenshot. Secrets are read on every invocation, so a rotation does not
need a redeploy.
