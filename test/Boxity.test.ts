import assert from "node:assert/strict";

import { badgeKeys, boardScores, statValues, trustClientIds } from "../src/boxity.js";
import { BADGES, BOARDS, STATS } from "../src/boxity-catalog.js";

const look = { gi: "#ff7a1a", pants: "#1f5ed8", hair: "#111318", skin: "#f2c79a", belt: "#1d2a44", boots: "#1f5ed8", style: 0, stance: 0, cape: false };
const fighter = (rarity: string, mutation: string | null = null) => ({ id: 1, name: "Kairo", rarity, mutation, income: 10, look });

describe("boxity reporting", () => {
  it("reports finite stats under each type's ceiling and leaves the rest out", () => {
    const v = statValues({ money: 5e6, speed: 2500, rebirths: 2, inventory: [fighter("Rare")], discovered: ["default.kairo"] });
    assert.deepEqual(v, { cash: 5000000, speed: 2500, rebirths: 2, fighters: 1, index: 1 });
    // Above the currency ceiling (1e12) is omitted, never clamped; NaN / negatives are dropped.
    assert.equal(statValues({ money: 5e20 }).cash, undefined);
    assert.equal(statValues({ speed: -1 }).speed, undefined);
    assert.equal(statValues({ speed: NaN }).speed, undefined);
    assert.equal(STATS.length, new Set(STATS.map((s) => s.key)).size);
  });

  it("scores the boards from the saved doc (playtime in ms)", () => {
    const s = boardScores({ money: 100, speed: 0, rebirths: 3, playtime: 90 });
    assert.deepEqual(s.map((x) => x.board).sort(), ["cash", "playtime", "rebirths"]);
    assert.equal(s.find((x) => x.board === "playtime")!.score, 90000);
    assert.ok(BOARDS.length <= 10);
  });

  it("awards badges by what the save holds", () => {
    assert.deepEqual(badgeKeys({}), []);
    const keys = badgeKeys({ slots: [{ fighter: fighter("Primal", "golden"), level: 1, stored: 0 }], rebirths: 1, money: 2e6 });
    for (const k of ["first_fighter", "mutant", "mythic_hatch", "primal_power", "reborn", "millionaire"]) assert.ok(keys.includes(k), k);
    assert.equal(BADGES.length, new Set(BADGES.map((b) => b.key)).size);
  });

  it("never trusts a client id in production", () => {
    const was = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      assert.equal(trustClientIds(), false);
    } finally {
      process.env.NODE_ENV = was;
    }
  });
});

import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { __setPlayersForTest } from "../src/db.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("identity", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => {
    __setPlayersForTest(null);
    delete process.env.TRUST_CLIENT_IDS;
  });

  it("does not load or save a client-sent userId once client ids are not trusted", async () => {
    process.env.TRUST_CLIENT_IDS = "false";
    const fake = fakePlayers([{ _id: "victim", money: 999, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom("world", {});
    const c = await colyseus.connectTo(room, { userId: "victim", username: "Mallory" });
    const got: string[] = [];
    for (const t of ["progress", "noProgress"]) c.onMessage(t, () => got.push(t));
    fake.release();
    await sleep(200);
    assert.ok(!got.includes("progress")); // treated as a guest: the victim's save is never sent
    c.send("saveProgress", { money: 1 });
    await sleep(150);
    assert.equal((fake.docs.get("victim") as any).money, 999);
  });
});

import { PlayerState } from "../src/rooms/schema/WorldState.js";
import { applyLoadout } from "../src/presence.js";

describe("presence forms", () => {
  it("relays the player's form, ball and fighter looks, bounded and sanitized", () => {
    const p = new PlayerState();
    applyLoadout(p, { form: "orb", ball: "lucky", fighter: { ...look, gi: "#112233", hair: "javascript:1", style: 99 }, held: null });
    assert.equal(p.form, "orb");
    assert.equal(p.ball, "lucky");
    // Bad colours fall back, poses are clamped to 0..9, the shape is fixed.
    assert.equal(p.fighter, "#112233,#1f5ed8,#111318,#f2c79a,#1d2a44,#1f5ed8,9,0,0");
    assert.equal(p.held, "");
    applyLoadout(p, { form: "dragon", ball: "no spaces!" });
    assert.equal(p.form, "orb"); // unknown forms and bad ids are ignored
    assert.equal(p.ball, "lucky");
    applyLoadout(p, { form: "human", fighter: null });
    assert.equal(p.form, "human");
    assert.equal(p.fighter, "");
  });
});

describe("one base per player", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("seats 5 players, gives each a different base and honours a free preference", async () => {
    const room = await colyseus.createRoom<any>("world", {});
    assert.equal(room.maxClients, 5);
    const told: Record<string, number> = {};
    const clients = [];
    for (let i = 0; i < 5; i++) {
      // The first player asks for base 3; the others take whatever is free.
      const c = await colyseus.connectTo(room, { userId: `guest-${i}`, username: `P${i}`, ...(i === 0 && { base: 3 }) });
      c.onMessage("base", (m: any) => (told[c.sessionId] = m.index));
      clients.push(c);
    }
    await sleep(100);
    const bases = clients.map((c) => room.state.players.get(c.sessionId)!.base);
    assert.equal(bases[0], 3);
    assert.deepEqual([...bases].sort(), [0, 1, 2, 3, 4]);
    // A sixth player does not fit: the room is full (the matchmaker opens another room).
    await assert.rejects(colyseus.connectTo(room, { userId: "guest-x" }));
    // A leaver frees its base for the next one.
    const leaving = clients[1];
    const freed = room.state.players.get(leaving.sessionId)!.base;
    await leaving.leave(true);
    await sleep(100);
    const next = await colyseus.connectTo(room, { userId: "guest-n", base: 99 });
    await sleep(50);
    assert.equal(room.state.players.get(next.sessionId)!.base, freed);
  });

  it("relays the base's multi and fighters, and the item ids for skins", async () => {
    const room = await colyseus.createRoom<any>("world", {});
    const c = await colyseus.connectTo(room, { userId: "guest-m", username: "Mo" });
    const f = { ...look, gi: "#112233" };
    c.send("loadout", { multi: 2.5, slots: [f, null, f] });
    c.send("setAvatar", { avatar: "o1_sAAA", look: '{"equipped":{"hatId":"1"}}' });
    await sleep(100);
    const p = room.state.players.get(c.sessionId)!;
    assert.equal(p.multi, 2.5);
    assert.equal(p.baseSlots.split("|").length, 3);
    assert.equal(p.baseSlots.split("|")[1], "");
    assert.equal(p.avatar, "o1_sAAA");
    assert.equal(p.look, '{"equipped":{"hatId":"1"}}');
  });
});
