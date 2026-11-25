import { listen } from "@colyseus/tools";

import app from "./app.config.js";
import { connectDb } from "./db.js";
import { installReporters, installRoomReporter } from "./boxity.js";

// Player-progress persistence (src/db.ts) connects before the room accepts
// players; connectDb() itself never throws or hangs (degrades to "no persistence").
await connectDb();

// Listens on PORT (or 2567).
await listen(app);
// No-ops outside a Boxity deployment (they need BLOXITY_REPORT_TOKEN / BLOXITY_GAME_ID).
installRoomReporter();
installReporters();
