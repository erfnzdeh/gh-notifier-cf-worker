/** Telegram HTML rendering for notification messages. */

export const esc = (s) =>
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

/**
 * One message per watched account. The account is named in the header rather
 * than folded into every line, because a subscriber watching several accounts
 * needs to know which one this is about — and because a tick where only one of
 * their accounts moved should not mention the others.
 */
export function formatMessage(login, events, followerCount) {
  const parts = [`<b>${esc(login)}</b>`];

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
