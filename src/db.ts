import { randomUUID } from "crypto";

const isBun = typeof globalThis.Bun !== "undefined";

interface DbLike {
  exec(sql: string): void;
  query(sql: string): { all(...p: any[]): any[]; get(...p: any[]): any; run(...p: any[]): any };
}

let db: DbLike;

function wrapBetterSqlite3(raw: any): DbLike {
  return {
    exec: (sql: string) => raw.exec(sql),
    query: (sql: string) => {
      const stmt = raw.prepare(sql);
      return { all: (...p: any[]) => stmt.all(...p), get: (...p: any[]) => stmt.get(...p), run: (...p: any[]) => stmt.run(...p) };
    },
  };
}

export function getDb(): DbLike {
  if (!db) {
    if (isBun) {
      const { Database } = require("bun:sqlite");
      db = new Database("gateway.db", { create: true });
    } else {
      const BetterSqlite3 = require("better-sqlite3");
      db = wrapBetterSqlite3(new BetterSqlite3("gateway.db"));
    }
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    // Migrations
    try { db.exec("ALTER TABLE providers ADD COLUMN tags TEXT NOT NULL DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE providers ADD COLUMN customHeaders TEXT NOT NULL DEFAULT '{}'"); } catch {}
    // Update 16s timeout to 32s
    try { db.exec("UPDATE deployments SET timeout = 32 WHERE timeout = 16"); } catch {}
    // Clean up orphaned deployment_stats
    try { db.exec("DELETE FROM deployment_stats WHERE deploymentId NOT IN (SELECT id FROM deployments)"); } catch {}
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      baseUrl TEXT NOT NULL,
      apiKey TEXT NOT NULL DEFAULT '',
      apiType TEXT NOT NULL DEFAULT 'openai',
      createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      modelId TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      providerId TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      modelName TEXT NOT NULL,
      "order" INTEGER NOT NULL DEFAULT 1,
      timeout INTEGER NOT NULL DEFAULT 60,
      maxRetries INTEGER NOT NULL DEFAULT 2,
      enabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS request_logs (
      id TEXT PRIMARY KEY,
      model TEXT,
      deploymentId TEXT,
      providerName TEXT,
      status INTEGER,
      latencyMs INTEGER,
      tokensIn INTEGER DEFAULT 0,
      tokensOut INTEGER DEFAULT 0,
      error TEXT,
      createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      rateLimit INTEGER DEFAULT 0,
      allowedModels TEXT DEFAULT '',
      totalRequests INTEGER DEFAULT 0,
      createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      lastUsedAt INTEGER
    );

    CREATE TABLE IF NOT EXISTS deployment_stats (
      deploymentId TEXT PRIMARY KEY,
      totalRequests INTEGER DEFAULT 0,
      successCount INTEGER DEFAULT 0,
      failCount INTEGER DEFAULT 0,
      avgLatencyMs REAL DEFAULT 0,
      lastError TEXT,
      lastErrorAt INTEGER,
      cooldownUntil INTEGER DEFAULT 0,
      consecutiveFails INTEGER DEFAULT 0
    );
  `);
}

export function uuid(): string {
  return randomUUID();
}

// --- Provider CRUD ---
export function listProviders() {
  return getDb().query("SELECT * FROM providers ORDER BY name").all();
}

export function getProvider(id: string) {
  return getDb().query("SELECT * FROM providers WHERE id = ?").get(id);
}

export function createProvider(p: { name: string; baseUrl: string; apiKey: string; apiType: string; tags?: string; customHeaders?: string }) {
  const id = uuid();
  getDb().query("INSERT INTO providers (id, name, baseUrl, apiKey, apiType, tags, customHeaders) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, p.name, p.baseUrl, p.apiKey, p.apiType, p.tags || "", p.customHeaders || "{}");
  return getProvider(id);
}

export function updateProvider(id: string, p: { name?: string; baseUrl?: string; apiKey?: string; apiType?: string; tags?: string; customHeaders?: string }) {
  const existing: any = getProvider(id);
  if (!existing) return null;
  getDb().query("UPDATE providers SET name=?, baseUrl=?, apiKey=?, apiType=?, tags=?, customHeaders=? WHERE id=?").run(
    p.name ?? existing.name, p.baseUrl ?? existing.baseUrl, p.apiKey ?? existing.apiKey, p.apiType ?? existing.apiType, p.tags ?? existing.tags ?? "", p.customHeaders ?? existing.customHeaders ?? "{}", id
  );
  return getProvider(id);
}

export function deleteProvider(id: string) {
  getDb().query("DELETE FROM providers WHERE id = ?").run(id);
}

// --- Model CRUD ---
export function listModels() {
  return getDb().query("SELECT * FROM models ORDER BY name").all();
}

export function getModel(id: string) {
  return getDb().query("SELECT * FROM models WHERE id = ?").get(id);
}

export function getModelByName(name: string) {
  return getDb().query("SELECT * FROM models WHERE name = ?").get(name);
}

export function createModel(name: string) {
  const id = uuid();
  getDb().query("INSERT INTO models (id, name) VALUES (?, ?)").run(id, name);
  return getModel(id);
}

export function updateModel(id: string, name: string) {
  getDb().query("UPDATE models SET name = ? WHERE id = ?").run(name, id);
}

export function deleteModel(id: string) {
  // Get all deployments for this model before deletion
  const deployments = listDeployments(id) as any[];
  const deploymentIds = deployments.map(d => d.id);

  // Delete the model (cascades to deployments due to foreign key)
  getDb().query("DELETE FROM models WHERE id = ?").run(id);

  // Clean up deployment_stats for removed deployments
  for (const depId of deploymentIds) {
    getDb().query("DELETE FROM deployment_stats WHERE deploymentId = ?").run(depId);
  }

  // Get the model name to clean up chains
  const modelName = deployments[0]?.modelName;
  if (modelName) {
    // Clean up chain references
    const chains = listChains() as any[];
    for (const chain of chains) {
      try {
        const items = JSON.parse(chain.items);
        let modified = false;

        if (chain.mode === "models" && Array.isArray(items)) {
          // Remove model name from models array
          const filtered = items.filter((m: string) => m !== modelName);
          if (filtered.length !== items.length) {
            updateChain(chain.id, { items: JSON.stringify(filtered) });
            modified = true;
          }
        } else if (chain.mode === "provider" && Array.isArray(items)) {
          // Remove model from provider items
          for (const item of items) {
            if (item.models && Array.isArray(item.models)) {
              const originalLength = item.models.length;
              item.models = item.models.filter((m: string) => m !== modelName);
              if (item.models.length !== originalLength) modified = true;
            }
          }
          if (modified) {
            updateChain(chain.id, { items: JSON.stringify(items) });
          }
        }
      } catch {}
    }
  }
}

// --- Deployment CRUD ---
export function listDeployments(modelId?: string) {
  if (modelId) {
    return getDb().query('SELECT d.*, p.name as providerName, p.baseUrl, p.apiKey, p.apiType, p.customHeaders FROM deployments d JOIN providers p ON d.providerId = p.id WHERE d.modelId = ? ORDER BY d."order"').all(modelId);
  }
  return getDb().query('SELECT d.*, p.name as providerName, p.baseUrl, p.apiKey, p.apiType, p.customHeaders FROM deployments d JOIN providers p ON d.providerId = p.id ORDER BY d."order"').all();
}

export function getDeployment(id: string) {
  return getDb().query("SELECT d.*, p.name as providerName, p.baseUrl, p.apiKey, p.apiType, p.customHeaders FROM deployments d JOIN providers p ON d.providerId = p.id WHERE d.id = ?").get(id);
}

export function createDeployment(d: { modelId: string; providerId: string; modelName: string; order?: number; timeout?: number; maxRetries?: number }) {
  const id = uuid();
  getDb().query('INSERT INTO deployments (id, modelId, providerId, modelName, "order", timeout, maxRetries) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, d.modelId, d.providerId, d.modelName, d.order ?? 1, d.timeout ?? 60, d.maxRetries ?? 2
  );
  // init stats
  getDb().query("INSERT OR IGNORE INTO deployment_stats (deploymentId) VALUES (?)").run(id);
  return getDeployment(id);
}

export function updateDeployment(id: string, d: { order?: number; timeout?: number; maxRetries?: number; enabled?: number; modelName?: string }) {
  const existing: any = getDeployment(id);
  if (!existing) return null;
  getDb().query('UPDATE deployments SET "order"=?, timeout=?, maxRetries=?, enabled=?, modelName=? WHERE id=?').run(
    d.order ?? existing.order, d.timeout ?? existing.timeout, d.maxRetries ?? existing.maxRetries,
    d.enabled !== undefined ? d.enabled : existing.enabled, d.modelName ?? existing.modelName, id
  );
  return getDeployment(id);
}

export function deleteDeployment(id: string) {
  getDb().query("DELETE FROM deployments WHERE id = ?").run(id);
  getDb().query("DELETE FROM deployment_stats WHERE deploymentId = ?").run(id);
}

// --- Stats ---
export function getStats(deploymentId: string): any {
  return getDb().query("SELECT * FROM deployment_stats WHERE deploymentId = ?").get(deploymentId);
}

export function getAllStats() {
  return getDb().query("SELECT * FROM deployment_stats").all();
}

export function updateStats(deploymentId: string, updates: Record<string, any>) {
  const existing = getStats(deploymentId);
  if (!existing) {
    getDb().query("INSERT INTO deployment_stats (deploymentId) VALUES (?)").run(deploymentId);
  }
  const keys = Object.keys(updates);
  const sets = keys.map(k => `${k}=?`).join(", ");
  const vals = keys.map(k => updates[k]);
  getDb().query(`UPDATE deployment_stats SET ${sets} WHERE deploymentId=?`).run(...vals, deploymentId);
}

// --- Logs ---
export function insertLog(log: { model: string; deploymentId: string; providerName: string; status: number; latencyMs: number; tokensIn?: number; tokensOut?: number; error?: string }) {
  const id = uuid();
  getDb().query("INSERT INTO request_logs (id, model, deploymentId, providerName, status, latencyMs, tokensIn, tokensOut, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id, log.model, log.deploymentId, log.providerName, log.status, log.latencyMs, log.tokensIn ?? 0, log.tokensOut ?? 0, log.error ?? null
  );
  // prune old logs (keep 500)
  getDb().query("DELETE FROM request_logs WHERE id NOT IN (SELECT id FROM request_logs ORDER BY createdAt DESC LIMIT 500)").run();
}

export function listLogs(limit = 100, offset = 0, filters?: { model?: string; status?: string; provider?: string }) {
  let where = "1=1";
  const params: any[] = [];
  if (filters?.model) { where += " AND model = ?"; params.push(filters.model); }
  if (filters?.status) { where += " AND status = ?"; params.push(parseInt(filters.status)); }
  if (filters?.provider) { where += " AND providerName = ?"; params.push(filters.provider); }
  params.push(limit, offset);
  return getDb().query(`SELECT * FROM request_logs WHERE ${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`).all(...params);
}

export function getLogSummary() {
  const total: any = getDb().query("SELECT COUNT(*) as count FROM request_logs").get();
  const success: any = getDb().query("SELECT COUNT(*) as count FROM request_logs WHERE status >= 200 AND status < 300").get();
  const avgLatency: any = getDb().query("SELECT AVG(latencyMs) as avg FROM request_logs WHERE status >= 200 AND status < 300").get();
  const recent: any = getDb().query("SELECT COUNT(*) as count FROM request_logs WHERE createdAt > ?").get(Date.now() - 3600000);
  return {
    totalRequests: total?.count ?? 0,
    successCount: success?.count ?? 0,
    successRate: total?.count > 0 ? ((success?.count / total?.count) * 100).toFixed(1) : "0.0",
    avgLatencyMs: Math.round(avgLatency?.avg ?? 0),
    lastHourRequests: recent?.count ?? 0,
  };
}

// --- API Keys ---
export function generateKey(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'gw-';
  for (let i = 0; i < 32; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

export function listApiKeys() {
  return getDb().query("SELECT * FROM api_keys ORDER BY createdAt DESC").all();
}

export function getApiKey(id: string) {
  return getDb().query("SELECT * FROM api_keys WHERE id = ?").get(id);
}

export function getApiKeyByKey(key: string) {
  return getDb().query("SELECT * FROM api_keys WHERE key = ?").get(key);
}

export function createApiKey(p: { name: string; rateLimit?: number; allowedModels?: string }) {
  const id = uuid();
  const key = generateKey();
  getDb().query("INSERT INTO api_keys (id, name, key, rateLimit, allowedModels) VALUES (?, ?, ?, ?, ?)").run(
    id, p.name, key, p.rateLimit ?? 0, p.allowedModels ?? ''
  );
  return getApiKey(id);
}

export function updateApiKey(id: string, p: { name?: string; enabled?: number; rateLimit?: number; allowedModels?: string }) {
  const existing: any = getApiKey(id);
  if (!existing) return null;
  getDb().query("UPDATE api_keys SET name=?, enabled=?, rateLimit=?, allowedModels=? WHERE id=?").run(
    p.name ?? existing.name, p.enabled !== undefined ? p.enabled : existing.enabled,
    p.rateLimit ?? existing.rateLimit, p.allowedModels ?? existing.allowedModels, id
  );
  return getApiKey(id);
}

export function deleteApiKey(id: string) {
  getDb().query("DELETE FROM api_keys WHERE id = ?").run(id);
}

export function incrementApiKeyUsage(key: string) {
  getDb().query("UPDATE api_keys SET totalRequests = totalRequests + 1, lastUsedAt = ? WHERE key = ?").run(Date.now(), key);
}

// --- Per-model stats for dashboard ---
export function getModelStats() {
  return getDb().query(`
    SELECT 
      rl.model,
      COUNT(*) as totalRequests,
      SUM(CASE WHEN rl.status >= 200 AND rl.status < 300 THEN 1 ELSE 0 END) as successCount,
      SUM(CASE WHEN rl.status >= 400 THEN 1 ELSE 0 END) as failCount,
      ROUND(AVG(CASE WHEN rl.status >= 200 AND rl.status < 300 THEN rl.latencyMs END)) as avgLatencyMs,
      SUM(rl.tokensIn) as totalTokensIn,
      SUM(rl.tokensOut) as totalTokensOut
    FROM request_logs rl
    WHERE rl.model IS NOT NULL
    GROUP BY rl.model
    ORDER BY totalRequests DESC
  `).all();
}

export function getModelTimeline(hours: number = 24) {
  const since = Date.now() - hours * 3600000;
  return getDb().query(`
    SELECT 
      model,
      CAST((createdAt / 3600000) AS INTEGER) * 3600000 as hour,
      COUNT(*) as count,
      SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) as success,
      SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) as fail
    FROM request_logs
    WHERE createdAt > ? AND model IS NOT NULL
    GROUP BY model, hour
    ORDER BY hour
  `).all(since);
}

// --- Fallback Chains ---
export function initChainSchema() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS fallback_chains (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      mode TEXT NOT NULL DEFAULT 'model',
      items TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
  `);
}

export function listChains() {
  initChainSchema();
  return getDb().query("SELECT * FROM fallback_chains ORDER BY name").all();
}

export function getChain(id: string) {
  initChainSchema();
  return getDb().query("SELECT * FROM fallback_chains WHERE id = ?").get(id);
}

export function getChainByName(name: string) {
  initChainSchema();
  return getDb().query("SELECT * FROM fallback_chains WHERE name = ? AND enabled = 1").get(name);
}

export function createChain(p: { name: string; mode: string; items: string }) {
  initChainSchema();
  const id = uuid();
  getDb().query("INSERT INTO fallback_chains (id, name, mode, items) VALUES (?, ?, ?, ?)").run(id, p.name, p.mode, p.items);
  return getChain(id);
}

export function updateChain(id: string, p: { name?: string; mode?: string; items?: string; enabled?: number }) {
  initChainSchema();
  const existing: any = getChain(id);
  if (!existing) return null;
  getDb().query("UPDATE fallback_chains SET name=?, mode=?, items=?, enabled=? WHERE id=?").run(
    p.name ?? existing.name, p.mode ?? existing.mode, p.items ?? existing.items,
    p.enabled !== undefined ? p.enabled : existing.enabled, id
  );
  return getChain(id);
}

export function deleteChain(id: string) {
  initChainSchema();
  getDb().query("DELETE FROM fallback_chains WHERE id = ?").run(id);
}
