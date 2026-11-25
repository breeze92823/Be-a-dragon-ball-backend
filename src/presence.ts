import { AVATAR_MAX_LEN, ID_PATTERN, POSE_BOUNDS, PRESENCE_PETS_MAX, PRESENCE_SLOTS_MAX, PET_TIERS_MAX } from "./constants.js";
import type { PlayerState } from "./rooms/schema/WorldState.js";
import { sanitizeLook } from "./sanitize.js";

// Presence: what the other clients need to draw a player in the world (client remotePlayers.js).
// Relayed through the roster as sent, only bounded here -- like the rest of the game it is
// client-authoritative and purely cosmetic.

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const isId = (v: unknown): v is string => typeof v === "string" && ID_PATTERN.test(v);

// `pose` { x, y, z, yaw, speed }: the boat's feet position in TRACK coordinates (z minus the
// sender's race scroll, so racers line up in everyone's lane), heading (rad) and speed (m/s).
export function applyPose(p: PlayerState, msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;
  const b = POSE_BOUNDS;
  if (finite(m.x)) p.x = clamp(m.x, -b.xy, b.xy);
  if (finite(m.y)) p.y = clamp(m.y, -b.xy, b.xy);
  if (finite(m.z)) p.z = clamp(m.z, -b.z, b.xy);
  if (finite(m.yaw)) p.yaw = Math.atan2(Math.sin(m.yaw), Math.cos(m.yaw));
  if (finite(m.speed)) p.speed = clamp(m.speed, 0, b.speed);
}

// `loadout` { boat, engine, trail, partner, pets: [{ kind, tier }], world }: equipped catalog ids
// ("" = none) and the world the player is in (clients only draw players in their own world). Pets travel as "kind:tier" joined by commas, capped at PRESENCE_PETS_MAX.
// A fighter look as the roster carries it: the sanitized colours + poses joined by commas ("" = none).
export function lookCsv(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const l = sanitizeLook(raw);
  return [l.gi, l.pants, l.hair, l.skin, l.belt, l.boots, l.style, l.stance, l.cape ? 1 : 0].join(",");
}

export const FORMS = ["human", "orb", "fighter"] as const;

export function applyLoadout(p: PlayerState, msg: unknown): void {
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;
  // How the others draw this player, and what they wear / carry in that form.
  if (typeof m.form === "string" && (FORMS as readonly string[]).includes(m.form)) p.form = m.form;
  if (m.ball === "" || isId(m.ball)) p.ball = m.ball as string;
  if (m.fighter !== undefined) p.fighter = lookCsv(m.fighter);
  if (m.held !== undefined) p.held = lookCsv(m.held);
  // The base: Cash Multi and the fighters standing on its slots (null = empty), for the others to draw.
  if (finite(m.multi)) p.multi = clamp(m.multi, 1, 1000);
  if (Array.isArray(m.slots)) p.baseSlots = m.slots.slice(0, PRESENCE_SLOTS_MAX).map(lookCsv).join("|");
  for (const key of ["boat", "engine", "trail", "partner", "world"] as const) {
    const v = m[key];
    if (v === "" || isId(v)) p[key] = v as string;
  }
  if (Array.isArray(m.pets)) {
    const pets: string[] = [];
    for (const pet of m.pets) {
      if (pets.length >= PRESENCE_PETS_MAX) break;
      const k = (pet as { kind?: unknown })?.kind;
      const t = (pet as { tier?: unknown })?.tier;
      if (isId(k) && Number.isInteger(t) && (t as number) >= 0 && (t as number) < PET_TIERS_MAX) pets.push(`${k}:${t}`);
    }
    p.pets = pets.join(",");
  }
}

// `setAvatar` { avatar }: the Bloxity look as an opaque JSON string ("" = default), length-capped.
export function applyAvatar(p: PlayerState, msg: unknown): void {
  const a = (msg as { avatar?: unknown })?.avatar;
  if (typeof a === "string" && a.length <= AVATAR_MAX_LEN) p.avatar = a;
  const look = (msg as { look?: unknown })?.look;
  if (typeof look === "string" && look.length <= AVATAR_MAX_LEN) p.look = look;
}
