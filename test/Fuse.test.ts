import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { FUSE_RARITIES } from "../src/constants.js";
import { baseTier, fuseSeconds, outcomes, readFuse, readInputs, rollFusion } from "../src/fuse.js";
import { sanitizeProgress } from "../src/sanitize.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

const four = (rarity: string, mutation: string | null = null) => Array.from({ length: 4 }, () => ({ rarity, mutation }));

describe("fuse machine rules", () => {
  it("accepts exactly four known fighters", () => {
    assert.ok(readInputs(four("Common")));
    assert.strictEqual(readInputs(four("Common").slice(0, 3)), null);
    assert.strictEqual(readInputs([...four("Common").slice(0, 3), { rarity: "Bogus" }]), null);
    assert.strictEqual(readInputs("x"), null);
  });

  it("aims at the average rarity and folds the steps at the top", () => {
    assert.strictEqual(baseTier(readInputs([{ rarity: "Common" }, { rarity: "Common" }, { rarity: "Rare" }, { rarity: "Epic" }])!), 1);
    const low = outcomes(readInputs(four("Common"))!);
    assert.deepStrictEqual(low.map((o) => o.rarity), ["Common", "Uncommon", "Rare"]);
    assert.ok(Math.abs(low.reduce((n, o) => n + o.chance, 0) - 1) < 1e-9);
    const top = outcomes(readInputs(four("Primal"))!);
    assert.deepStrictEqual(top.map((o) => o.rarity), ["Primal"]);
    assert.ok(Math.abs(top[0].chance - 1) < 1e-9);
  });

  it("rolls the result, passes on a shared mutation and times it by tier", () => {
    const job = rollFusion(readInputs(four("Rare", "golden"))!, 1000, () => 0);
    assert.strictEqual(job.rarity, "Rare");
    assert.strictEqual(job.mutation, "golden");
    assert.strictEqual(job.readyAt, 1000 + fuseSeconds(2) * 1000);
    const hi = rollFusion(readInputs(four("Rare"))!, 0, () => 0.99);
    assert.strictEqual(hi.rarity, FUSE_RARITIES[4]);
    assert.strictEqual(hi.mutation, null);
    assert.deepStrictEqual(readFuse({ fuse: job } as any), job);
    assert.strictEqual(readFuse({ fuse: { ...job, rarity: "Nope" } } as any), null);
  });

  it("bounds the shop save fields", () => {
    const out = sanitizeProgress({ indexClaimed: ["golden"], baseSkin: "ice", treadmills: ["t1", "Bad Id!"], treadmill: "t2", balls: ["lucky"], ball: "lucky", moneyBoostUntil: 1e18 })!;
    assert.strictEqual(out.baseSkin, undefined, "a locked skin is dropped");
    assert.deepStrictEqual(out.treadmills, ["t1"]);
    assert.strictEqual(out.treadmill, undefined, "not owned");
    assert.strictEqual(out.ball, "lucky");
    assert.ok(out.moneyBoostUntil! <= Date.now() + 86_400_001);
    assert.strictEqual(sanitizeProgress({ fuse: { rarity: "Primal" } })!.fuse, undefined, "never saved by the client");
  });
});

describe("fuse machine room", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  it("starts one fusion, refuses an early claim and stores the job", async () => {
    const fake = fakePlayers([{ _id: "f1", money: 5, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: "f1" });
    const got: any[] = [];
    let view: any = null;
    for (const t of ["progress", "spins", "daily", "playtime", "quests", "leaderboard"]) c.onMessage(t, () => {});
    c.onMessage("fuse", (m: any) => (view = m));
    c.onMessage("fuseResult", (m: any) => got.push(m));
    fake.release();
    await sleep(150);
    assert.deepStrictEqual(view?.fusing, null);

    c.send("fuseStart", { inputs: four("Common") });
    await sleep(100);
    c.send("fuseStart", { inputs: four("Common") });
    c.send("fuseClaim");
    await sleep(150);
    assert.ok(got[0].ok && got[0].fusing.readyAt > Date.now());
    assert.strictEqual(got[0].result, undefined, "the result stays hidden until claimed");
    assert.deepStrictEqual([got[1].ok, got[1].reason], [false, "busy"]);
    assert.deepStrictEqual([got[2].ok, got[2].reason], [false, "wait"]);
    assert.ok((fake.docs.get("f1") as any)?.fuse?.rarity);
    assert.strictEqual(fake.docs.get("f1")?.money, 5);
  });
});
