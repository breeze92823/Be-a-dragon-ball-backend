import { Room, Client, CloseCode } from "colyseus";
import { WorldState, PlayerState } from "./schema/WorldState.js";
import { BASE_COUNT, DISTANCE_MAX, GUEST_ID_PREFIX, LEADERBOARD_EVERY_MS, NAME_MAX, PFP_MAX_LEN, QUEST_TICK_MS, RECONNECT_SECONDS, ROOM_MAX_CLIENTS } from "../constants.js";
import { getPlayers, type PlayerDoc } from "../db.js";
import { sanitizeProgress } from "../sanitize.js";
import { accrue, rollWedge, spinStateFrom, type SpinState } from "../spin.js";
import { claimDaily, dailyFields, dailyView, readDaily, rollDaily, utcDay, type DailyState } from "../daily.js";
import { bankPlaytime, claimPlaytime, playtimeFields, playtimeView, readPlaytime, rollPlaytime, type PlaytimeState } from "../playtime.js";
import { addQuestProgress, claimQuests, questFields, questView, readQuests, rerollQuest, rollQuests, type QuestState } from "../quests.js";
import { fuseView, readFuse, readInputs, rollFusion, type FuseJob } from "../fuse.js";
import { SPIN_PACKS, SPINS_MAX } from "../constants.js";
import { applyAvatar, applyLoadout, applyPose } from "../presence.js";
import { ranksOf, topBoards } from "../leaderboard.js";
import { forgetBadges, loadOwnedBadges, markOffline, markOnline, trustClientIds, verifyAdToken, verifyGameToken, type VerifiedUser } from "../boxity.js";

function sanitizeName(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, NAME_MAX) : "";
}

function sanitizePfp(raw: unknown): string {
  return typeof raw === "string" && raw.length <= PFP_MAX_LEN && /^https?:\/\//i.test(raw) ? raw : "";
}

/**
 * Room every client joins via `client.joinOrCreate("world", { userId, username })`. Loads and
 * saves each signed-in player's progress (MongoDB, see db.ts) -- the client keeps no save of its
 * own, so this is the only place progress lives. The game is client-authoritative: no gameplay
 * rules live here, saves are only bounded (sanitize.ts). Full rooms spill into a fresh one
 * automatically (maxClients).
 */
export class WorldRoom extends Room<{ state: WorldState }> {
  state = new WorldState();
  maxClients = ROOM_MAX_CLIENTS;

  // sessionId -> user id (Bloxity id). Deliberately NOT part of WorldState: it only gates this
  // room's own Mongo reads/writes. Guests have no entry.
  userIds = new Map<string, string>();

  // sessionIds that already got a progress/noProgress answer for their current identity.
  private identified = new Set<string>();
  // sessionIds whose current identity's save has been read: only these may write. A save sent
  // before the load answered would overwrite the stored progress with a fresh player's defaults.
  private loaded = new Set<string>();
  // sessionId -> Spin wheel state (spin.ts), set once the session's save has been read. Kept for
  // guests and serverless sessions too (it then lasts the connection).
  private spinStates = new Map<string, SpinState>();
  // sessionId -> Daily Reward state (daily.ts), read with the save. Guests and serverless sessions
  // keep theirs here only (like the rest of their progress, it lasts the session).
  private dailies = new Map<string, DailyState>();
  // sessionId -> Playtime Rewards clock (playtime.ts) and Daily Quests (quests.ts), read with the
  // save. Like the Daily Reward, guests / serverless sessions keep them for the connection only.
  private playtimes = new Map<string, PlaytimeState>();
  private questStates = new Map<string, QuestState>();
  // sessionId -> the running Fuse Machine job (fuse.ts) or null, read with the save.
  private fusions = new Map<string, FuseJob | null>();

  messages = {
    // Debounced push of the client's whole progress. Upserts, so a first save creates the document.
    saveProgress: async (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      const patch = sanitizeProgress(msg);
      if (!p || !patch || !this.loaded.has(client.sessionId)) return;

      const userId = this.userIds.get(client.sessionId);
      if (!userId) return;
      const players = getPlayers();
      if (!players) return; // Mongo unset/unreachable -- degrade silently
      // The personal best only ever goes up ($max), so a stale or replayed save can't lower it.
      const { bestDistance, ...rest } = patch;
      try {
        await players.updateOne(
          { _id: userId },
          {
            // Display name comes from this connection's own PlayerState, not `msg`.
            $set: { ...rest, username: p.username || "Player", updatedAt: new Date() },
            ...(bestDistance !== undefined && { $max: { bestDistance } }),
            $setOnInsert: { version: 1 },
          },
          { upsert: true },
        );
      } catch (err) {
        console.warn("[WorldRoom] saveProgress failed", err);
      }
    },
    // Claims Daily Reward day `msg.day` (0-based). The server decides: answers `dailyResult`
    // { ok, day, ...state }; the client only grants the reward on ok.
    claimDaily: async (client: Client, msg: { day?: unknown }) => {
      const s = this.dailies.get(client.sessionId);
      const day = msg?.day;
      if (!s || !this.loaded.has(client.sessionId)) return client.send("dailyResult", { ok: false, day, reason: "loading" });
      if (rollDaily(s)) void this.saveDaily(client.sessionId, s); // midnight passed while online
      if (!claimDaily(s, day)) return client.send("dailyResult", { ok: false, day, reason: "locked", ...dailyView(s) });
      if (!(await this.saveDaily(client.sessionId, s))) {
        s.claimed = s.claimed.filter((i) => i !== day); // not stored: not claimed
        return client.send("dailyResult", { ok: false, day, reason: "save", ...dailyView(s) });
      }
      client.send("dailyResult", { ok: true, day, ...dailyView(s) });
    },
    // The client's countdown reached the next UTC day: unlock it (server clock) and answer `daily`.
    dailyRefresh: (client: Client) => {
      const s = this.dailies.get(client.sessionId);
      if (!s || !this.loaded.has(client.sessionId)) return;
      if (rollDaily(s)) void this.saveDaily(client.sessionId, s);
      client.send("daily", dailyView(s));
    },
    // Playtime Rewards: claims reward `msg.i` once the server's clock says it is unlocked.
    // Answers `playtimeResult` { ok, i, reason?: "loading" | "locked" | "save", ...view }.
    claimPlaytime: async (client: Client, msg: { i?: unknown }) => {
      const s = this.playtimes.get(client.sessionId);
      const i = msg?.i;
      if (!s || !this.loaded.has(client.sessionId)) return client.send("playtimeResult", { ok: false, i, reason: "loading" });
      const now = Date.now();
      rollPlaytime(s, now);
      if (!claimPlaytime(s, i, now)) return client.send("playtimeResult", { ok: false, i, reason: "locked", ...playtimeView(s, now) });
      if (!(await this.saveFields(client.sessionId, playtimeFields(s, now)))) {
        s.claimed = s.claimed.filter((c) => c !== i);
        return client.send("playtimeResult", { ok: false, i, reason: "save", ...playtimeView(s) });
      }
      client.send("playtimeResult", { ok: true, i, ...playtimeView(s) });
    },
    // Daily Quests progress the client saw happen: { kind: "hatch" | "mutated" | "sell", n }.
    // (`play` minutes are counted here, see onCreate.) Answers `quests` when something moved.
    questEvent: (client: Client, msg: { kind?: unknown; n?: unknown }) => {
      const s = this.questStates.get(client.sessionId);
      if (!s || !this.loaded.has(client.sessionId) || msg?.kind === "play") return;
      if (rollQuests(s)) void this.saveFields(client.sessionId, questFields(s));
      if (!addQuestProgress(s, msg?.kind, msg?.n)) return;
      void this.saveFields(client.sessionId, questFields(s));
      client.send("quests", questView(s));
    },
    // { action: "reroll", i } swaps an unfinished quest (once per quest a day); { action: "claim",
    // skip } takes today's reward (skip = the client paid $ instead of finishing). Answers
    // `questResult` { ok, action, i?, reason?, ...view }.
    questAction: async (client: Client, msg: { action?: unknown; i?: unknown; skip?: unknown }) => {
      const s = this.questStates.get(client.sessionId);
      const action = msg?.action === "claim" ? "claim" : "reroll";
      if (!s || !this.loaded.has(client.sessionId)) return client.send("questResult", { ok: false, action, i: msg?.i, reason: "loading" });
      rollQuests(s);
      const before = questFields(s).quests;
      const ok = action === "claim" ? claimQuests(s, msg?.skip) : rerollQuest(s, msg?.i);
      if (!ok) return client.send("questResult", { ok: false, action, i: msg?.i, reason: "locked", ...questView(s) });
      if (!(await this.saveFields(client.sessionId, questFields(s)))) {
        Object.assign(s, before); // not stored: not done
        return client.send("questResult", { ok: false, action, i: msg?.i, reason: "save", ...questView(s) });
      }
      client.send("questResult", { ok: true, action, i: msg?.i, ...questView(s) });
    },
    // The windows (re)attached after the load answered: send the playtime / quests / daily views.
    uiSync: (client: Client) => {
      if (!this.loaded.has(client.sessionId)) return;
      const now = Date.now();
      const pt = this.playtimes.get(client.sessionId);
      const q = this.questStates.get(client.sessionId);
      const d = this.dailies.get(client.sessionId);
      if (pt) client.send("playtime", playtimeView(pt, now));
      if (q) client.send("quests", questView(q, now));
      if (d) client.send("daily", dailyView(d, now));
      if (this.fusions.has(client.sessionId)) client.send("fuse", fuseView(this.fusions.get(client.sessionId) ?? null, now));
      const sp = this.spinStates.get(client.sessionId);
      if (sp) client.send("spins", this.spinView(sp, now));
    },
    // The client's countdown reached the next UTC day: new quests + a fresh playtime clock.
    dayRefresh: (client: Client) => {
      if (this.loaded.has(client.sessionId)) this.rollDay(client);
    },
    // Spin wheel: uses one spin and rolls the prize here, so the client can't choose it. Answers
    // `spinResult` { ok, id (SPIN_WEDGES id), spins, nextAt, serverTime } or { ok: false, reason }.
    spin: async (client: Client) => {
      const s = this.spinStates.get(client.sessionId);
      if (!s) return client.send("spinResult", { ok: false, reason: "loading" });
      const now = Date.now();
      accrue(s, now);
      if (s.spins < 1) return client.send("spinResult", { ok: false, reason: "none", ...this.spinView(s, now) });
      s.spins--;
      accrue(s, now); // dropping below the cap starts the free-spin clock
      const wedge = rollWedge();
      client.send("spinResult", { ok: true, id: wedge.id, ...this.spinView(s, now) });
      await this.saveSpins(client.sessionId, s);
    },
    // Spin packs bought with $ on the client (never premium currency): `buySpins` { pack } adds
    // SPIN_PACKS[pack] spins and answers `spins`.
    buySpins: async (client: Client, msg: { pack?: unknown }) => {
      const s = this.spinStates.get(client.sessionId);
      const n = Number.isInteger(msg?.pack) ? SPIN_PACKS[msg.pack as number] : undefined;
      if (!s || !n) return;
      const now = Date.now();
      accrue(s, now);
      s.spins = Math.min(SPINS_MAX, s.spins + n);
      client.send("spins", this.spinView(s, now));
      await this.saveSpins(client.sessionId, s);
    },
    // Fuse Machine: `fuseStart` { inputs: [{ rarity, mutation }] x FUSE_INPUTS } rolls the result
    // here and starts the timer; `fuseClaim` hands it over once ready. Both answer `fuseResult`
    // { ok, action, reason?: "loading" | "busy" | "bad" | "wait" | "none" | "save", result?, ...view }.
    fuseStart: async (client: Client, msg: { inputs?: unknown }) => {
      const sid = client.sessionId;
      const now = Date.now();
      if (!this.loaded.has(sid) || !this.fusions.has(sid)) return client.send("fuseResult", { ok: false, action: "start", reason: "loading" });
      const running = this.fusions.get(sid);
      if (running) return client.send("fuseResult", { ok: false, action: "start", reason: "busy", ...fuseView(running, now) });
      const inputs = readInputs(msg?.inputs);
      if (!inputs) return client.send("fuseResult", { ok: false, action: "start", reason: "bad", ...fuseView(null, now) });
      const job = rollFusion(inputs, now);
      this.fusions.set(sid, job);
      if (!(await this.saveFields(sid, { fuse: job }))) {
        this.fusions.set(sid, null);
        return client.send("fuseResult", { ok: false, action: "start", reason: "save", ...fuseView(null, now) });
      }
      client.send("fuseResult", { ok: true, action: "start", ...fuseView(job, now) });
    },
    fuseClaim: async (client: Client) => {
      const sid = client.sessionId;
      const now = Date.now();
      const job = this.fusions.get(sid);
      if (!this.loaded.has(sid) || job === undefined) return client.send("fuseResult", { ok: false, action: "claim", reason: "loading" });
      if (!job) return client.send("fuseResult", { ok: false, action: "claim", reason: "none", ...fuseView(null, now) });
      if (now < job.readyAt) return client.send("fuseResult", { ok: false, action: "claim", reason: "wait", ...fuseView(job, now) });
      this.fusions.set(sid, null);
      if (!(await this.saveFields(sid, { fuse: null }))) {
        this.fusions.set(sid, job);
        return client.send("fuseResult", { ok: false, action: "claim", reason: "save", ...fuseView(job, now) });
      }
      client.send("fuseResult", { ok: true, action: "claim", result: { rarity: job.rarity, mutation: job.mutation, pick: job.pick }, ...fuseView(null, now) });
    },
    // The sender's race, relayed through the roster so everyone draws them on the distance bar and
    // podium: { racing, distance (studs this race) }, a few times a second while racing.
    race: (client: Client, msg: { racing?: unknown; distance?: unknown }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.racing = msg?.racing === true;
      const d = msg?.distance;
      p.distance = p.racing && typeof d === "number" && Number.isFinite(d) ? Math.min(DISTANCE_MAX, Math.max(0, d)) : 0;
    },
    // Presence (presence.ts): the sender's pose ~10x/s, its equipped gear and its Bloxity look,
    // relayed through the roster so everyone draws them in the world (client remotePlayers.js).
    pose: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyPose(p, msg);
    },
    loadout: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyLoadout(p, msg);
    },
    setAvatar: (client: Client, msg: unknown) => {
      const p = this.state.players.get(client.sessionId);
      if (p) applyAvatar(p, msg);
    },
    // Re-states identity after a login/logout that happens AFTER join (a guest who signs in
    // mid-session). The server answers with progress/noProgress for the new identity.
    identify: async (client: Client, msg: { username?: string; userId?: string; pfp?: string; token?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof msg?.username === "string") p.username = sanitizeName(msg.username);
      if (typeof msg?.pfp === "string") p.pfp = sanitizePfp(msg.pfp);
      // A new identity (sign in / out mid-session) is only taken from a verified Boxity token.
      if (typeof msg?.token === "string" || typeof msg?.userId === "string") {
        const id = await this.resolveIdentity(client.sessionId, msg);
        if (this.state.players.get(client.sessionId) === p) this.setUserId(client, p, id);
      }
    },
    // Rewarded ad (Legion.SDK.ads.showRewarded): Boxity checks the single-use token, then one extra
    // Dragon Spin is added. Answers `spins` (or `adResult` { ok: false } when refused).
    adSpin: async (client: Client, msg: { rewardToken?: unknown }) => {
      const s = this.spinStates.get(client.sessionId);
      if (!s) return client.send("adResult", { ok: false, reason: "loading" });
      if (!(await verifyAdToken(msg?.rewardToken)) && !trustClientIds()) return client.send("adResult", { ok: false, reason: "refused" });
      const now = Date.now();
      accrue(s, now);
      s.spins = Math.min(SPINS_MAX, s.spins + 1);
      client.send("spins", this.spinView(s, now));
      client.send("adResult", { ok: true });
      await this.saveSpins(client.sessionId, s);
    },
  };

  // Leaderboards (leaderboard.ts): everyone gets the top lists + their own ranks every
  // LEADERBOARD_EVERY_MS, and once right after their save loads.
  onCreate() {
    this.clock.setInterval(() => {
      for (const c of this.clients) void this.sendLeaderboard(c);
    }, LEADERBOARD_EVERY_MS);
    // Every minute online: the `play` quests move, the playtime clock is banked (so a crash loses at
    // most a minute), and a UTC midnight passed meanwhile starts the new day.
    this.clock.setInterval(() => {
      for (const c of this.clients) this.minuteTick(c);
    }, QUEST_TICK_MS);
  }

  private minuteTick(client: Client) {
    const sid = client.sessionId;
    const q = this.questStates.get(sid);
    const pt = this.playtimes.get(sid);
    if (!q || !pt || !this.loaded.has(sid)) return;
    this.rollDay(client);
    const moved = addQuestProgress(q, "play", 1);
    bankPlaytime(pt);
    void this.saveFields(sid, { ...playtimeFields(pt), ...questFields(q) });
    if (moved) client.send("quests", questView(q));
  }

  // A new UTC day for the session's quests and playtime clock: re-sends both when they rolled.
  private rollDay(client: Client) {
    const sid = client.sessionId;
    const q = this.questStates.get(sid);
    const pt = this.playtimes.get(sid);
    if (!q || !pt) return;
    const now = Date.now();
    const quests = rollQuests(q, utcDay(now));
    const clock = rollPlaytime(pt, now);
    if (!quests && !clock) return;
    void this.saveFields(sid, { ...questFields(q), ...playtimeFields(pt, now) });
    client.send("quests", questView(q, now));
    client.send("playtime", playtimeView(pt, now));
  }

  // `leaderboard` { boards: { rebirths|trophies|energy|playtime: [{ name, value }] }, ranks: { stat: n | null } }.
  private async sendLeaderboard(client: Client) {
    const userId = this.userIds.get(client.sessionId) ?? "";
    const [boards, ranks] = await Promise.all([topBoards(), ranksOf(userId)]);
    if (!this.state.players.has(client.sessionId)) return;
    try {
      client.send("leaderboard", { boards, ranks });
    } catch {
      // Gone meanwhile.
    }
  }

  async onJoin(client: Client, options?: { username?: string; userId?: string; token?: string; pfp?: string; pose?: unknown; loadout?: unknown; avatar?: string }) {
    const p = new PlayerState();
    p.username = sanitizeName(options?.username);
    p.pfp = sanitizePfp(options?.pfp);
    // Presence from the join options, so the others draw the newcomer right away.
    applyPose(p, options?.pose);
    applyLoadout(p, options?.loadout);
    applyAvatar(p, options);
    this.state.players.set(client.sessionId, p);
    this.assignBase(client, p, (options as { base?: unknown } | undefined)?.base);
    const id = await this.resolveIdentity(client.sessionId, options);
    if (this.state.players.get(client.sessionId) === p) this.setUserId(client, p, id);
  }

  // One base per player (the client's safe zone has BASE_COUNT plots). A player gets the base it asked
  // for (`base` in the join options: the one it already built its world around) when it is free, else
  // the lowest free one; it is told with `base` { index } and the roster carries it (`PlayerState.base`).
  private assignBase(client: Client, p: PlayerState, want: unknown) {
    const taken = new Set<number>();
    this.state.players.forEach((o, sid) => {
      if (sid !== client.sessionId && o.base >= 0) taken.add(o.base);
    });
    let index = Number.isInteger(want) && (want as number) >= 0 && (want as number) < BASE_COUNT && !taken.has(want as number) ? (want as number) : -1;
    for (let i = 0; index < 0 && i < BASE_COUNT; i++) if (!taken.has(i)) index = i;
    p.base = index; // -1 only if the room is over capacity (cannot happen: maxClients = BASE_COUNT)
    client.send("base", { index });
  }

  // Boxity-verified identities of this room's sessions (name + guest saves they carry over).
  private verified = new Map<string, VerifiedUser>();

  // The account id of a join / identify: a Boxity token checked with the platform (its verified name
  // and picture replace the client's), or -- only with TRUST_CLIENT_IDS (local dev, tests) -- the id
  // the client sent. Anything else is a guest ("").
  private async resolveIdentity(sessionId: string, opts?: { token?: unknown; userId?: unknown; username?: unknown }): Promise<string> {
    this.verified.delete(sessionId);
    const own = this.state.players.get(sessionId);
    if (own) {
      own.uid = "";
      own.handle = "";
    }
    if (typeof opts?.token === "string" && opts.token) {
      const u = await verifyGameToken(opts.token);
      if (u) {
        this.verified.set(sessionId, u);
        const p = this.state.players.get(sessionId);
        if (p) {
          p.username = sanitizeName(u.username);
          if (u.pfp) p.pfp = sanitizePfp(u.pfp);
          p.handle = u.handle;
          p.uid = u.id; // public: the Boxity id chat messages carry
          if (u.outfitKey) p.avatar = u.outfitKey; // prefer the platform-verified look
        }
        return u.id;
      }
      return "";
    }
    return trustClientIds() && typeof opts?.userId === "string" ? opts.userId : "";
  }

  // A deliberate `room.leave()` closes with CONSENTED -- drop the player at once. Anything
  // else (WiFi blip, backgrounded tab) gets RECONNECT_SECONDS to reconnect with the same session.
  async onLeave(client: Client, code?: number) {
    if (code === CloseCode.CONSENTED) {
      void this.stampLastSeen(client.sessionId);
      void this.bankOnLeave(client.sessionId);
      this.forgetSession(client.sessionId);
      return;
    }
    try {
      await this.allowReconnection(client, RECONNECT_SECONDS);
    } catch {
      void this.stampLastSeen(client.sessionId);
      void this.bankOnLeave(client.sessionId);
      this.forgetSession(client.sessionId);
    }
  }

  // Stores the time played today when a player really leaves (or switches identity). Call before
  // forgetSession: the write reads the session's user id synchronously.
  private async bankOnLeave(sessionId: string) {
    const pt = this.playtimes.get(sessionId);
    if (!pt) return;
    bankPlaytime(pt);
    await this.saveFields(sessionId, playtimeFields(pt));
  }

  // Server-clock "last seen" for a player who has really gone. Call before forgetSession.
  private async stampLastSeen(sessionId: string) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    try {
      await players.updateOne({ _id: userId }, { $set: { lastSeen: Date.now() } });
    } catch (err) {
      console.warn("[WorldRoom] stampLastSeen failed", err);
    }
  }

  // Drops a session's per-connection bookkeeping.
  private forgetSession(sessionId: string) {
    const id = this.userIds.get(sessionId);
    if (id) {
      markOffline(id);
      forgetBadges(id);
    }
    this.verified.delete(sessionId);
    this.state.players.delete(sessionId);
    this.userIds.delete(sessionId);
    this.identified.delete(sessionId);
    this.loaded.delete(sessionId);
    this.dailies.delete(sessionId);
    this.spinStates.delete(sessionId);
    this.playtimes.delete(sessionId);
    this.questStates.delete(sessionId);
    this.fusions.delete(sessionId);
  }

  private spinView(s: SpinState, now: number) {
    return { spins: s.spins, nextAt: s.nextAt, serverTime: now };
  }

  // The spin fields go straight to Mongo (saveProgress never carries them).
  private async saveSpins(sessionId: string, s: SpinState) {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return;
    try {
      await players.updateOne(
        { _id: userId },
        { $set: { spins: s.spins, spinAt: s.nextAt, updatedAt: new Date() }, $setOnInsert: { version: 1 } },
        { upsert: true },
      );
    } catch (err) {
      console.warn("[WorldRoom] saveSpins failed", err);
    }
  }

  // Stores a session's Daily Reward state. True when stored, or when there is nowhere to store it
  // (guest / no database: it lives in `dailies` for the session).
  private saveDaily(sessionId: string, s: DailyState): Promise<boolean> {
    return this.saveFields(sessionId, dailyFields(s));
  }

  // Writes server-owned fields (daily, playtime, quests) straight to the player's doc. True when
  // stored, or when there is nowhere to store them (guest / no database: they live in memory).
  private async saveFields(sessionId: string, fields: Partial<PlayerDoc>): Promise<boolean> {
    const userId = this.userIds.get(sessionId);
    const players = getPlayers();
    if (!userId || !players) return true;
    try {
      await players.updateOne({ _id: userId }, { $set: { ...fields, updatedAt: new Date() }, $setOnInsert: { version: 1 } }, { upsert: true });
      return true;
    } catch (err) {
      console.warn("[WorldRoom] saveFields failed", err);
      return false;
    }
  }

  // The verified Boxity account id (see resolveIdentity; guest ids are dropped, see GUEST_ID_PREFIX).
  // Called from both onJoin and `identify`; answers with progress / noProgress / serverError.
  private setUserId(client: Client, p: PlayerState, raw: string) {
    let userId = raw.slice(0, 128);
    // Guests (client-made `guest-...` ids) get no identity: nothing is loaded or saved for them.
    if (userId.startsWith(GUEST_ID_PREFIX)) userId = "";
    const prev = this.userIds.get(client.sessionId) || "";
    // No change (e.g. a username-only identify) -- but the very first call must still answer.
    if (userId === prev && this.identified.has(client.sessionId)) return;
    this.identified.add(client.sessionId);
    this.loaded.delete(client.sessionId); // no writes until the new identity's save is read
    this.spinStates.delete(client.sessionId); // nor spins
    this.fusions.delete(client.sessionId); // nor fusions
    if (prev !== userId) void this.bankOnLeave(client.sessionId); // the old identity keeps its time today
    p.signedIn = !!userId;

    if (userId) {
      // Evict any OTHER live session already claiming this account, so one account never has
      // two racing Mongo writers (a crashed tab lingers up to RECONNECT_SECONDS via
      // allowReconnection in onLeave).
      for (const [sid, uid] of this.userIds) {
        if (sid === client.sessionId || uid !== userId) continue;
        this.forgetSession(sid);
        const stale = this.clients.find((c) => c.sessionId === sid);
        if (stale) {
          try {
            stale.leave(CloseCode.CONSENTED);
          } catch {
            // Already gone -- nothing to clean up.
          }
        }
      }
      if (prev && prev !== userId) {
        markOffline(prev);
        forgetBadges(prev);
      }
      this.userIds.set(client.sessionId, userId);
      markOnline(userId);
      void loadOwnedBadges(userId);
    } else {
      // No identity: stop persisting for this connection. (The client flushes a final
      // saveProgress under the OLD id before sending `identify`.)
      if (prev) {
        markOffline(prev);
        forgetBadges(prev);
      }
      this.userIds.delete(client.sessionId);
    }

    void this.loadProgress(client, userId, p);
  }

  // A Boxity player who signs in to an account with no progress here brings the save of the guest
  // they played as (verify's `carriedFrom`): the first unused guest save is copied once, then marked
  // used so it can never seed a second account. An account that already has progress is untouched.
  private async carryOverGuest(sessionId: string, userId: string, players: NonNullable<ReturnType<typeof getPlayers>>): Promise<PlayerDoc | null> {
    for (const guestId of this.verified.get(sessionId)?.carriedFrom ?? []) {
      if (guestId === userId) continue;
      const g = await players.findOne({ _id: guestId });
      if (!g || (g as any).carriedTo) continue;
      const { _id, carriedTo, ...rest } = g as any;
      const claimed = await players.updateOne({ _id: guestId, carriedTo: { $exists: false } } as any, { $set: { carriedTo: userId } });
      if (!claimed.modifiedCount) continue;
      await players.updateOne({ _id: userId }, { $set: { ...rest, updatedAt: new Date() }, $setOnInsert: { version: 1 } }, { upsert: true });
      return (await players.findOne({ _id: userId })) ?? null;
    }
    return null;
  }

  // Sends the saved doc to just this client so it can hydrate its state ("progress"), or
  // "noProgress" when there is nothing to load (new account, guest, or Mongo unset). A failed read
  // sends "serverError" and keeps saving off, so a save that could not be read is never overwritten.
  private async loadProgress(client: Client, userId: string, p: PlayerState) {
    const players = getPlayers();
    let doc: PlayerDoc | null = null;
    if (userId && players) {
      try {
        doc = await players.findOne({ _id: userId });
        if (!doc) doc = await this.carryOverGuest(client.sessionId, userId, players);
      } catch (err) {
        console.warn("[WorldRoom] loadProgress failed", err);
        client.send("serverError", {});
        return;
      }
    }
    // The player may have left, or switched identity again, while the read was in flight.
    if (this.state.players.get(client.sessionId) !== p || (this.userIds.get(client.sessionId) ?? "") !== userId) return;

    this.loaded.add(client.sessionId);
    const now = Date.now();
    const spin = spinStateFrom(doc, now);
    this.spinStates.set(client.sessionId, spin);
    if (!doc) client.send("noProgress", { serverTime: now });
    else client.send("progress", { ...(sanitizeProgress(doc) ?? {}), serverTime: now });
    client.send("spins", this.spinView(spin, now));
    const job = readFuse(doc);
    this.fusions.set(client.sessionId, job);
    client.send("fuse", fuseView(job, now));

    // Daily Reward: today's day unlocks on join (server clock), then the client gets the calendar.
    const daily = readDaily(doc);
    this.dailies.set(client.sessionId, daily);
    if (rollDaily(daily)) await this.saveDaily(client.sessionId, daily);
    if (this.dailies.get(client.sessionId) !== daily) return; // identity changed meanwhile
    client.send("daily", dailyView(daily));

    // Playtime Rewards + Daily Quests: today's clock and list (server clock).
    const pt = readPlaytime(doc, now);
    const quests = readQuests(doc);
    this.playtimes.set(client.sessionId, pt);
    this.questStates.set(client.sessionId, quests);
    if (rollQuests(quests)) void this.saveFields(client.sessionId, questFields(quests));
    client.send("playtime", playtimeView(pt, now));
    client.send("quests", questView(quests, now));
    void this.sendLeaderboard(client);
  }
}
