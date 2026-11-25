import { MongoClient, type Collection } from "mongodb";

import { LEADERBOARD_STATS } from "./constants.js";

// Bloxity Legion hosting injects MONGODB_URI per game+channel -- an isolated database with
// scoped credentials. A local `npm start` normally has no Mongo reachable, so a missing or
// unreachable URI must degrade to "no persistence" rather than crash the room.

// The persisted client state (what `saveProgress` carries, see sanitize.ts). The client keeps
// nothing in the browser: this document is the player's only save.
export interface PlayerDoc {
  _id: string; // Bloxity user id -- see WorldRoom.ts (guests are never saved)
  username?: string; // display name as of the last save
  trophies?: number; // Wins (the HUD's trophy counter, the shop currency)
  gems?: number;
  energy?: number; // lightning (rebirth.js), the race speed
  rebirths?: number;
  autoRebirth?: boolean;
  bestDistance?: number; // personal best race, studs (only ever goes up)
  playtime?: number; // s with the game visible
  boats?: string[]; // owned boat ids (client BOATS.list)
  boat?: string; // the equipped boat (an owned one)
  engines?: string[]; // owned engine ids (client engine.js ENGINES)
  engine?: string; // the equipped engine, "" = none
  partners?: string[]; // owned partner ids (client PARTNER.partners)
  partner?: string; // the equipped partner, "" = none
  trails?: string[]; // owned trail ids (client TRAILS.list)
  trail?: string; // the equipped trail, "" = none
  pets?: SavedPet[]; // owned pets (client pets.js), at most PETS_MAX
  petSlots?: number; // pets equipped at once
  petStorage?: number; // pets owned at most
  eggsSeen?: string[]; // pet kinds ever hatched (client eggs.js: the NEW! tag)
  world?: string; // the world the player was in (client worlds.js WORLDS), "" = the start world
  worldsUnlocked?: string[]; // worlds whose portal requirement was met once (they stay open)
  giftTime?: number; // Online Gifts clock, s online this round
  giftsClaimed?: number[]; // GIFTS.list indexes claimed this round
  potions?: Record<string, number>; // potion id -> count (gifts.js)
  lastSeen?: number; // epoch ms of the last activity
  // Be a Dragon Ball (client src/state.js snapshot()):
  money?: number; // $ (the HUD's cash counter)
  speed?: number; // Speed stat (treadmills raise it; the lane orb's pace)
  inventory?: SavedFighter[]; // the hotbar, keys 1-9 then 0 (at most HOTBAR_MAX)
  backpack?: SavedFighter[]; // fighters in the Backpack (at most BACKPACK_MAX)
  slots?: SavedSlot[]; // your base's slots, in order
  nextId?: number; // next fighter id the client hands out
  // Spin wheel (spin.ts): written only by the server's `spin` handler, never by saveProgress.
  spins?: number; // spins ready to use
  spinAt?: number; // epoch ms the next free spin arrives
  // Daily Reward (daily.ts): written by the server only, never by saveProgress.
  dailyDay?: number; // days unlocked this cycle
  dailyLast?: number; // UTC day index of the last unlock
  dailyClaimed?: number[]; // claimed day indexes this cycle
  // --- Be a Dragon Ball windows (client src/ui/, fields in src/state.js) ---
  discovered?: string[]; // Index entries ever owned, "mutation.name" (INDEX_KEY)
  indexClaimed?: string[]; // mutation ids whose Index collection reward (a base skin) is unlocked
  speedBoostUntil?: number; // epoch ms the x2 Speed boost ends (0 = none)
  luckBoostUntil?: number; // epoch ms the x2 Luck boost ends
  settings?: SavedSettings; // the Settings window's toggles
  // Playtime Rewards (playtime.ts) and Daily Quests (quests.ts): written by the server only.
  ptDay?: number; // UTC day of the playtime clock
  ptSecs?: number; // seconds online that day
  ptClaimed?: number[]; // claimed reward indexes that day
  quests?: { day: number; list: { kind: any; goal: number; n: number; rerolled: boolean }[]; claimed: boolean };
  version: number;
  updatedAt: Date;
}

// One owned pet: its kind (client PETS.kinds key) and craft tier (index into PETS.tiers).
export interface SavedPet {
  kind: string;
  tier: number;
  equipped: boolean;
  locked: boolean;
}

// A fighter (client lane/index.js rollFighter): look = the figurine's colours and poses.
export interface SavedFighter {
  id: number;
  name: string;
  rarity: string;
  mutation: string | null;
  income: number; // $ per second
  look: SavedLook;
}
export interface SavedLook {
  gi: string;
  pants: string;
  hair: string;
  skin: string;
  belt: string;
  boots: string;
  style: number;
  stance: number;
  cape: boolean;
}
// A base slot: the placed fighter (or null), its upgrade level and the cash waiting on its pad.
export interface SavedSlot {
  fighter: SavedFighter | null;
  level: number;
  stored: number;
}

// Settings window toggles (client src/ui/settings.js).
export interface SavedSettings {
  lowGfx: boolean;
  noVfx: boolean;
  muteMusic: boolean;
  names: boolean;
}

let client: MongoClient | null = null;
let players: Collection<PlayerDoc> | null = null;

export async function connectDb(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[db] MONGODB_URI not set -- player progress will not persist");
    return;
  }
  try {
    client = new MongoClient(uri);
    await client.connect();
    // No dbName passed to .db() -- the injected URI already points at this game+channel's database.
    players = client.db().collection<PlayerDoc>("players");
    console.log("[db] connected to MongoDB");
    // The leaderboards sort and count by these (leaderboard.ts).
    for (const stat of LEADERBOARD_STATS) {
      players.createIndex({ [stat]: -1 }).catch((err) => console.warn(`[db] index on ${stat} failed`, err));
    }
  } catch (err) {
    console.warn("[db] connect failed -- player progress will not persist:", err);
    client = null;
    players = null;
  }
}

// Null whenever Mongo is unset/unreachable -- every caller must treat that as "skip persistence".
export function getPlayers(): Collection<PlayerDoc> | null {
  return players;
}

// Test-only seam: exercise the save/load logic against an in-memory fake collection.
export function __setPlayersForTest(fake: Collection<PlayerDoc> | null): void {
  players = fake;
}
