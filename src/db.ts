import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";

let db: Database;

export function getDb(): Database {
  if (!db) {
    db = new Database("gateway.db", { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
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

export function createProvider(p: { name: string; baseUrl: string; apiKey: string; apiType: string }) {
  const id = uuid();
  getDb().query("INSERT INTO providers (id, name, baseUrl, apiKey, apiType) VALUES (?, ?, ?, ?, ?)").run(id, p.name, p.baseUrl, p.apiKey, p.apiType);
  return getProvider(id);
}

export function updateProvider(id: string, p: { name?: string; baseUrl?: string; apiKey?: string; apiType?: string }) {
  const existing: any = getProvider(id);
  if (!existing) return null;
  getDb().query("UPDATE providers SET name=?, baseUrl=?, apiKey=?, apiType=? WHERE id=?").run(
    p.name ?? existing.name, p.baseUrl ?? existing.baseUrl, p.apiKey ?? existing.apiKey, p.apiType ?? existing.apiType, id
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

export function deleteModel(id: string) {
  getDb().query("DELETE FROM models WHERE id = ?").run(id);
}

// --- Deployment CRUD ---
export function listDeployments(modelId?: string) {
  if (modelId) {
    return getDb().query('SELECT d.*, p.name as providerName, p.baseUrl, p.apiKey, p.apiType FROM deployments d JOIN providers p ON d.providerId = p.id WHERE d.modelId = ? ORDER BY d."order"').all(modelId);
  }
  return getDb().query('SELECT d.*, p.name as providerName, p.baseUrl, p.apiKey, p.apiType FROM deployments d JOIN providers p ON d.providerId = p.id ORDER BY d."order"').all();
}

export function getDeployment(id: string) {
  return getDb().query("SELECT d.*, p.name as providerName, p.baseUrl, p.apiKey, p.apiType FROM deployments d JOIN providers p ON d.providerId = p.id WHERE d.id = ?").get(id);
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
