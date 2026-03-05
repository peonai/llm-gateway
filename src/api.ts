import { Hono } from "hono";
import * as db from "./db";
import { getCooldownInfo, routeTestDirect, getStickyInfo, clearStickyRoute, setStickyDeployment } from "./router";

const api = new Hono();

// Auth verification endpoint (used by UI login screen)
// Returns 200 if auth passes (middleware already validated), or if no ADMIN_KEY is set
api.post("/auth/verify", (c) => c.json({ ok: true }));

// Mask sensitive fields in provider responses
function maskProvider(p: any) {
  if (!p) return p;
  return { ...p, apiKey: p.apiKey ? `${p.apiKey.slice(0, 6)}...${p.apiKey.slice(-4)}` : "" };
}

// --- Providers ---
api.get("/providers", (c) => c.json((db.listProviders() as any[]).map(maskProvider)));
api.get("/providers/:id", (c) => {
  const p = db.getProvider(c.req.param("id"));
  return p ? c.json(maskProvider(p)) : c.json({ error: "not found" }, 404);
});
api.post("/providers", async (c) => {
  const body = await c.req.json();
  // Normalize: strip trailing / and /v1 from baseUrl
  const baseUrl = (body.baseUrl || "").replace(/\/+$/, "").replace(/\/v1$/, "");
  const p = db.createProvider({ name: body.name, baseUrl, apiKey: body.apiKey || "", apiType: body.apiType || "openai" });
  return c.json(maskProvider(p), 201);
});
api.put("/providers/:id", async (c) => {
  const body = await c.req.json();
  // Normalize baseUrl if provided
  if (body.baseUrl) body.baseUrl = body.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  // If apiKey looks masked (contains "..."), don't update it
  if (body.apiKey && body.apiKey.includes("...")) {
    delete body.apiKey;
  }
  const p = db.updateProvider(c.req.param("id"), body);
  return p ? c.json(maskProvider(p)) : c.json({ error: "not found" }, 404);
});
api.delete("/providers/:id", (c) => {
  db.deleteProvider(c.req.param("id"));
  return c.json({ ok: true });
});

// Test provider connection
api.post("/providers/:id/test", async (c) => {
  const p: any = db.getProvider(c.req.param("id"));
  if (!p) return c.json({ error: "not found" }, 404);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const baseUrl = p.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");

    if (p.apiType === "anthropic") {
      headers["x-api-key"] = p.apiKey;
      headers["anthropic-version"] = "2023-06-01";
      const url = `${baseUrl}/v1/messages`;
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
        signal: AbortSignal.timeout(10000),
      });
      return c.json({ ok: resp.ok, status: resp.status, message: resp.ok ? "Connection successful" : await resp.text().then(t => t.slice(0, 200)) });
    } else if (p.apiType === "gemini") {
      headers["x-goog-api-key"] = p.apiKey;
      const url = `${baseUrl}/v1beta/models/gemini-2.0-flash-exp:generateContent`;
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }], role: "user" }] }),
        signal: AbortSignal.timeout(10000),
      });
      return c.json({ ok: resp.ok, status: resp.status, message: resp.ok ? "Connection successful" : await resp.text().then(t => t.slice(0, 200)) });
    } else {
      headers["Authorization"] = `Bearer ${p.apiKey}`;
      const url = `${baseUrl}/v1/models`;
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      return c.json({ ok: resp.ok, status: resp.status, message: resp.ok ? "Connection successful" : await resp.text().then(t => t.slice(0, 200)) });
    }
  } catch (err: any) {
    return c.json({ ok: false, status: 0, message: err.message });
  }
});

// Fetch remote models
api.post("/providers/:id/fetch-models", async (c) => {
  const p: any = db.getProvider(c.req.param("id"));
  if (!p) return c.json({ error: "not found" }, 404);
  try {
    const baseUrl = p.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    const headers: Record<string, string> = {};
    
    if (p.apiType === "anthropic") {
      headers["x-api-key"] = p.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (p.apiType === "gemini") {
      headers["x-goog-api-key"] = p.apiKey;
    } else {
      headers["Authorization"] = `Bearer ${p.apiKey}`;
    }
    
    const url = `${baseUrl}/v1/models`;
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return c.json({ error: `HTTP ${resp.status}`, models: [] });
    const data: any = await resp.json();
    const models = (data.data || data.models || []).map((m: any) => m.id || m.name);
    return c.json({ models });
  } catch (err: any) {
    return c.json({ error: err.message, models: [] });
  }
});

// --- Models ---
api.get("/models", (c) => {
  const models = db.listModels() as any[];
  // Enrich with deployment info
  const enriched = models.map(m => ({
    ...m,
    deployments: db.listDeployments(m.id),
  }));
  return c.json(enriched);
});
api.post("/models", async (c) => {
  const body = await c.req.json();
  const m = db.createModel(body.name);
  return c.json(m, 201);
});
api.put("/models/:id", async (c) => {
  const { name } = await c.req.json();
  if (!name) return c.json({ error: "name required" }, 400);
  db.updateModel(c.req.param("id"), name);
  return c.json({ ok: true });
});

api.delete("/models/:id", (c) => {
  db.deleteModel(c.req.param("id"));
  return c.json({ ok: true });
});

// --- Deployments ---
api.get("/deployments", (c) => c.json(db.listDeployments()));
api.post("/deployments", async (c) => {
  const body = await c.req.json();
  const d = db.createDeployment(body);
  return c.json(d, 201);
});
api.put("/deployments/:id", async (c) => {
  const body = await c.req.json();
  const d = db.updateDeployment(c.req.param("id"), body);
  return d ? c.json(d) : c.json({ error: "not found" }, 404);
});
api.delete("/deployments/:id", (c) => {
  db.deleteDeployment(c.req.param("id"));
  return c.json({ ok: true });
});

// --- Stats ---
api.get("/stats", (c) => {
  const summary = db.getLogSummary();
  const rawStats = db.getAllStats() as any[];
  const allStats: Record<string, any> = {};
  for (const s of rawStats) {
    allStats[s.deploymentId] = {
      ...s,
      successRate: s.totalRequests > 0 ? s.successCount / s.totalRequests : 0,
    };
  }
  const cooldownInfo = getCooldownInfo();
  const providerCount = (db.listProviders() as any[]).length;
  const modelCount = (db.listModels() as any[]).length;
  return c.json({ summary: { ...summary, providerCount, modelCount }, deploymentStats: allStats, cooldowns: cooldownInfo, sticky: getStickyInfo() });
});

// --- Logs ---
api.get("/logs", (c) => {
  const limit = parseInt(c.req.query("limit") || "100");
  const offset = parseInt(c.req.query("offset") || "0");
  const model = c.req.query("model") || undefined;
  const status = c.req.query("status") || undefined;
  const provider = c.req.query("provider") || undefined;
  return c.json(db.listLogs(limit, offset, { model, status, provider }));
});

// Sticky routes
api.post("/sticky", async (c) => {
  const { modelName, deploymentId, ttlMs } = await c.req.json();
  if (!modelName || !deploymentId) return c.json({ error: "modelName and deploymentId required" }, 400);
  const safeTtl = typeof ttlMs === "number" && ttlMs > 0 ? ttlMs : undefined;
  // If modelName belongs to a chain, use chain name as key (and clear any model-level sticky)
  const chains = db.listChains() as any[];
  const owningChain = chains.find(ch => {
    try { return (JSON.parse(ch.items) as string[]).includes(modelName); } catch { return false; }
  });
  if (owningChain) {
    clearStickyRoute(modelName); // clear model-level sticky if any
    setStickyDeployment(owningChain.name, deploymentId, safeTtl, true);
  } else {
    setStickyDeployment(modelName, deploymentId, safeTtl, true);
  }
  return c.json({ ok: true });
});
api.delete("/sticky/:model", (c) => {
  clearStickyRoute(decodeURIComponent(c.req.param("model")));
  return c.json({ ok: true });
});
api.delete("/sticky", (c) => {
  clearStickyRoute();
  return c.json({ ok: true });
});

export default api;

// --- API Keys ---
api.get("/keys", (c) => {
  return c.json(db.listApiKeys());
});

api.post("/keys", async (c) => {
  const body = await c.req.json();
  const key = db.createApiKey({ name: body.name, rateLimit: body.rateLimit, allowedModels: body.allowedModels });
  return c.json(key, 201);
});

api.put("/keys/:id", async (c) => {
  const body = await c.req.json();
  const key = db.updateApiKey(c.req.param("id"), body);
  return key ? c.json(key) : c.json({ error: "not found" }, 404);
});

api.delete("/keys/:id", (c) => {
  db.deleteApiKey(c.req.param("id"));
  return c.json({ ok: true });
});

// --- Model Stats for Dashboard ---
api.get("/model-stats", (c) => {
  return c.json(db.getModelStats());
});

api.get("/model-timeline", (c) => {
  const hours = parseInt(c.req.query("hours") || "24");
  return c.json(db.getModelTimeline(hours));
});

// --- Fallback Chains ---
api.get("/chains", (c) => c.json(db.listChains()));

api.post("/chains", async (c) => {
  const body = await c.req.json();
  const chain = db.createChain({
    name: body.name,
    mode: body.mode || "model",
    items: typeof body.items === "string" ? body.items : JSON.stringify(body.items || []),
  });
  return c.json(chain, 201);
});

api.put("/chains/:id", async (c) => {
  const body = await c.req.json();
  const chain = db.updateChain(c.req.param("id"), {
    name: body.name,
    mode: body.mode,
    items: typeof body.items === "string" ? body.items : (body.items ? JSON.stringify(body.items) : undefined),
    enabled: body.enabled,
  });
  return chain ? c.json(chain) : c.json({ error: "not found" }, 404);
});

api.delete("/chains/:id", (c) => {
  db.deleteChain(c.req.param("id"));
  return c.json({ ok: true });
});

// --- Test Route ---
import { routeTestRequest } from "./router";

api.post("/test-route", async (c) => {
  const body = await c.req.json();
  const model = body.model;
  const message = body.message || "hi";
  const providerId = body.providerId;
  if (!model) return c.json({ error: "model is required" }, 400);

  const testBody = {
    model,
    max_tokens: 20,
    messages: [{ role: "user", content: message }],
  };

  // Custom mode: direct provider test (bypass routing)
  if (providerId) {
    const provider = db.getProvider(providerId);
    if (!provider) return c.json({ error: "provider not found" }, 404);
    const trace = await routeTestDirect(model, provider, c.req.raw.headers, testBody);
    return c.json(trace);
  }

  const trace = await routeTestRequest(model, "/v1/messages", "POST", c.req.raw.headers, testBody);
  return c.json(trace);
});
