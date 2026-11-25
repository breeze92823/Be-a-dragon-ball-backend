import { QUEST_EVENT_MAX, QUEST_KINDS, QUEST_SLOTS, type QuestKind } from "./constants.js";
import type { PlayerDoc } from "./db.js";
import { utcDay } from "./daily.js";

// Daily Quests (client src/ui/quests.js): QUEST_SLOTS quests per UTC day (server clock), each with
// one free reroll while unfinished. Finishing all of them unlocks the day's reward fighter (the
// client picks it from the day index); the client may also skip the quests by paying $ (its own,
// client-authoritative money), which only marks the reward claimed here. Progress for `play` is
// counted by the server, the rest arrives as `questEvent` { kind, n }. Doc field `quests`, written
// by the server only.
export interface Quest {
  kind: QuestKind;
  goal: number;
  n: number;
  rerolled: boolean;
}
export interface QuestState {
  day: number; // UTC day the list belongs to (-1 = none yet)
  list: Quest[];
  claimed: boolean; // today's reward taken (completed or skipped)
}

const DAY_MS = 86_400_000;
const KINDS = QUEST_KINDS.map((k) => k.kind) as QuestKind[];
const goalsOf = (kind: QuestKind) => QUEST_KINDS.find((k) => k.kind === kind)!.goals as readonly number[];
const pick = <T>(a: readonly T[], rand: () => number) => a[Math.floor(rand() * a.length) % a.length];

export function readQuests(doc: Partial<PlayerDoc> | null): QuestState {
  const q = doc?.quests;
  if (!q || typeof q !== "object" || !Number.isInteger(q.day) || !Array.isArray(q.list)) return { day: -1, list: [], claimed: false };
  const list: Quest[] = [];
  for (const raw of q.list) {
    if (list.length >= QUEST_SLOTS || !raw || !KINDS.includes(raw.kind) || !goalsOf(raw.kind).includes(raw.goal)) continue;
    const n = typeof raw.n === "number" && Number.isFinite(raw.n) ? Math.min(raw.goal, Math.max(0, Math.floor(raw.n))) : 0;
    list.push({ kind: raw.kind, goal: raw.goal, n, rerolled: raw.rerolled === true });
  }
  if (list.length !== QUEST_SLOTS) return { day: -1, list: [], claimed: false };
  return { day: q.day, list, claimed: q.claimed === true };
}

// A fresh list for a new UTC day. Returns true when the state changed (save it).
export function rollQuests(s: QuestState, today = utcDay(), rand = Math.random): boolean {
  if (s.day >= today && s.list.length === QUEST_SLOTS) return false;
  const kinds = [...KINDS];
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1)) % (i + 1);
    [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
  }
  s.day = today;
  s.list = kinds.slice(0, QUEST_SLOTS).map((kind) => ({ kind, goal: pick(goalsOf(kind), rand), n: 0, rerolled: false }));
  s.claimed = false;
  return true;
}

// Swaps an unfinished quest for one of a kind not in the list (or another goal of the same kind).
export function rerollQuest(s: QuestState, i: unknown, rand = Math.random): boolean {
  if (!Number.isInteger(i) || (i as number) < 0 || (i as number) >= s.list.length) return false;
  const q = s.list[i as number];
  if (q.rerolled || q.n >= q.goal || s.claimed) return false;
  const free = KINDS.filter((k) => !s.list.some((o) => o.kind === k));
  const kind = free.length ? pick(free, rand) : q.kind;
  const goals = goalsOf(kind).filter((g) => kind !== q.kind || g !== q.goal);
  s.list[i as number] = { kind, goal: pick(goals.length ? goals : goalsOf(kind), rand), n: 0, rerolled: true };
  return true;
}

// Adds progress to every quest of `kind`. Returns true when something moved.
export function addQuestProgress(s: QuestState, kind: unknown, n: unknown): boolean {
  if (!KINDS.includes(kind as QuestKind) || typeof n !== "number" || !Number.isFinite(n) || n < 1) return false;
  const step = Math.min(QUEST_EVENT_MAX, Math.floor(n));
  let moved = false;
  for (const q of s.list) {
    if (q.kind !== kind || q.n >= q.goal) continue;
    q.n = Math.min(q.goal, q.n + step);
    moved = true;
  }
  return moved;
}

export const questsDone = (s: QuestState) => s.list.length === QUEST_SLOTS && s.list.every((q) => q.n >= q.goal);

// Takes today's reward: needs every quest finished unless the client paid to skip.
export function claimQuests(s: QuestState, skip: unknown): boolean {
  if (s.claimed || s.list.length !== QUEST_SLOTS) return false;
  if (skip !== true && !questsDone(s)) return false;
  s.claimed = true;
  return true;
}

export function questView(s: QuestState, now = Date.now()) {
  return { day: s.day, list: s.list.map((q) => ({ ...q })), claimed: s.claimed, nextAt: (utcDay(now) + 1) * DAY_MS, serverTime: now };
}

export const questFields = (s: QuestState) => ({ quests: { day: s.day, list: s.list.map((q) => ({ ...q })), claimed: s.claimed } });
