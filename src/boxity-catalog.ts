import type { PlayerDoc, SavedFighter } from "./db.js";

// What this game tells Boxity about each player: profile stats ("Only in this game"), leaderboards
// and badges. Read only from the saved doc (server-owned storage), never from a client packet.
// Keys are permanent once declared. Ceilings are Boxity's per-type limits (a value above one is
// rejected, so it is left out instead of clamped).

type Doc = Partial<PlayerDoc>;
const CEIL = { number: 1e9, seconds: 31_536_000_000, currency: 1e12, percent: 100 } as const;

const fighters = (d: Doc): SavedFighter[] => [
  ...(d.inventory ?? []),
  ...(d.backpack ?? []),
  ...(d.slots ?? []).map((s) => s.fighter).filter((f): f is SavedFighter => !!f),
];
const RANK = ["Common", "Uncommon", "Rare", "Epic", "Legendary", "Mythical", "Secret", "Heavenly", "Eternal", "Celestial", "Divine", "Primal"];
const best = (d: Doc) => fighters(d).reduce((n, f) => Math.max(n, RANK.indexOf(f.rarity)), -1);

export const STATS = [
  { key: "cash", label: "Cash", type: "currency", ceiling: CEIL.currency, read: (d: Doc) => d.money },
  { key: "speed", label: "Speed", type: "number", ceiling: CEIL.number, read: (d: Doc) => d.speed },
  { key: "rebirths", label: "Rebirths", type: "number", ceiling: CEIL.number, read: (d: Doc) => d.rebirths },
  { key: "fighters", label: "Fighters Owned", type: "number", ceiling: CEIL.number, read: (d: Doc) => fighters(d).length },
  { key: "index", label: "Index Discovered", type: "number", ceiling: CEIL.number, read: (d: Doc) => d.discovered?.length },
] as const;

export const BOARDS = [
  { id: "cash", label: "Top Cash", mode: "best", format: "compact", reset: "none", read: (d: Doc) => d.money },
  { id: "speed", label: "Top Speed", mode: "best", format: "compact", reset: "none", read: (d: Doc) => d.speed },
  { id: "rebirths", label: "Top Rebirths", mode: "best", format: "number", reset: "none", read: (d: Doc) => d.rebirths },
  { id: "playtime", label: "Top Playtime", mode: "best", format: "time", reset: "none", read: (d: Doc) => (d.playtime ?? 0) * 1000 },
] as const;

export const BADGES = [
  { key: "first_fighter", name: "First Fighter", description: "Hatch your first fighter.", icon: "/badges/first_fighter.svg", rarity: "common", earned: (d: Doc) => fighters(d).length > 0 },
  { key: "fast_runner", name: "Fast Runner", description: "Reach 10,000 Speed.", icon: "/badges/fast_runner.svg", rarity: "common", earned: (d: Doc) => (d.speed ?? 0) >= 1e4 },
  { key: "veteran", name: "Veteran", description: "Play for one hour.", icon: "/badges/veteran.svg", rarity: "uncommon", earned: (d: Doc) => (d.playtime ?? 0) >= 3600 },
  { key: "reborn", name: "Reborn", description: "Rebirth for the first time.", icon: "/badges/reborn.svg", rarity: "uncommon", earned: (d: Doc) => (d.rebirths ?? 0) >= 1 },
  { key: "mutant", name: "Mutant", description: "Own a mutated fighter.", icon: "/badges/mutant.svg", rarity: "rare", earned: (d: Doc) => fighters(d).some((f) => !!f.mutation) },
  { key: "millionaire", name: "Millionaire", description: "Hold $1,000,000.", icon: "/badges/millionaire.svg", rarity: "rare", earned: (d: Doc) => (d.money ?? 0) >= 1e6 },
  { key: "collector", name: "Collector", description: "Discover 50 fighters in the Index.", icon: "/badges/collector.svg", rarity: "epic", earned: (d: Doc) => (d.discovered?.length ?? 0) >= 50 },
  { key: "mythic_hatch", name: "Mythic Hatch", description: "Own a Mythical fighter or better.", icon: "/badges/mythic_hatch.svg", rarity: "epic", earned: (d: Doc) => best(d) >= RANK.indexOf("Mythical") },
  { key: "primal_power", name: "Primal Power", description: "Own a Primal fighter.", icon: "/badges/primal_power.svg", rarity: "legendary", earned: (d: Doc) => best(d) >= RANK.indexOf("Primal") },
] as const;
