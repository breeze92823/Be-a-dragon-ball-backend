import { FUSE_INPUTS, FUSE_MUTATION_CHANCE, FUSE_MUTATIONS, FUSE_PICK_MAX, FUSE_RARITIES, FUSE_SECONDS, FUSE_STEPS } from "./constants.js";
import type { PlayerDoc } from "./db.js";

// Fuse Machine (client src/ui/fuse.js): server-authoritative like the Spin wheel. `fuseStart`
// takes the four fighters' rarities + mutations, rolls the result here (so the client can't pick
// it) and starts the timer; `fuseClaim` hands the result over once the timer is done. One fusion
// at a time per player. Doc field `fuse` (written by the server only, never by saveProgress).
// The client takes the four fighters out of its inventory when the start answers ok.

export interface FuseInput {
  rarity: string;
  mutation: string | null; // mutation id, null = Default
}
export interface FuseJob {
  inputs: FuseInput[];
  rarity: string; // result rarity name
  mutation: string | null; // result mutation id
  pick: number; // roster index (client: mod the rarity's list length)
  readyAt: number; // epoch ms
}

const rarityIndex = (name: unknown) => FUSE_RARITIES.indexOf(name as (typeof FUSE_RARITIES)[number]);
const mutationIds = new Set<string>(FUSE_MUTATIONS.map((m) => m.id));
const mutationOf = (v: unknown): string | null => {
  if (typeof v !== "string" || !v) return null;
  const m = FUSE_MUTATIONS.find((x) => x.id === v || x.name === v);
  return m ? m.id : null;
};

// The inputs, or null when they are not FUSE_INPUTS known fighters.
export function readInputs(raw: unknown): FuseInput[] | null {
  if (!Array.isArray(raw) || raw.length !== FUSE_INPUTS) return null;
  const out: FuseInput[] = [];
  for (const f of raw) {
    if (!f || typeof f !== "object" || rarityIndex((f as any).rarity) < 0) return null;
    out.push({ rarity: (f as any).rarity, mutation: mutationOf((f as any).mutation) });
  }
  return out;
}

// The tier the steps count from: the inputs' average rarity, rounded.
export function baseTier(inputs: FuseInput[]): number {
  const sum = inputs.reduce((n, f) => n + rarityIndex(f.rarity), 0);
  return Math.round(sum / inputs.length);
}

// Possible outcomes for the window: [{ rarity, chance (0..1) }], merged where the cap folds steps.
export function outcomes(inputs: FuseInput[]): { rarity: string; chance: number }[] {
  const base = baseTier(inputs);
  const total = FUSE_STEPS.reduce((n, s) => n + s.weight, 0);
  const out: { rarity: string; chance: number }[] = [];
  for (const s of FUSE_STEPS) {
    const rarity = FUSE_RARITIES[Math.min(FUSE_RARITIES.length - 1, base + s.step)];
    const hit = out.find((o) => o.rarity === rarity);
    if (hit) hit.chance += s.weight / total;
    else out.push({ rarity, chance: s.weight / total });
  }
  return out;
}

export const fuseSeconds = (tier: number) => FUSE_SECONDS[0] + FUSE_SECONDS[1] * tier;

export function rollFusion(inputs: FuseInput[], now: number, rand: () => number = Math.random): FuseJob {
  const list = outcomes(inputs);
  let r = rand();
  let rarity = list[list.length - 1].rarity;
  for (const o of list) {
    if (r < o.chance) {
      rarity = o.rarity;
      break;
    }
    r -= o.chance;
  }
  // Mutation: four of the same pass it on; otherwise a weighted roll now and then.
  const shared = inputs.every((f) => f.mutation && f.mutation === inputs[0].mutation) ? inputs[0].mutation : null;
  let mutation: string | null = shared;
  if (!mutation && rand() < FUSE_MUTATION_CHANCE) {
    const total = FUSE_MUTATIONS.reduce((n, m) => n + m.weight, 0);
    let k = rand() * total;
    mutation = FUSE_MUTATIONS[FUSE_MUTATIONS.length - 1].id;
    for (const m of FUSE_MUTATIONS) {
      if (k < m.weight) {
        mutation = m.id;
        break;
      }
      k -= m.weight;
    }
  }
  return { inputs, rarity, mutation, pick: Math.floor(rand() * FUSE_PICK_MAX), readyAt: now + fuseSeconds(baseTier(inputs)) * 1000 };
}

// A saved job (or null): anything malformed is dropped.
export function readFuse(doc: Partial<PlayerDoc> | null): FuseJob | null {
  const j = doc?.fuse as any;
  if (!j || typeof j !== "object") return null;
  const inputs = readInputs(j.inputs);
  if (!inputs || rarityIndex(j.rarity) < 0 || typeof j.readyAt !== "number" || !Number.isFinite(j.readyAt)) return null;
  if (j.mutation !== null && !mutationIds.has(j.mutation)) return null;
  const pick = Number.isInteger(j.pick) && j.pick >= 0 && j.pick < FUSE_PICK_MAX ? j.pick : 0;
  return { inputs, rarity: j.rarity, mutation: j.mutation, pick, readyAt: j.readyAt };
}

// What the client sees while fusing: the inputs and the timer, never the result.
export function fuseView(j: FuseJob | null, now = Date.now()) {
  return { fusing: j ? { inputs: j.inputs, readyAt: j.readyAt, outcomes: outcomes(j.inputs) } : null, serverTime: now };
}
