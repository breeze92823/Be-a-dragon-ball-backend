import { schema, t, type SchemaType } from "@colyseus/schema";

// The live roster: who is in the room. Durable progress lives in Mongo (src/db.ts).
// To sync something new about a player, add a field here and accept it in a WorldRoom message.
export const PlayerState = schema(
  {
    username: t.string().default(""), // client-reported Bloxity displayName/username, not validated
    signedIn: t.boolean().default(false), // has a Bloxity id: only signed-in players are saved
    pfp: t.string().default(""), // Bloxity profile picture URL ("" = none), for the others' racer heads
    racing: t.boolean().default(false), // in a race right now (`race` message)
    distance: t.float64().default(0), // this race's distance so far, studs
    // Presence (presence.ts, `pose` / `loadout` / `setAvatar`): what the others draw in the world.
    x: t.float64().default(0), // feet position in track coordinates (z minus the race scroll)
    y: t.float64().default(0),
    z: t.float64().default(0),
    yaw: t.float32().default(0), // heading, rad (PI = facing the gate)
    speed: t.float32().default(0), // m/s, for flames and dead reckoning
    boat: t.string().default(""), // equipped catalog ids (client config.js), "" = none / default
    engine: t.string().default(""),
    trail: t.string().default(""),
    partner: t.string().default(""),
    pets: t.string().default(""), // equipped pets "kind:tier,kind:tier"
    world: t.string().default(""), // the world the player is in (client WORLDS id), "" = the start world
    form: t.string().default(""), // how the others draw the player: "human" (default), "orb" (rolling the lane) or "fighter" (a hatched fighter running home)
    ball: t.string().default(""), // equipped Dragon Ball id (the orb's skin), "" = the starter one
    fighter: t.string().default(""), // look of the fighter being run home: "gi,pants,hair,skin,belt,boots,style,stance,cape" (colours #rrggbb)
    base: t.int32().default(-1), // the base (plot index) the server assigned this player: 0..BASE_COUNT-1, -1 = none yet
    multi: t.float32().default(1), // the base's Cash Multi, shown on its owner card
    baseSlots: t.string().default(""), // the fighters on the base's slots: looks (see `fighter`) joined by "|", "" = an empty slot
    look: t.string().default(""), // equipped Boxity item ids + proportions as JSON: draws the skin where the character kit is off
    held: t.string().default(""), // look of the fighter carried in front of the avatar, same format, "" = none
    avatar: t.string().default(""), // Boxity outfit key (the character kit dresses a rig with it), "" = default
    handle: t.string().default(""), // the verified Boxity username (the permanent handle): what Boxity matches friends by in playerJoined()
    uid: t.string().default(""), // verified Boxity account id ("" = guest): the others match chat bubbles to this player with it
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const WorldState = schema(
  {
    players: t.map(PlayerState), // keyed by sessionId
  },
  "WorldState",
);
export type WorldState = SchemaType<typeof WorldState>;
