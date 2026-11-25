import { PLAYTIME_UNLOCKS } from "./constants.js";
import type { PlayerDoc } from "./db.js";
import { utcDay } from "./daily.js";

// Playtime Rewards (client src/ui/playtime.js): nine rewards that unlock after PLAYTIME_UNLOCKS
// seconds online on the same UTC day, timed on the SERVER's clock (the connection's lifetime), so
// neither a changed device clock nor a forged save can unlock one early. A new UTC day starts the
// clock and the claims over. Doc fields `ptDay` / `ptSecs` / `ptClaimed`, written by the server
// only (never by saveProgress). Claims go through `claimPlaytime`; the client grants the reward
// only on ok.
export interface PlaytimeState {
  day: number; // UTC day the clock belongs to
  secs: number; // seconds banked today before `since`
  claimed: number[]; // claimed reward indexes today
  since: number; // epoch ms the running stretch started (this connection, or midnight)
}

const DAY_MS = 86_400_000;

export function readPlaytime(doc: Partial<PlayerDoc> | null, now = Date.now()): PlaytimeState {
  const today = utcDay(now);
  const sameDay = doc?.ptDay === today;
  const secs = sameDay && typeof doc?.ptSecs === "number" && Number.isFinite(doc.ptSecs) ? Math.min(DAY_MS / 1000, Math.max(0, doc.ptSecs)) : 0;
  const raw = sameDay && Array.isArray(doc?.ptClaimed) ? doc!.ptClaimed! : [];
  const claimed = [...new Set(raw.filter((i) => Number.isInteger(i) && i >= 0 && i < PLAYTIME_UNLOCKS.length))].sort((a, b) => a - b);
  return { day: today, secs, claimed, since: now };
}

// Midnight passed while online: today's clock starts at midnight with nothing claimed.
export function rollPlaytime(s: PlaytimeState, now = Date.now()): boolean {
  const today = utcDay(now);
  if (today <= s.day) return false;
  s.day = today;
  s.secs = 0;
  s.claimed = [];
  s.since = Math.max(s.since, today * DAY_MS);
  return true;
}

export const playtimeSecs = (s: PlaytimeState, now = Date.now()) => s.secs + Math.max(0, now - s.since) / 1000;

// Moves the running stretch into `secs` (before a save).
export function bankPlaytime(s: PlaytimeState, now = Date.now()): void {
  s.secs = playtimeSecs(s, now);
  s.since = now;
}

export function claimPlaytime(s: PlaytimeState, i: unknown, now = Date.now()): boolean {
  if (!Number.isInteger(i) || (i as number) < 0 || (i as number) >= PLAYTIME_UNLOCKS.length || s.claimed.includes(i as number)) return false;
  if (playtimeSecs(s, now) < PLAYTIME_UNLOCKS[i as number]) return false;
  s.claimed.push(i as number);
  s.claimed.sort((a, b) => a - b);
  return true;
}

export function playtimeView(s: PlaytimeState, now = Date.now()) {
  return { secs: Math.floor(playtimeSecs(s, now)), claimed: [...s.claimed], unlocks: PLAYTIME_UNLOCKS, nextAt: (utcDay(now) + 1) * DAY_MS, serverTime: now };
}

export function playtimeFields(s: PlaytimeState, now = Date.now()) {
  return { ptDay: s.day, ptSecs: Math.floor(playtimeSecs(s, now)), ptClaimed: [...s.claimed] };
}
