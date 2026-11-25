import { matchMaker } from "colyseus";

import { BADGES, BOARDS, STATS } from "./boxity-catalog.js";
import { getPlayers, type PlayerDoc } from "./db.js";

// Everything the server says to Boxity (docs.bloxity.io): identity checks, the live-room list,
// profile stats, leaderboards and badges. Every URL comes from the environment Boxity hosting
// injects (BLOXITY_API_URL, ...), never a hostname; with BLOXITY_REPORT_TOKEN / BLOXITY_GAME_ID
// unset (local dev, tests) every reporter is a no-op and nothing here ever throws into a room.

const env = process.env;
export const apiUrl = () => (env.BLOXITY_API_URL || "https://api.bloxity.io").replace(/\/$/, "");
const reportToken = () => env.BLOXITY_REPORT_TOKEN || "";
const gameId = () => env.BLOXITY_GAME_ID || "";
// The slug the game is registered under on bloxity.io (the client's GAME_SLUG).
export const gameSlug = () => env.BLOXITY_GAME_SLUG || env.BLOXITY_GAME_ID || "be-a-dragon-ball";
export const reporting = () => !!(reportToken() && gameId());

// Dev / tests only: accept the userId in the join options as the account id. On by default for a
// local server (not NODE_ENV=production, no Boxity report token); a deployed server never trusts a
// client id and identifies players only by a Boxity token verified with the platform.
export const trustClientIds = () => env.TRUST_CLIENT_IDS === "true" || (env.TRUST_CLIENT_IDS !== "false" && env.NODE_ENV !== "production" && !reportToken());

async function post(url: string, body: unknown, headers: Record<string, string> = {}, ms = 8000): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    // No JSON body.
  }
  return { status: res.status, json };
}
const auth = () => ({ authorization: `Bearer ${reportToken()}` });

// --- Identity -----------------------------------------------------------------------------------
export interface VerifiedUser {
  id: string; // the Boxity user id (_id)
  username: string;
  handle: string; // the permanent Boxity username (username above is the display name)
  pfp: string;
  carriedFrom: string[]; // Boxity guest ids this browser played as before signing in
  outfitKey: string; // the platform-verified outfit key (what the player wears), "" when absent
}

// POST /v1/auth/game-token/verify with the player's Boxity token. null = no / refused token: the
// caller treats the connection as a guest (nothing loaded or saved), never as a client-made id.
export async function verifyGameToken(token: unknown): Promise<VerifiedUser | null> {
  if (typeof token !== "string" || !token || token.length > 4096) return null;
  try {
    const { status, json } = await post(`${apiUrl()}/v1/auth/game-token/verify`, { gameSlug: gameSlug() }, { authorization: `Bearer ${token}` }, 6000);
    if (status !== 200 || !json?.valid || !json.user?._id) return null;
    const u = json.user;
    return {
      id: String(u._id).slice(0, 128),
      username: String(u.displayName || u.username || "Player"),
      handle: String(u.username || "").slice(0, 64),
      pfp: typeof u.pfp === "string" ? u.pfp : "",
      outfitKey: typeof u.outfitKey === "string" && /^[A-Za-z0-9_.-]{1,2900}$/.test(u.outfitKey) ? u.outfitKey : "",
      carriedFrom: Array.isArray(json.carriedFrom) ? json.carriedFrom.filter((s: unknown) => typeof s === "string").slice(0, 5) : [],
    };
  } catch (err) {
    console.warn("[boxity] token verify failed", (err as Error)?.message ?? err);
    return null;
  }
}

// --- Room directory ("Open Rooms" on the game page) -------------------------------------------------
export function installRoomReporter(): void {
  const base = env.MATCHMAKER_REPORT_URL;
  const missing = [!base && "MATCHMAKER_REPORT_URL", !reportToken() && "BLOXITY_REPORT_TOKEN", !gameId() && "BLOXITY_GAME_ID"].filter(Boolean);
  if (missing.length) {
    // Without these Boxity cannot list this server's rooms ("Open Rooms" stays empty): say so in the logs.
    console.log(`[boxity] room reporter off (not set: ${missing.join(", ")}). Fine locally; on Boxity hosting the "Open Rooms" list stays empty without them.`);
    return;
  }
  const url = `${base!.replace(/\/$/, "")}/${gameId()}/rooms`;
  const podName = env.POD_NAME || env.HOSTNAME || "";
  console.log(`[boxity] room reporter on: ${url} (pod "${podName}")`);
  let last = ""; // the last outcome logged, so a steady state is silent but every change is visible
  const note = (what: string) => {
    if (what === last) return;
    last = what;
    console.log(`[boxity] room reporter: ${what}`);
  };
  const tick = async () => {
    try {
      const listings = await matchMaker.query({});
      const rooms = listings.map((l) => ({
        colyseusRoomId: l.roomId,
        name: l.name || undefined,
        clients: l.clients ?? 0,
        maxClients: l.maxClients ?? 0,
        locked: !!l.locked,
        private: !!l.private,
        started: !!(l.metadata as any)?.started,
        metadata: l.metadata || undefined,
      }));
      const players = rooms.reduce((n, r) => n + (r.clients || 0), 0);
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...auth() }, body: JSON.stringify({ podName, players, rooms }), signal: AbortSignal.timeout(4000) });
      note(res.ok ? `reporting ${rooms.length} room(s), ${players} player(s)` : `refused with HTTP ${res.status} ${res.status === 401 || res.status === 403 ? "(check BLOXITY_REPORT_TOKEN / BLOXITY_GAME_ID)" : ""}`);
    } catch (err) {
      note(`failed: ${(err as Error)?.message ?? err}`); // the directory tolerates gaps; keep going
    }
  };
  setInterval(() => void tick(), 2000).unref();
  void tick();
}

// --- Online players -> stats, boards, badges ------------------------------------------------------
// Rooms register the account ids they hold; the reporter reads those players' saved docs (never a
// client message) every REPORT_EVERY_MS and once more on shutdown.
const online = new Set<string>();
export function markOnline(id: string): void {
  if (id) online.add(id);
}
export function markOffline(id: string): void {
  online.delete(id);
}

const legion = (id: string) => `legion_${id}`;
const REPORT_EVERY_MS = 60_000;
const BATCH = 200;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

// The stat values of one saved doc: only finite, non-negative numbers under the type's ceiling
// (Boxity rejects a value above it and would keep it as the permanent maximum otherwise).
export function statValues(doc: Partial<PlayerDoc>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of STATS) {
    const v = num(s.read(doc));
    if (v !== null && v <= s.ceiling) out[s.key] = Math.floor(v);
  }
  return out;
}

// Boards take the current value (a 'best' board keeps the player's top); anything not finite is skipped.
export function boardScores(doc: Partial<PlayerDoc>): { board: string; score: number }[] {
  const out: { board: string; score: number }[] = [];
  for (const b of BOARDS) {
    const v = num(b.read(doc));
    if (v !== null && v > 0) out.push({ board: b.id, score: Math.floor(v) });
  }
  return out;
}

// The badge keys a doc has earned so far.
export function badgeKeys(doc: Partial<PlayerDoc>): string[] {
  return BADGES.filter((b) => {
    try {
      return b.earned(doc);
    } catch {
      return false;
    }
  }).map((b) => b.key);
}

const ownedBadges = new Map<string, Set<string>>(); // user id -> badge keys Boxity already has
let declared = false;

async function declareBadges() {
  const { status, json } = await post(`${apiUrl()}/v1/game-badges/hosted/${gameId()}/declare`, {
    gameSlug: gameSlug(),
    badges: BADGES.map(({ key, name, description, icon, rarity }) => ({ key, name, description, icon, rarity })),
  }, auth());
  console.log("[boxity] badges declared", status, JSON.stringify(json));
}

async function reportOnce() {
  const players = getPlayers();
  if (!players || !reporting() || online.size === 0) return;
  const ids = [...online];
  const docs = await players.find({ _id: { $in: ids } } as any).toArray();
  const stats: { userId: string; values: Record<string, number> }[] = [];
  const scores: { board: string; userId: string; score: number }[] = [];
  const awards: { userId: string; key: string }[] = [];
  for (const doc of docs) {
    const userId = legion(doc._id);
    const values = statValues(doc);
    if (Object.keys(values).length) stats.push({ userId, values });
    for (const s of boardScores(doc)) scores.push({ ...s, userId });
    const have = ownedBadges.get(doc._id) ?? new Set<string>();
    for (const key of badgeKeys(doc)) if (!have.has(key)) awards.push({ userId, key });
  }
  for (let i = 0; i < stats.length; i += BATCH) {
    const r = await post(`${apiUrl()}/v1/games/${gameId()}/stats`, {
      definitions: STATS.map((s, n) => ({ key: s.key, label: s.label, type: s.type, sortOrder: n })),
      players: stats.slice(i, i + BATCH),
    }, auth());
    console.log("[boxity] stats", r.status, JSON.stringify(r.json));
  }
  for (let i = 0; i < scores.length; i += BATCH) {
    const r = await post(`${apiUrl()}/v1/leaderboards/hosted/${gameId()}/report`, {
      boards: BOARDS.map(({ id, label, mode, format, reset }) => ({ id, label, mode, format, reset })),
      scores: scores.slice(i, i + BATCH),
    }, auth());
    console.log("[boxity] leaderboards", r.status, JSON.stringify(r.json));
  }
  for (let i = 0; i < awards.length; i += BATCH) {
    const batch = awards.slice(i, i + BATCH);
    const r = await post(`${apiUrl()}/v1/game-badges/hosted/${gameId()}/award`, { awards: batch }, auth());
    console.log("[boxity] badges awarded", r.status, JSON.stringify(r.json));
    if (r.status === 200) for (const a of batch) ownedBadges.get(a.userId.slice(7))?.add(a.key);
  }
}

// Who already has which badge, asked once per account (when its save has loaded).
export async function loadOwnedBadges(id: string): Promise<void> {
  if (!reporting() || ownedBadges.has(id)) return;
  ownedBadges.set(id, new Set());
  try {
    const r = await post(`${apiUrl()}/v1/game-badges/hosted/${gameId()}/owned`, { userIds: [legion(id)] }, auth());
    for (const k of r.json?.owned?.[id] ?? r.json?.owned?.[legion(id)] ?? []) ownedBadges.get(id)?.add(k);
  } catch (err) {
    console.warn("[boxity] badge owned read failed", (err as Error)?.message ?? err);
  }
}
export function forgetBadges(id: string): void {
  ownedBadges.delete(id);
}

export function installReporters(): void {
  if (!reporting()) return;
  const run = async () => {
    try {
      if (!declared) {
        declared = true;
        await declareBadges();
      }
      await reportOnce();
    } catch (err) {
      console.warn("[boxity] report failed", (err as Error)?.message ?? err);
    }
  };
  setInterval(() => void run(), REPORT_EVERY_MS).unref();
  void run();
  // One last report on shutdown. This only flushes: it never exits, so Colyseus's own graceful shutdown
  // (installed by listen()) still drains the rooms.
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => void run());
}

// --- Rewarded ads -----------------------------------------------------------------------------------
// A rewarded-ad token (client Legion.SDK.ads.showRewarded) checked by Boxity: true only for a fresh
// token issued for THIS game. Refused outside a Boxity deployment unless client ids are trusted (dev).
export async function verifyAdToken(token: unknown): Promise<boolean> {
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  try {
    const { json } = await post(`${apiUrl()}/v1/ads/reward/verify`, { gameSlug: gameSlug(), rewardToken: token }, {}, 6000);
    return !!json?.valid;
  } catch {
    return false;
  }
}
