import app from "./server";
import { getDb } from "./db";

const PORT = parseInt(process.env.PORT || "3456");

// Init DB on startup
getDb();

console.log(`
╔══════════════════════════════════════╗
║        LLM Gateway v1.0.0            ║
║   http://localhost:${PORT}/ui        ║
╚══════════════════════════════════════╝
`);

export default {
  port: PORT,
  fetch: app.fetch,
};
