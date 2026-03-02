import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import api from "./api";
import { routeRequest } from "./router";

const app = new Hono();

// CORS
app.use("*", cors());

// Management API
app.route("/api", api);

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

// OpenAI models list (return configured models)
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
