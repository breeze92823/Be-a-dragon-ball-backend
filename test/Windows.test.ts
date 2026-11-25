import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { PLAYTIME_UNLOCKS, QUEST_SLOTS } from "../src/constants.js";
import { utcDay } from "../src/daily.js";
import { bankPlaytime, claimPlaytime, playtimeSecs, readPlaytime, rollPlaytime } from "../src/playtime.js";
import { addQuestProgress, claimQuests, readQuests, rerollQuest, rollQuests } from "../src/quests.js";
import { sanitizeProgress } from "../src/sanitize.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

const DAY = 86_400_000;

describe("playtime rewards rules", () => {
  it("unlocks rewards by seconds online today and only once", () => {
    const t0 = 100 * DAY + 1000;
    const s = readPlaytime(null, t0);
    assert.ok(!claimPlaytime(s, 0, t0 + (PLAYTIME_UNLOCKS[0] - 1) * 1000), "too early");
    assert.ok(claimPlaytime(s, 0, t0 + PLAYTIME_UNLOCKS[0] * 1000));
    assert.ok(!claimPlaytime(s, 0, t0 + 9e6), "already claimed");
    assert.ok(!claimPlaytime(s, 99, t0 + 9e6));
    assert.ok(!claimPlaytime(s, "1", t0 + 9e6));
  });

  it("keeps today's banked time, forgets yesterday's and starts over at midnight", () => {
    const today = utcDay();
    const s = readPlaytime({ ptDay: today, ptSecs: 500, ptClaimed: [0, 0, 1, 42] }, Date.now());
    assert.deepStrictEqual(s.claimed, [0, 1]);
    assert.ok(playtimeSecs(s) >= 500);
    assert.strictEqual(readPlaytime({ ptDay: today - 1, ptSecs: 500, ptClaimed: [0] }).secs, 0);

    const t = 50 * DAY + DAY - 10_000; // 10 s before midnight
    const p = readPlaytime(null, t);
    bankPlaytime(p, t + 5000);
    assert.strictEqual(p.secs, 5);
    assert.ok(rollPlaytime(p, t + 20_000));
    assert.strictEqual(Math.round(playtimeSecs(p, t + 20_000)), 10, "counted from midnight");
    assert.deepStrictEqual(p.claimed, []);
  });
});

describe("daily quests rules", () => {
  it("rolls distinct quests once per day, rerolls once, counts progress and claims", () => {
    let i = 0;
    const rand = () => ((i++ * 0.37) % 1);
    const s = readQuests(null);
    assert.ok(rollQuests(s, 10, rand));
    assert.strictEqual(s.list.length, QUEST_SLOTS);
    assert.strictEqual(new Set(s.list.map((q) => q.kind)).size, QUEST_SLOTS);
    assert.ok(!rollQuests(s, 10, rand), "once per day");

    assert.ok(rerollQuest(s, 0, rand));
    assert.ok(!rerollQuest(s, 0, rand), "one reroll per quest");
    assert.ok(!claimQuests(s, false), "not finished");
    for (const q of s.list) addQuestProgress(s, q.kind, 999);
    assert.ok(s.list.every((q) => q.n === q.goal), "capped at the goal");
    assert.ok(!addQuestProgress(s, "bogus", 1));
    assert.ok(!rerollQuest(s, 1, rand), "finished quests can't be rerolled");
    assert.ok(claimQuests(s, false));
    assert.ok(!claimQuests(s, true), "claimed once a day");
    assert.ok(rollQuests(s, 11, rand));
    assert.strictEqual(s.claimed, false);
  });

  it("lets a paid skip claim unfinished quests and drops a malformed saved list", () => {
    const s = readQuests(null);
    rollQuests(s, 3);
    assert.ok(claimQuests(s, true));
    assert.deepStrictEqual(readQuests({ quests: { day: 3, list: [{ kind: "hatch", goal: 7, n: 0, rerolled: false }], claimed: true } } as any).day, -1);
  });
});

describe("window save fields", () => {
  it("bounds discoveries, boosts and settings", () => {
    const out = sanitizeProgress({
      discovered: ["default.kairo", "default.kairo", "Bad Key", "golden.zenbu", 5],
      indexClaimed: ["golden", "Bad Id!"],
      speedBoostUntil: Date.now() + 1e12,
      luckBoostUntil: -5,
      settings: { lowGfx: true, noVfx: "yes", muteMusic: false, names: false, hack: 1 },
      ptSecs: 99999,
      quests: { day: 1 },
    })!;
    assert.deepStrictEqual(out.discovered, ["default.kairo", "golden.zenbu"]);
    assert.deepStrictEqual(out.indexClaimed, ["golden"]);
    assert.ok(out.speedBoostUntil! <= Date.now() + 86_400_000 + 1000);
    assert.strictEqual(out.luckBoostUntil, 0);
    assert.deepStrictEqual(out.settings, { lowGfx: true, noVfx: false, muteMusic: false, names: false });
    assert.ok(!("ptSecs" in out) && !("quests" in out), "server-owned fields never come from a save");
  });
});

describe("playtime + quests room", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  it("sends the views on load, claims on the server clock and stores quest progress", async () => {
    const today = utcDay();
    const fake = fakePlayers([{ _id: "w1", ptDay: today, ptSecs: PLAYTIME_UNLOCKS[1] + 1, ptClaimed: [0], version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "w1" });
    let pt: any = null;
    let qs: any = null;
    const results: any[] = [];
    for (const t of ["progress", "spins", "daily", "leaderboard"]) c.onMessage(t, () => {});
    c.onMessage("playtime", (m: any) => (pt = m));
    c.onMessage("quests", (m: any) => (qs = m));
    c.onMessage("playtimeResult", (m: any) => results.push(m));
    c.onMessage("questResult", (m: any) => results.push(m));
    fake.release();
    await sleep(150);
    assert.deepStrictEqual(pt?.claimed, [0]);
    assert.ok(pt.secs >= PLAYTIME_UNLOCKS[1]);
    assert.strictEqual(qs?.list.length, QUEST_SLOTS);
    assert.strictEqual(qs.day, today);
    assert.ok((fake.docs.get("w1") as any).quests, "today's list is stored");

    c.send("claimPlaytime", { i: 1 });
    c.send("claimPlaytime", { i: 8 });
    await sleep(150);
    assert.deepStrictEqual(results.map((r) => [r.i, r.ok]).sort(), [[1, true], [8, false]]);
    assert.deepStrictEqual((fake.docs.get("w1") as any).ptClaimed, [0, 1]);

    const kind = qs.list.find((q: any) => q.kind !== "play")?.kind;
    c.send("questEvent", { kind, n: 1 });
    await sleep(150);
    const stored = (fake.docs.get("w1") as any).quests.list.find((q: any) => q.kind === kind);
    assert.strictEqual(stored.n, 1);
    c.send("questEvent", { kind: "play", n: 99 });
    c.send("questAction", { action: "claim" });
    await sleep(150);
    assert.strictEqual(results.at(-1).ok, false, "not finished, no skip");
    c.send("questAction", { action: "claim", skip: true });
    await sleep(150);
    assert.strictEqual(results.at(-1).ok, true);
    assert.strictEqual((fake.docs.get("w1") as any).quests.claimed, true);

    // uiSync re-sends the views; saveProgress can't touch the server-owned fields.
    pt = null;
    c.send("uiSync", {});
    c.send("saveProgress", { ptClaimed: [], quests: null, money: 5 });
    await sleep(150);
    assert.ok(pt);
    assert.deepStrictEqual((fake.docs.get("w1") as any).ptClaimed, [0, 1]);
    assert.strictEqual((fake.docs.get("w1") as any).money, 5);
  });
});
