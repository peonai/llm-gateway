#!/usr/bin/env node
/**
 * sticky.js - LLM Gateway Sticky Deployment Manager
 * Usage:
 *   node sticky.js                          - List all sticky deployments
 *   node sticky.js <model>                  - Show sticky for a model
 *   node sticky.js set <model> <deploymentId> [ttlMs] - Set sticky
 *   node sticky.js clear [model]            - Clear sticky (all or specific)
 *   node sticky.js deployments              - List all deployments
 */

const GATEWAY_URL = process.env.LLM_GATEWAY_URL || "http://localhost:3456";

async function apiFetch(path, options = {}) {
  const url = `${GATEWAY_URL}/api${path}`;
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, data: text };
  }
}

function formatRemaining(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

async function listSticky() {
  const { ok, data } = await apiFetch("/stats");
  if (!ok) return console.error("Error fetching stats:", data);

  const sticky = data.sticky || {};
  const entries = Object.entries(sticky);

  if (entries.length === 0) {
    console.log("No sticky deployments.");
    return;
  }

  console.log(`Sticky Deployments (${entries.length}):\n`);
  for (const [model, info] of entries) {
    console.log(`  ${model}`);
    console.log(`    Provider:    ${info.providerName}`);
    console.log(`    Model:       ${info.modelName}`);
    console.log(`    Deployment:  ${info.deploymentId}`);
    console.log(`    Remaining:   ${formatRemaining(info.remainingMs)}`);
    console.log();
  }
}

async function showSticky(model) {
  const { ok, data } = await apiFetch("/stats");
  if (!ok) return console.error("Error fetching stats:", data);

  const info = (data.sticky || {})[model];
  if (!info) {
    console.log(`No sticky deployment for "${model}".`);
    return;
  }

  console.log(`Sticky for "${model}":\n`);
  console.log(`  Provider:    ${info.providerName}`);
  console.log(`  Model:       ${info.modelName}`);
  console.log(`  Deployment:  ${info.deploymentId}`);
  console.log(`  Remaining:   ${formatRemaining(info.remainingMs)}`);
}

async function setSticky(model, deploymentId, ttlMs) {
  const body = { modelName: model, deploymentId };
  if (ttlMs) body.ttlMs = Number(ttlMs);

  const { ok, data } = await apiFetch("/sticky", {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (ok && data.ok) {
    console.log(`✓ Sticky set: ${model} → ${deploymentId}`);
    if (ttlMs) console.log(`  TTL: ${formatRemaining(Number(ttlMs))}`);
  } else {
    console.error("✗ Failed:", data?.error || data);
    process.exit(1);
  }
}

async function clearSticky(model) {
  const path = model ? `/sticky/${encodeURIComponent(model)}` : "/sticky";
  const { ok, data } = await apiFetch(path, { method: "DELETE" });

  if (ok && data.ok) {
    console.log(model ? `✓ Sticky cleared for "${model}".` : "✓ All sticky deployments cleared.");
  } else {
    console.error("✗ Failed:", data?.error || data);
    process.exit(1);
  }
}

async function listDeployments() {
  const { ok, data } = await apiFetch("/deployments");
  if (!ok) return console.error("Error fetching deployments:", data);

  if (!data.length) {
    console.log("No deployments configured.");
    return;
  }

  console.log(`Deployments (${data.length}):\n`);
  for (const d of data) {
    console.log(`  ${d.id}`);
    console.log(`    Model:    ${d.modelName}`);
    console.log(`    Provider: ${d.providerName}`);
    console.log(`    Enabled:  ${d.enabled}`);
    console.log(`    Priority: ${d.priority ?? "default"}`);
    console.log();
  }
}

async function main() {
  const [, , cmd, ...args] = process.argv;

  switch (cmd) {
    case undefined:
    case "list":
      await listSticky();
      break;
    case "set":
      if (!args[0] || !args[1]) {
        console.error("Usage: sticky.js set <model> <deploymentId> [ttlMs]");
        process.exit(1);
      }
      await setSticky(args[0], args[1], args[2]);
      break;
    case "clear":
      await clearSticky(args[0]);
      break;
    case "deployments":
      await listDeployments();
      break;
    default:
      // Treat as model name
      await showSticky(cmd);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
