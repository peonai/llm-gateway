import { Hono } from "hono";
import { cors } from "hono/cors";
import api from "./api";
import { routeRequest } from "./router";
import { getApiKeyByKey, incrementApiKeyUsage, listApiKeys, listModels } from "./db";

const isBun = typeof globalThis.Bun !== "undefined";

const serveStatic = isBun
  ? (await import("hono/bun")).serveStatic
  : (await import("@hono/node-server/serve-static")).serveStatic;

const app = new Hono();

// CORS
app.use("*", cors());

// Health check (no auth needed)
const startedAt = Date.now();
app.get("/health", (c) => c.json({ ok: true, uptimeMs: Date.now() - startedAt }));

// --- Admin auth middleware for management API ---
// Uses ADMIN_KEY env var. If not set, allows all (local dev mode).
const ADMIN_KEY = process.env.ADMIN_KEY || "";

app.use("/api/*", async (c, next) => {
  if (!ADMIN_KEY) return next(); // No admin key configured = open mode (local only)

  const auth = c.req.header("Authorization") || "";
  const xKey = c.req.header("x-admin-key") || "";
  const queryKey = c.req.query("admin_key") || "";

  if (auth === `Bearer ${ADMIN_KEY}` || xKey === ADMIN_KEY || queryKey === ADMIN_KEY) {
    return next();
  }

  return c.json({ error: { message: "Unauthorized: admin key required", type: "authentication_error" } }, 401);
});

// Management API
app.route("/api", api);

// --- API Key auth middleware for proxy endpoints ---
app.use("/v1/*", async (c, next) => {
  // If no API keys exist, allow all (open mode)
  const keys = listApiKeys() as any[];
  if (keys.length === 0) {
    return next();
  }

  // Extract key from Authorization header or x-api-key
  let apiKey = "";
  const authHeader = c.req.header("Authorization") || "";
  if (authHeader.startsWith("Bearer gw-")) {
    apiKey = authHeader.replace("Bearer ", "");
  }
  const xApiKey = c.req.header("x-api-key") || "";
  if (xApiKey.startsWith("gw-")) {
    apiKey = xApiKey;
  }

  if (!apiKey) {
    // API keys exist but none provided — reject
    return c.json({ error: { message: "API key required. Use 'Authorization: Bearer gw-...' or 'x-api-key: gw-...'", type: "authentication_error" } }, 401);
  }

  const keyRecord: any = getApiKeyByKey(apiKey);
  if (!keyRecord) {
    return c.json({ error: { message: "Invalid API key", type: "authentication_error" } }, 401);
  }
  if (!keyRecord.enabled) {
    return c.json({ error: { message: "API key disabled", type: "authentication_error" } }, 403);
  }

  // Check allowed models
  if (keyRecord.allowedModels) {
    const body = await c.req.json();
    const allowed = keyRecord.allowedModels.split(",").map((s: string) => s.trim()).filter(Boolean);
    if (allowed.length > 0 && body.model && !allowed.includes(body.model)) {
      return c.json({ error: { message: `Model "${body.model}" not allowed for this key`, type: "permission_error" } }, 403);
    }
  }

  // Track usage
  incrementApiKeyUsage(apiKey);

  return next();
});

// --- Proxy endpoints ---

// OpenAI compatible
app.post("/v1/chat/completions", async (c) => {
  const body = await c.req.json();
  const modelName = body.model;
  const isStreaming = body.stream === true;
  if (!modelName) {
    return c.json({ error: { message: "model is required", type: "invalid_request_error" } }, 400);
  }
  return routeRequest(modelName, "/v1/chat/completions", "POST", c.req.raw.headers, body, isStreaming);
});

// Anthropic compatible
app.post("/v1/messages", async (c) => {
  const body = await c.req.json();
  const modelName = body.model;
  const isStreaming = body.stream === true;
  if (!modelName) {
    return c.json({ error: { message: "model is required", type: "invalid_request_error" } }, 400);
  }
  return routeRequest(modelName, "/v1/messages", "POST", c.req.raw.headers, body, isStreaming);
});

// OpenAI models list
app.get("/v1/models", (c) => {
  const models = listModels().map((m: any) => ({
    id: m.name,
    object: "model",
    created: Math.floor(m.createdAt / 1000),
    owned_by: "llm-gateway",
  }));
  return c.json({ object: "list", data: models });
});

// Static files (UI)
app.use("/ui/*", serveStatic({ root: "./public", rewriteRequestPath: (path: string) => path.replace("/ui", "") }));
app.get("/ui", serveStatic({ root: "./public", path: "/index.html" }));

// Root redirect
app.get("/", (c) => c.redirect("/ui"));

export default app;
