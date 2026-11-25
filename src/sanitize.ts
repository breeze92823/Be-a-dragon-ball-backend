import {
  CURRENCY_MAX, REBIRTHS_MAX, DISTANCE_MAX, PLAY_SECONDS_MAX, OWNED_MAX, PETS_MAX, PET_TIERS_MAX,
  PET_SLOTS_MAX, GIFTS_MAX, POTION_KINDS_MAX, POTION_COUNT_MAX, ID_PATTERN,
  HOTBAR_MAX, BACKPACK_MAX, BASE_SLOTS_MAX, FIGHTER_NAME_MAX, FIGHTER_ID_MAX, SLOT_LEVEL_MAX,
  INDEX_KEY, INDEX_MAX, BOOST_MAX_MS, BASE_UPGRADE_STEPS,
} from "./constants.js";
import type { PlayerDoc, SavedFighter, SavedLook, SavedPet, SavedSlot } from "./db.js";

export function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
export function clampNum(v: number, max: number): number {
  return Math.min(max, Math.max(0, v));
}
export function clampInt(v: number, max: number, min = 0): number {
  return Math.min(max, Math.max(min, Math.floor(v)));
}
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
const isId = (v: unknown): v is string => typeof v === "string" && ID_PATTERN.test(v);

// Catalog ids (boats, engines, partners, trails): slug strings, no duplicates, bounded count.
export function sanitizeIds(raw: unknown, max = OWNED_MAX): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isId))].slice(0, max);
}

// Owned pets { kind, tier, equipped, locked }: slug kinds, integer tiers, at most PETS_MAX, and no
// more than `slots` of them equipped (the extra ones are unequipped, never dropped).
export function sanitizePets(raw: unknown, slots = PET_SLOTS_MAX): SavedPet[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedPet[] = [];
  let equipped = 0;
  for (const p of raw) {
    if (out.length >= PETS_MAX) break;
    if (!isObject(p) || !isId(p.kind) || !Number.isInteger(p.tier) || (p.tier as number) < 0 || (p.tier as number) >= PET_TIERS_MAX) continue;
    const on = p.equipped === true && equipped < slots;
    if (on) equipped++;
    out.push({ kind: p.kind, tier: p.tier as number, equipped: on, locked: p.locked === true });
  }
  return out;
}

// Potion counts { id: n }: slug ids, whole non-negative counts, bounded kinds.
function sanitizePotions(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObject(raw)) return out;
  for (const [id, n] of Object.entries(raw)) {
    if (Object.keys(out).length >= POTION_KINDS_MAX) break;
    if (isId(id) && finite(n)) out[id] = clampInt(n, POTION_COUNT_MAX);
  }
  return out;
}

// --- Be a Dragon Ball fighters ---------------------------------------------------------------
const COLOR = /^#[0-9a-fA-F]{6}$/;
const LABEL = /^[A-Za-z][A-Za-z ]{0,23}$/; // rarity / mutation names ("Common", "Golden"...)
const color = (v: unknown, fallback: string) => (typeof v === "string" && COLOR.test(v) ? v : fallback);
const small = (v: unknown) => (finite(v) ? clampInt(v, 9) : 0);

function sanitizeLook(raw: unknown): SavedLook {
  const l = isObject(raw) ? raw : {};
  return {
    gi: color(l.gi, "#ff7a1a"),
    pants: color(l.pants, "#1f5ed8"),
    hair: color(l.hair, "#111318"),
    skin: color(l.skin, "#f2c79a"),
    belt: color(l.belt, "#1d2a44"),
    boots: color(l.boots, "#1f5ed8"),
    style: small(l.style),
    stance: small(l.stance),
    cape: l.cape === true,
  };
}

// One fighter, or null when it is not one (no name / rarity / income).
export function sanitizeFighter(raw: unknown): SavedFighter | null {
  if (!isObject(raw)) return null;
  if (!finite(raw.id) || typeof raw.name !== "string" || typeof raw.rarity !== "string" || !LABEL.test(raw.rarity) || !finite(raw.income)) return null;
  const name = raw.name.slice(0, FIGHTER_NAME_MAX).trim();
  if (!name) return null;
  return {
    id: clampInt(raw.id, FIGHTER_ID_MAX),
    name,
    rarity: raw.rarity,
    mutation: typeof raw.mutation === "string" && LABEL.test(raw.mutation) ? raw.mutation : null,
    income: clampNum(raw.income, CURRENCY_MAX),
    look: sanitizeLook(raw.look),
  };
}

export function sanitizeFighters(raw: unknown, max: number): SavedFighter[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedFighter[] = [];
  for (const f of raw) {
    if (out.length >= max) break;
    const s = sanitizeFighter(f);
    if (s) out.push(s);
  }
  return out;
}

export function sanitizeSlots(raw: unknown): SavedSlot[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, BASE_SLOTS_MAX).map((s) => {
    const o = isObject(s) ? s : {};
    return {
      fighter: sanitizeFighter(o.fighter),
      level: finite(o.level) ? clampInt(o.level, SLOT_LEVEL_MAX, 1) : 1,
      stored: finite(o.stored) ? clampNum(o.stored, CURRENCY_MAX) : 0,
    };
  });
}

// One owned list + its equipped id. The equipped one must be owned ("" = none); when this save
// doesn't carry the list, trust the id's shape only.
function ownedPair(raw: Record<string, unknown>, out: Partial<PlayerDoc>, listKey: "boats" | "engines" | "partners" | "trails", idKey: "boat" | "engine" | "partner" | "trail") {
  if (raw[listKey] !== undefined) out[listKey] = sanitizeIds(raw[listKey]);
  const id = raw[idKey];
  const owned = out[listKey];
  if (id === "") out[idKey] = "";
  else if (isId(id) && (!owned || owned.includes(id))) out[idKey] = id;
}

// The game is client-authoritative -- no server-side gameplay validation. What IS enforced:
// shape and bounds, so a malformed payload can never corrupt this player's own Mongo document.
// A forged number can only ever affect the sender's own save.
export function sanitizeProgress(raw: unknown): Partial<PlayerDoc> | null {
  if (!isObject(raw)) return null;
  const out: Partial<PlayerDoc> = {};

  if (finite(raw.trophies)) out.trophies = clampNum(raw.trophies, CURRENCY_MAX);
  if (finite(raw.gems)) out.gems = clampNum(raw.gems, CURRENCY_MAX);
  if (finite(raw.energy)) out.energy = clampNum(raw.energy, CURRENCY_MAX);
  if (finite(raw.rebirths)) out.rebirths = clampInt(raw.rebirths, REBIRTHS_MAX);
  if (typeof raw.autoRebirth === "boolean") out.autoRebirth = raw.autoRebirth;
  if (finite(raw.bestDistance)) out.bestDistance = clampNum(raw.bestDistance, DISTANCE_MAX);
  if (finite(raw.playtime)) out.playtime = clampInt(raw.playtime, PLAY_SECONDS_MAX);
  if (finite(raw.lastSeen)) out.lastSeen = clampInt(raw.lastSeen, Date.now() + 10 * 60 * 1000);

  ownedPair(raw, out, "boats", "boat");
  ownedPair(raw, out, "engines", "engine");
  ownedPair(raw, out, "partners", "partner");
  ownedPair(raw, out, "trails", "trail");

  if (finite(raw.petSlots)) out.petSlots = clampInt(raw.petSlots, PET_SLOTS_MAX, 1);
  if (finite(raw.petStorage)) out.petStorage = clampInt(raw.petStorage, PETS_MAX, 1);
  if (raw.pets !== undefined) out.pets = sanitizePets(raw.pets, out.petSlots ?? PET_SLOTS_MAX);
  if (raw.eggsSeen !== undefined) out.eggsSeen = sanitizeIds(raw.eggsSeen);
  if (raw.world === "" || isId(raw.world)) out.world = raw.world as string;
  if (raw.worldsUnlocked !== undefined) out.worldsUnlocked = sanitizeIds(raw.worldsUnlocked);

  if (finite(raw.giftTime)) out.giftTime = clampInt(raw.giftTime, PLAY_SECONDS_MAX);
  if (raw.giftsClaimed !== undefined) {
    const claimed = Array.isArray(raw.giftsClaimed) ? raw.giftsClaimed.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < GIFTS_MAX) : [];
    out.giftsClaimed = [...new Set(claimed)];
  }
  if (raw.potions !== undefined) out.potions = sanitizePotions(raw.potions);

  // Be a Dragon Ball.
  if (finite(raw.money)) out.money = clampNum(raw.money, CURRENCY_MAX);
  if (finite(raw.speed)) out.speed = clampNum(raw.speed, CURRENCY_MAX);
  if (finite(raw.nextId)) out.nextId = clampInt(raw.nextId, FIGHTER_ID_MAX, 1);
  if (raw.inventory !== undefined) out.inventory = sanitizeFighters(raw.inventory, HOTBAR_MAX);
  if (raw.backpack !== undefined) out.backpack = sanitizeFighters(raw.backpack, BACKPACK_MAX);
  if (raw.slots !== undefined) out.slots = sanitizeSlots(raw.slots);

  // Windows (client src/ui/): Index discoveries + collection rewards, timed boosts, Settings.
  if (raw.discovered !== undefined) {
    const keys = Array.isArray(raw.discovered) ? raw.discovered.filter((k): k is string => typeof k === "string" && INDEX_KEY.test(k)) : [];
    out.discovered = [...new Set(keys)].slice(0, INDEX_MAX);
  }
  if (raw.indexClaimed !== undefined) out.indexClaimed = sanitizeIds(raw.indexClaimed, 64);
  const boostCap = Date.now() + BOOST_MAX_MS;
  if (finite(raw.speedBoostUntil)) out.speedBoostUntil = clampInt(raw.speedBoostUntil, boostCap);
  if (finite(raw.luckBoostUntil)) out.luckBoostUntil = clampInt(raw.luckBoostUntil, boostCap);
  if (finite(raw.moneyBoostUntil)) out.moneyBoostUntil = clampInt(raw.moneyBoostUntil, boostCap);

  // Shops: equipped base skin (must be unlocked when the save carries indexClaimed), owned +
  // equipped treadmill and dragon ball ("" = the starter one; the equipped id must be owned).
  if (raw.baseSkin === "") out.baseSkin = "";
  else if (isId(raw.baseSkin) && (!out.indexClaimed || out.indexClaimed.includes(raw.baseSkin))) out.baseSkin = raw.baseSkin;
  for (const [listKey, idKey] of [["treadmills", "treadmill"], ["balls", "ball"]] as const) {
    if (raw[listKey] !== undefined) out[listKey] = sanitizeIds(raw[listKey], 64);
    const id = raw[idKey];
    const owned = out[listKey];
    if (id === "") out[idKey] = "";
    else if (isId(id) && (!owned || owned.includes(id))) out[idKey] = id;
  }
  // Base boards: Base Upgrade steps (client BASE_BOARD.upgrade.prices) and the bought toggles.
  if (finite(raw.baseLevel)) out.baseLevel = clampInt(raw.baseLevel, BASE_UPGRADE_STEPS);
  for (const k of ["autoCollect", "autoCollectOn", "upgradeMax"] as const) if (typeof raw[k] === "boolean") out[k] = raw[k] as boolean;
  if (isObject(raw.settings)) {
    const s = raw.settings;
    out.settings = { lowGfx: s.lowGfx === true, noVfx: s.noVfx === true, muteMusic: s.muteMusic === true, names: s.names !== false };
  }
  return out;
}
