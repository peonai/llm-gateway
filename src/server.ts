import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import api from "./api";
import { routeRequest } from "./router";
import { getApiKeyByKey, incrementApiKeyUsage, listApiKeys } from "./db";

const app = new Hono();

// CORS
app.use("*", cors());

// Management API (no auth for local UI)
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
    return next(); // No gw- key, pass through (might be using provider key directly)
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
  const { listModels } = require("./db");
  const models = listModels().map((m: any) => ({
    id: m.name,
    object: "model",
    created: Math.floor(m.createdAt / 1000),
    owned_by: "llm-gateway",
  }));
  return c.json({ object: "list", data: models });
});

// Static files (UI)
app.use("/ui/*", serveStatic({ root: "./public", rewriteRequestPath: (path) => path.replace("/ui", "") }));
app.get("/ui", serveStatic({ root: "./public", path: "/index.html" }));

// Root redirect
app.get("/", (c) => c.redirect("/ui"));

export default app;
