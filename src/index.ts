import app from "./server";
import { getDb } from "./db";

const PORT = parseInt(process.env.PORT || "3456");
const isBun = typeof globalThis.Bun !== "undefined";

// Init DB on startup
getDb();

console.log(`
╔══════════════════════════════════════╗
║        LLM Gateway v1.0.0            ║
║   http://localhost:${PORT}/ui        ║
╚══════════════════════════════════════╝
`);

if (!isBun) {
  const { serve } = require("@hono/node-server");
  serve({ fetch: app.fetch, port: PORT });
}

// Bun uses this default export
export default { 
  port: PORT, 
  fetch: app.fetch,
  // Bun enforces a maximum of 255 seconds, use 5 minutes only when
  // running under Node/tsx. 255 is roughly 4.25 minutes which is close
  // enough.
  idleTimeout: 255
};
