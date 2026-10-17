/**
 * How long, in words, the way a person would say it: "5 minutes",
 * "3 hours", "2 days". Shared by everything that tells your kinwriter (or
 * Jev) when something happened.
 */

/** "3 minutes", "5 hours", "2 days" (at least a minute; hours up to two days). */
export function humanDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** How long ago, roughly: "just now", "5 minutes ago", "2 days ago". */
export function ago(iso: string, now = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  return ms < 30_000 ? "just now" : `${humanDuration(ms)} ago`;
}
