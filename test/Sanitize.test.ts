import assert from "assert";

import { CURRENCY_MAX } from "../src/constants.js";
import { sanitizeProgress } from "../src/sanitize.js";

describe("sanitizeProgress", () => {
  it("rejects non-objects and bounds numbers", () => {
    assert.strictEqual(sanitizeProgress(null), null);
    assert.strictEqual(sanitizeProgress([1]), null);
    const out = sanitizeProgress({ trophies: 1e40, gems: -5, energy: NaN, rebirths: 3.7, autoRebirth: "yes", hack: "x" })!;
    assert.strictEqual(out.trophies, CURRENCY_MAX);
    assert.strictEqual(out.gems, 0);
    assert.strictEqual(out.energy, undefined);
    assert.strictEqual(out.rebirths, 3);
    assert.strictEqual(out.autoRebirth, undefined);
    assert.ok(!("hack" in out));
  });

  it("keeps well-formed catalog ids and only equips an owned one", () => {
    const out = sanitizeProgress({ boats: ["raft", "canoe", "canoe", "Bad Id!", 7], boat: "canoe", engines: ["basic", "ladder-3"], engine: "ladder-9" })!;
    assert.deepStrictEqual(out.boats, ["raft", "canoe"]);
    assert.strictEqual(out.boat, "canoe");
    assert.deepStrictEqual(out.engines, ["basic", "ladder-3"]);
    assert.strictEqual(out.engine, undefined);
    assert.strictEqual(sanitizeProgress({ partner: "" })!.partner, "");
    assert.strictEqual(sanitizeProgress({ trail: "waterRipple" })!.trail, "waterRipple");
  });

  it("keeps well-formed pets and caps the equipped ones at the slots", () => {
    const out = sanitizeProgress({
      petSlots: 2,
      pets: [
        { kind: "dog", tier: 0, equipped: true, locked: false },
        { kind: "cat", tier: 1.5, equipped: true },
        { kind: "Bad Id!", tier: 0 },
        { kind: "fox", tier: 2, equipped: true, locked: true },
        { kind: "bear", tier: 0, equipped: true },
        "x",
      ],
    })!;
    assert.deepStrictEqual(sanitizeProgress({ eggsSeen: ["dog", "dog", "Bad Id!", "dragon"] })!.eggsSeen, ["dog", "dragon"]);
    const worlds = sanitizeProgress({ world: "city", worldsUnlocked: ["city", "city", "Bad Id!"] })!;
    assert.deepStrictEqual([worlds.world, worlds.worldsUnlocked], ["city", ["city"]]);
    assert.strictEqual(sanitizeProgress({ world: "Bad World!" })!.world, undefined);
    assert.deepStrictEqual(out.pets, [
      { kind: "dog", tier: 0, equipped: true, locked: false },
      { kind: "fox", tier: 2, equipped: true, locked: true },
      { kind: "bear", tier: 0, equipped: false, locked: false },
    ]);
  });

  it("bounds the Online Gifts state", () => {
    const out = sanitizeProgress({ giftTime: -4, giftsClaimed: [0, 0, 3, 99, "1"], potions: { golden: 2.9, "bad id": 1, doubleWin: "x" } })!;
    assert.strictEqual(out.giftTime, 0);
    assert.deepStrictEqual(out.giftsClaimed, [0, 3]);
    assert.deepStrictEqual(out.potions, { golden: 2 });
  });

  it("keeps Be a Dragon Ball progress: money, speed, hotbar, backpack and base slots", () => {
    const look = { gi: "#ff7a1a", pants: "#1f5ed8", hair: "javascript:", skin: "#f2c79a", belt: "#1d2a44", boots: "#1f5ed8", style: 2.6, stance: 99, cape: "yes" };
    const goku = { id: 3, name: "  Kairo ", rarity: "Legendary", mutation: "Golden", income: 1e40, look, extra: 1 };
    const bad = { id: 4, name: "", rarity: "Common", income: 5 };
    const out = sanitizeProgress({
      money: -3,
      speed: 5400.5,
      nextId: 0,
      inventory: [goku, bad, null, ...Array.from({ length: 20 }, (_, i) => ({ id: 10 + i, name: "Zen", rarity: "Common", mutation: null as string | null, income: 600, look }))],
      backpack: [{ ...goku, rarity: "<script>" }, { ...goku, id: 9, mutation: 7 }],
      slots: [{ fighter: goku, level: 0, stored: 50 }, { fighter: null, level: 3.9, stored: -1 }, "x"],
    })!;
    assert.strictEqual(out.money, 0);
    assert.strictEqual(out.speed, 5400.5);
    assert.strictEqual(out.nextId, 1);
    assert.strictEqual(out.inventory!.length, 10, "the hotbar holds 10");
    const f = out.inventory![0] as any;
    assert.strictEqual(f.name, "Kairo");
    assert.strictEqual(f.income, CURRENCY_MAX);
    assert.strictEqual(f.look.hair, "#111318", "a bad colour falls back");
    assert.strictEqual(f.look.style, 2);
    assert.strictEqual(f.look.stance, 9);
    assert.strictEqual(f.look.cape, false);
    assert.ok(!("extra" in f));
    assert.strictEqual(out.backpack!.length, 1, "a bad rarity is dropped");
    assert.strictEqual(out.backpack![0].mutation, null);
    assert.deepStrictEqual(out.slots!.map((s) => [!!s.fighter, s.level, s.stored]), [[true, 1, 50], [false, 3, 0], [false, 1, 0]]);
  });
});
