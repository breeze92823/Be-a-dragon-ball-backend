// Players per room (the deploy sends it as `roomSize`): the safe zone has one base per player, so this is
// also the number of bases (client SAFE_ZONE.bases.plots). Keep in step with the client's src/config.js by hand.
export const ROOM_MAX_CLIENTS = 5;
export const BASE_COUNT = ROOM_MAX_CLIENTS;
// Slots of a base the others see (the client's BASE.slots).
export const PRESENCE_SLOTS_MAX = 10;

// Longest accepted strings.
export const NAME_MAX = 64;
// Profile picture URL (Bloxity `pfp`), relayed so other players can draw it.
export const PFP_MAX_LEN = 512;
// Presence (presence.ts): the Bloxity avatar JSON relayed for the others to draw, the most pets
// drawn per player, and the pose bounds (|x|, |y| and z up to `xy` m; z down to -`z` m: a race's
// track runs far down -Z; speed in m/s).
export const AVATAR_MAX_LEN = 3000;
export const PRESENCE_PETS_MAX = 8;
export const POSE_BOUNDS = { xy: 5000, z: 1e8, speed: 2000 };

// Colyseus drops the whole connection for a WebSocket message above this (default 4 KB).
export const MAX_PAYLOAD_BYTES = 128 * 1024;

// How long a dropped connection (WiFi blip, backgrounded tab) may reconnect with the same session.
export const RECONNECT_SECONDS = 20;

// Upper bounds for saved values, so a forged payload cannot store a bogus number. Generous
// ceilings, not game rules: the dearest engine costs ~3.6e28 Wins (client ENGINE gems).
export const CURRENCY_MAX = 1e33; // trophies (Wins), gems, lightning (energy)
export const REBIRTHS_MAX = 1e9;
export const DISTANCE_MAX = 1e15; // personal best race distance, studs
export const PLAY_SECONDS_MAX = 31_536_000; // ~1 year

// Owned catalog ids (client BOATS.list ~20, ENGINE ~34, PARTNER ~20, TRAILS ~29), with slack.
export const OWNED_MAX = 256;
// Pets (client PETS): at most PETS_MAX owned, PET_TIERS_MAX craft tiers, slots / storage the
// counters can grow to.
export const PETS_MAX = 1000;
export const PET_TIERS_MAX = 16;
export const PET_SLOTS_MAX = 50;
// Online Gifts (client GIFTS.list, 12 of them): claimed indexes and potion counts.
export const GIFTS_MAX = 64;
export const POTION_KINDS_MAX = 32;
export const POTION_COUNT_MAX = 1e9;
// Be a Dragon Ball (client state.js): fighters in the hotbar (keys 1-9, 0), in the Backpack, and
// base slots a save may hold; the longest fighter name; the highest Speed stat and income.
export const HOTBAR_MAX = 10;
export const BACKPACK_MAX = 300;
export const BASE_SLOTS_MAX = 80;
export const FIGHTER_NAME_MAX = 24;
export const FIGHTER_ID_MAX = 1e12;
export const SLOT_LEVEL_MAX = 1000;
// Daily Reward (client DAILY.days): days in one calendar cycle.
export const DAILY_DAYS = 7;

// Spin wheel (client SPIN in config.js; spin.ts): one free spin every SPIN_EVERY_MS, stored up
// to SPIN_CAP; a new player starts with SPIN_START. SPINS_MAX bounds a saved count.
export const SPIN_EVERY_MS = 15 * 60 * 1000;
export const SPIN_CAP = 5;
export const SPIN_START = 1;
export const SPINS_MAX = 1e6;
// The wedges' prizes and odds (weights in %), in wheel order. Ids match the client's SPIN.wedges;
// the client decides what each prize is, the server only which one is won.
export const SPIN_WEDGES = [
  { id: "cash", weight: 30 },
  { id: "luck", weight: 10 },
  { id: "epicFighter", weight: 5 },
  { id: "speed", weight: 20 },
  { id: "rareFighter", weight: 15 },
  { id: "money", weight: 20 },
] as const;
// Spin packs the client sells for $ (never premium currency): `buySpins` { pack } adds this many.
export const SPIN_PACKS = [3, 6] as const;

// Leaderboards (leaderboard.ts; client safe zone boards): the saved doc fields ranked (Top Money,
// Top Speed, Top Rebirth, Top Playtime), rows per board and how often the lists are re-read and re-sent.
export const LEADERBOARD_STATS = ["money", "speed", "rebirths", "playtime"] as const;
export type LeaderboardStat = (typeof LEADERBOARD_STATS)[number];
export const LEADERBOARD_SIZE = 10;
export const LEADERBOARD_EVERY_MS = 60 * 1000;

// Ids from the client's catalogs (boats, engines incl. `ladder-N`, partners, trails, pet kinds,
// potions): camelCase slugs, so nothing odd is stored.
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// The client's per-browser fallback id for players who are not signed in to Bloxity.
// Guests are never persisted.
export const GUEST_ID_PREFIX = "guest-";

// --- Be a Dragon Ball windows (client src/ui/, fields in src/state.js) -------------------------
// Index discoveries "mutation.fighter" (client roster.js indexKey, e.g. "default.kairo",
// "golden.kairo"), at most INDEX_MAX (the client has 162 fighters x 11 tabs).
export const INDEX_MAX = 4096;
export const INDEX_KEY = /^[a-z0-9]{1,24}\.[a-z0-9]{1,24}$/;
// Timed boosts (x2 Speed, x2 Luck) end at most this far ahead of now.
export const BOOST_MAX_MS = 24 * 60 * 60 * 1000;
// Offline earnings: the seconds away the server credits to the base pads, at most this (client BASE.offlineMaxHours).
export const OFFLINE_MAX_SECONDS = 12 * 60 * 60;
// Base Upgrade steps on your base's entrance sign (client BASE_BOARD.upgrade.prices.length).
export const BASE_UPGRADE_STEPS = 5;

// Playtime Rewards (playtime.ts; client PLAYTIME.rewards, same length): seconds online today
// (server clock, UTC day) at which each reward unlocks.
export const PLAYTIME_UNLOCKS = [30, 90, 180, 300, 600, 1200, 1800, 2400, 3000];

// Daily Quests (quests.ts; client QUESTS.kinds): QUEST_SLOTS quests a UTC day, each a kind and a
// goal from its list. `play` (minutes online) is counted by the server itself every
// QUEST_TICK_MS; the others come from the client's `questEvent` (at most QUEST_EVENT_MAX a message).
export const QUEST_SLOTS = 3;
export const QUEST_KINDS = [
  { kind: "hatch", goals: [5, 8, 12] },
  { kind: "mutated", goals: [1, 2, 3] },
  { kind: "sell", goals: [3, 6, 10] },
  { kind: "play", goals: [10, 15, 20] },
] as const;
export type QuestKind = (typeof QUEST_KINDS)[number]["kind"];
export const QUEST_EVENT_MAX = 50;
export const QUEST_TICK_MS = 60 * 1000;

// Fuse Machine (fuse.ts; client FUSE in config.js): FUSE_INPUTS fighters go in, one comes out
// after a timer. The outcome tier is the inputs' average rarity (FUSE_RARITIES index, rounded)
// plus a step rolled from FUSE_STEPS (weights in %), capped at the top rarity. The result has a
// mutation with FUSE_MUTATION_CHANCE (rolled from FUSE_MUTATIONS by weight; inputs that all share
// one mutation pass it on instead). The timer is FUSE_SECONDS[0] + FUSE_SECONDS[1] x the tier.
export const FUSE_INPUTS = 4;
// Worst to best = the client's lane zone order (config.js RARITY_ORDER), so a step up is always
// worth more.
export const FUSE_RARITIES = [
  "Common", "Uncommon", "Rare", "Epic", "Legendary", "Mythical", "Secret", "Eternal", "Divine", "Heavenly", "Celestial", "Primal",
] as const;
export const FUSE_STEPS = [
  { step: 0, weight: 60 },
  { step: 1, weight: 32 },
  { step: 2, weight: 8 },
] as const;
export const FUSE_MUTATION_CHANCE = 0.25;
export const FUSE_MUTATIONS = [
  { id: "golden", name: "Golden", weight: 30 },
  { id: "ice", name: "Ice", weight: 22 },
  { id: "shadow", name: "Shadow", weight: 15 },
  { id: "jade", name: "Jade", weight: 12 },
  { id: "candy", name: "Candy", weight: 9 },
  { id: "lava", name: "Lava", weight: 6 },
  { id: "crimson", name: "Crimson", weight: 3 },
  { id: "lightning", name: "Lightning", weight: 1.8 },
  { id: "destruction", name: "Destruction", weight: 0.9 },
  { id: "mastered", name: "Mastered Aura", weight: 0.3 },
] as const;
export const FUSE_SECONDS = [20, 20] as const;
// Roster pick for the result: an index the client maps onto that rarity's fighters (mod length).
export const FUSE_PICK_MAX = 10_000;
