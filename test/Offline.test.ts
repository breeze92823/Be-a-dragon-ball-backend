import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { OFFLINE_MAX_SECONDS } from "../src/constants.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("offline earnings", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  async function join(doc: Record<string, unknown>) {
    const fake = fakePlayers([{ version: 1, updatedAt: new Date(), ...doc } as any]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { userId: doc._id });
    let progress: any = null;
    c.onMessage("progress", (m: any) => (progress = m));
    fake.release();
    await sleep(150);
    return progress;
  }

  it("tells the client how long the player was away, on the server clock", async () => {
    const p = await join({ _id: "o1", lastSeen: Date.now() - 3600_000 });
    assert.ok(p.offlineSeconds >= 3599 && p.offlineSeconds <= 3605, `got ${p.offlineSeconds}`);
  });

  it("caps the away time and never goes negative", async () => {
    const long = await join({ _id: "o2", lastSeen: Date.now() - 30 * 24 * 3600_000 });
    assert.strictEqual(long.offlineSeconds, OFFLINE_MAX_SECONDS);
    await colyseus.cleanup();
    const future = await join({ _id: "o3", lastSeen: Date.now() + 3600_000 });
    assert.strictEqual(future.offlineSeconds, 0);
  });
});
