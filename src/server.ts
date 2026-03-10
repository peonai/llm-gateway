import { Hono } from "hono";
import { cors } from "hono/cors";
import api from "./api";
import { getStoredResponseModel, routeRequest, routeRetrieveResponse } from "./router";
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
    const allowed = keyRecord.allowedModels.split(",").map((s: string) => s.trim()).filter(Boolean);
    let requestModel = "";
    if (c.req.method === "GET" && c.req.path.startsWith("/v1/responses/")) {
      const responseId = c.req.path.split("/").pop() || "";
      requestModel = getStoredResponseModel(responseId) || "";
    } else if (!["GET", "HEAD"].includes(c.req.method)) {
      try {
        const body = await c.req.json();
        requestModel = body?.model || "";
      } catch {}
    }
    if (allowed.length > 0 && requestModel && !allowed.includes(requestModel)) {
      return c.json({ error: { message: `Model "${requestModel}" not allowed for this key`, type: "permission_error" } }, 403);
    }
  }

  // Track usage
  incrementApiKeyUsage(apiKey);

  return next();
});

// API Key auth for v1beta (Gemini native)
app.use("/v1beta/*", async (c, next) => {
  const keys = listApiKeys() as any[];
  if (keys.length === 0) return next();

  let apiKey = "";
  const authHeader = c.req.header("Authorization") || "";
  if (authHeader.startsWith("Bearer gw-")) {
    apiKey = authHeader.replace("Bearer ", "");
  }
  const xApiKey = c.req.header("x-api-key") || "";
  if (xApiKey.startsWith("gw-")) {
    apiKey = xApiKey;
  }
  // Also accept x-goog-api-key for Gemini native clients
  const xGoogKey = c.req.header("x-goog-api-key") || "";
  if (xGoogKey.startsWith("gw-")) {
    apiKey = xGoogKey;
  }

  if (!apiKey) {
    return c.json({ error: { message: "API key required", type: "authentication_error" } }, 401);
  }

  const keyRecord: any = getApiKeyByKey(apiKey);
  if (!keyRecord || !keyRecord.enabled) {
    return c.json({ error: { message: "Invalid or disabled API key", type: "authentication_error" } }, 401);
  }

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

// OpenAI Responses API compatible
app.post("/v1/responses", async (c) => {
  const body = await c.req.json();
  const modelName = body.model;
  const isStreaming = body.stream === true;
  if (!modelName) {
    return c.json({ error: { message: "model is required", type: "invalid_request_error" } }, 400);
  }
  return routeRequest(modelName, "/v1/responses", "POST", c.req.raw.headers, body, isStreaming);
});

app.get("/v1/responses/:response_id", async (c) => {
  const responseId = c.req.param("response_id");
  if (!responseId) {
    return c.json({ error: { message: "response_id is required", type: "invalid_request_error" } }, 400);
  }
  return routeRetrieveResponse(responseId);
});

app.post("/v1/embeddings", async (c) => {
  const body = await c.req.json();
  const modelName = body.model;
  if (!modelName) {
    return c.json({ error: { message: "model is required", type: "invalid_request_error" } }, 400);
  }
  return routeRequest(modelName, "/v1/embeddings", "POST", c.req.raw.headers, body, false);
});

app.post("/v1/rerank", async (c) => {
  const body = await c.req.json();
  const modelName = body.model;
  if (!modelName) {
    return c.json({ error: { message: "model is required", type: "invalid_request_error" } }, 400);
  }
  return routeRequest(modelName, c.req.path, "POST", c.req.raw.headers, body, false);
});

app.post("/v1/re-rank", async (c) => {
  const body = await c.req.json();
  const modelName = body.model;
  if (!modelName) {
    return c.json({ error: { message: "model is required", type: "invalid_request_error" } }, 400);
  }
  return routeRequest(modelName, "/v1/rerank", "POST", c.req.raw.headers, body, false);
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

// Gemini native endpoints (passthrough) - use wildcard to match :action pattern
app.post("/v1beta/models/*", async (c) => {
  const fullPath = c.req.path; // e.g. /v1beta/models/gemini-3.1-flash-image:generateContent
  const match = fullPath.match(/\/v1beta\/models\/([^:]+):(\w+)$/);
  if (!match) {
    return c.json({ error: { message: "Invalid Gemini API path", type: "invalid_request_error" } }, 400);
  }
  const modelName = match[1];
  const action = match[2];
  if (!modelName || !action) {
    return c.json({ error: { message: "Invalid Gemini API path", type: "invalid_request_error" } }, 400);
  }
  const body = await c.req.json();
  const isStreaming = action === "streamGenerateContent";
  return routeRequest(modelName, `/v1beta/models/${modelName}:${action}`, "POST", c.req.raw.headers, body, isStreaming);
});

// v1 variants
app.post("/v1/models/*", async (c) => {
  const fullPath = c.req.path;
  const match = fullPath.match(/\/v1\/models\/([^:]+):(\w+)$/);
  if (!match) {
    return c.json({ error: { message: "Invalid Gemini API path", type: "invalid_request_error" } }, 400);
  }
  const modelName = match[1];
  const action = match[2];
  if (!modelName || !action) {
    return c.json({ error: { message: "Invalid Gemini API path", type: "invalid_request_error" } }, 400);
  }
  const body = await c.req.json();
  const isStreaming = action === "streamGenerateContent";
  return routeRequest(modelName, `/v1beta/models/${modelName}:${action}`, "POST", c.req.raw.headers, body, isStreaming);
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
