import { listDeployments, getModelByName, updateStats, getStats, insertLog, getChainByName, listProviders } from "./db";

interface Deployment {
  id: string; modelId: string; providerId: string; modelName: string;
  order: number; timeout: number; maxRetries: number; enabled: number;
  providerName: string; baseUrl: string; apiKey: string; apiType: string;
  customHeaders?: string; // JSON string of custom headers
}

export interface RouteTrace {
  requestModel: string;
  chainName?: string;
  chainMode?: string;
  steps: RouteStep[];
  finalDeployment?: { provider: string; model: string; deploymentId: string };
  success: boolean;
  totalLatencyMs: number;
  skipSticky?: boolean;
  stickyKey?: string; // chain name or model name — single key for sticky/pin
}

export interface RouteStep {
  action: string; // "chain_match", "try_model", "try_deployment", "skip_cooldown", "fallback", "success", "fail"
  model?: string;
  provider?: string;
  deploymentId?: string;
  status?: number;
  latencyMs?: number;
  error?: string;
}

// In-memory cooldown tracker
const cooldowns = new Map<string, number>();
const consecutiveFailsMap = new Map<string, number>();
const COOLDOWN_BASE = 120_000;
const MAX_CONSECUTIVE_FAILS = 3;


function isInCooldown(deploymentId: string): boolean {
  const until = cooldowns.get(deploymentId);
  if (!until) return false;
  if (Date.now() >= until) {
    cooldowns.delete(deploymentId);
    consecutiveFailsMap.delete(deploymentId);
    return false;
  }
  return true;
}

function recordSuccess(deploymentId: string, modelName?: string) {
  consecutiveFailsMap.set(deploymentId, 0);
  cooldowns.delete(deploymentId);

}

function recordFailure(deploymentId: string) {
  const fails = (consecutiveFailsMap.get(deploymentId) ?? 0) + 1;
  consecutiveFailsMap.set(deploymentId, fails);
  if (fails >= MAX_CONSECUTIVE_FAILS) {
    const cooldownMs = COOLDOWN_BASE * Math.min(fails - MAX_CONSECUTIVE_FAILS + 1, 5);
    cooldowns.set(deploymentId, Date.now() + cooldownMs);
    updateStats(deploymentId, { cooldownUntil: Date.now() + cooldownMs, consecutiveFails: fails });
  }
}

export function getCooldownInfo() {
  const info: Record<string, { until: number; fails: number }> = {};
  for (const [id, until] of cooldowns) {
    if (Date.now() < until) info[id] = { until, fails: consecutiveFailsMap.get(id) ?? 0 };
  }
  return info;
}


async function forwardRequest(deployment: Deployment, inboundPath: string, method: string, headers: Headers, body: any): Promise<{ resp: Response; needsResponseConversion: null }> {
  // Pass-through: preserve inbound protocol, only replace model name
  const requestBody = { ...body, model: deployment.modelName };

  // Normalize baseUrl: strip trailing / and /v1 so baseUrl + inboundPath is always correct
  const baseUrl = deployment.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  
  let url: string;
  if (deployment.apiType === "gemini") {
    // Gemini uses /v1beta/models/{model}:generateContent
    url = `${baseUrl}/v1beta/models/${deployment.modelName}:generateContent`;
  } else {
    url = `${baseUrl}${inboundPath}`;
  }

  const outHeaders: Record<string, string> = { "Content-Type": "application/json" };

  // Apply custom headers from provider config
  if (deployment.customHeaders) {
    try {
      const custom = JSON.parse(deployment.customHeaders);
      Object.assign(outHeaders, custom);
    } catch {}
  }

  // Auth based on provider's apiType
  if (deployment.apiType === "anthropic") {
    outHeaders["x-api-key"] = deployment.apiKey;
    outHeaders["anthropic-version"] = headers.get("anthropic-version") || "2023-06-01";
    const beta = headers.get("anthropic-beta");
    if (beta) outHeaders["anthropic-beta"] = beta;
  } else if (deployment.apiType === "gemini") {
    outHeaders["x-goog-api-key"] = deployment.apiKey;
  } else {
    outHeaders["Authorization"] = `Bearer ${deployment.apiKey}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), deployment.timeout * 1000);
  try {
    const resp = await fetch(url, { method, headers: outHeaders, body: JSON.stringify(requestBody), signal: controller.signal });
    clearTimeout(timeoutId);
    return { resp, needsResponseConversion: null };
  } catch (err: any) {
    clearTimeout(timeoutId);
    throw err.name === "AbortError" ? new Error(`Timeout after ${deployment.timeout}s`) : err;
  }
}


async function tryDeployment(
  dep: Deployment, modelName: string, path: string, method: string,
  headers: Headers, body: any, isStreaming: boolean, trace: RouteTrace
): Promise<{ response: Response; final: true } | { error: string; status: number; final: false }> {
  const start = Date.now();
  let retries = dep.maxRetries;
  let lastError = "";
  let lastStatus = 502;


  trace.steps.push({ action: "try_deployment", model: dep.modelName, provider: dep.providerName, deploymentId: dep.id });

  while (retries >= 0) {
    try {
      const { resp } = await forwardRequest(dep, path, method, headers, body);
      const latencyMs = Date.now() - start;


      if (resp.ok) {
        recordSuccess(dep.id, modelName);
        const oldAvg = getStats(dep.id)?.avgLatencyMs ?? latencyMs;
        const emaLatency = Math.round(oldAvg * 0.8 + latencyMs * 0.2);
        updateStats(dep.id, {
          totalRequests: (getStats(dep.id)?.totalRequests ?? 0) + 1,
          successCount: (getStats(dep.id)?.successCount ?? 0) + 1,
          avgLatencyMs: emaLatency, consecutiveFails: 0, cooldownUntil: 0,
        });

        trace.steps.push({ action: "success", model: dep.modelName, provider: dep.providerName, status: resp.status, latencyMs });
        trace.finalDeployment = { provider: dep.providerName, model: dep.modelName, deploymentId: dep.id };
        trace.success = true;
        if (!trace.skipSticky) setStickyDeployment(trace.stickyKey || modelName, dep.id);

        // Streaming: pass through, intercept final chunk for token usage
        if (isStreaming && resp.body) {
          let usageData: { tokensIn: number; tokensOut: number } | null = null;
          const transform = new TransformStream({
            transform(chunk, controller) {
              controller.enqueue(chunk);
              // Try to extract usage from SSE chunks
              try {
                const text = new TextDecoder().decode(chunk);
                const lines = text.split("\n").filter(l => l.startsWith("data: "));
                for (const line of lines) {
                  const json = JSON.parse(line.slice(6));
                  if (json.usage) {
                    usageData = {
                      tokensIn: json.usage.prompt_tokens ?? json.usage.input_tokens ?? 0,
                      tokensOut: json.usage.completion_tokens ?? json.usage.output_tokens ?? 0,
                    };
                  }
                }
              } catch {}
            },
            flush() {
              insertLog({ model: modelName, deploymentId: dep.id, providerName: dep.providerName, status: resp.status, latencyMs, tokensIn: usageData?.tokensIn ?? 0, tokensOut: usageData?.tokensOut ?? 0 });
            },
          });
          return { response: new Response(resp.body.pipeThrough(transform), {
            status: resp.status,
            headers: { "Content-Type": resp.headers.get("Content-Type") || "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive",
              "X-Route-Provider": dep.providerName, "X-Route-Model": dep.modelName },
          }), final: true };
        }

        // Non-streaming: extract token stats and log once
        let respBody = await resp.text();
        let tokensIn = 0, tokensOut = 0;
        try {
          const parsed = JSON.parse(respBody);
          tokensIn = parsed.usage?.prompt_tokens ?? parsed.usage?.input_tokens ?? 0;
          tokensOut = parsed.usage?.completion_tokens ?? parsed.usage?.output_tokens ?? 0;
          if (tokensIn === 0 && tokensOut === 0 && parsed.usage) {
            console.warn(`[Token Parse] Zero tokens but usage exists:`, JSON.stringify(parsed.usage));
          }
        } catch (e) {
          console.error(`[Token Parse] Failed to parse response body:`, e, `Body preview:`, respBody.slice(0, 200));
        }
        insertLog({ model: modelName, deploymentId: dep.id, providerName: dep.providerName, status: resp.status, latencyMs, tokensIn, tokensOut });

        return { response: new Response(respBody, { status: resp.status, headers: { "Content-Type": resp.headers.get("Content-Type") || "application/json", "X-Route-Provider": dep.providerName, "X-Route-Model": dep.modelName } }), final: true };
      }

      const errorBody = await resp.text();
      lastError = errorBody.slice(0, 500);
      lastStatus = resp.status;
      insertLog({ model: modelName, deploymentId: dep.id, providerName: dep.providerName, status: resp.status, latencyMs: Date.now() - start, error: lastError });
      updateStats(dep.id, {
        totalRequests: (getStats(dep.id)?.totalRequests ?? 0) + 1,
        failCount: (getStats(dep.id)?.failCount ?? 0) + 1,
        lastError: lastError.slice(0, 200), lastErrorAt: Date.now(),
      });
      trace.steps.push({ action: "fail", model: dep.modelName, provider: dep.providerName, status: resp.status, latencyMs: Date.now() - start, error: lastError.slice(0, 100) });

      const attempt = dep.maxRetries - retries;
      if (retries > 0) { retries--; await new Promise(r => setTimeout(r, Math.min(2000 * Math.pow(2, attempt), 16000))); continue; }
      recordFailure(dep.id);
      break;
    } catch (err: any) {
      lastError = err.message || String(err);
      lastStatus = 502;
      insertLog({ model: modelName, deploymentId: dep.id, providerName: dep.providerName, status: 502, latencyMs: Date.now() - start, error: lastError });
      updateStats(dep.id, {
        totalRequests: (getStats(dep.id)?.totalRequests ?? 0) + 1,
        failCount: (getStats(dep.id)?.failCount ?? 0) + 1,
        lastError: lastError.slice(0, 200), lastErrorAt: Date.now(),
      });
      trace.steps.push({ action: "fail", model: dep.modelName, provider: dep.providerName, status: 502, error: lastError.slice(0, 100) });
      const attemptErr = dep.maxRetries - retries;
      if (retries > 0) { retries--; await new Promise(r => setTimeout(r, Math.min(2000 * Math.pow(2, attemptErr), 16000))); continue; }
      recordFailure(dep.id);
      break;
    }
  }
  return { error: lastError, status: lastStatus, final: false };
}


// --- Sticky routing: prefer last successful deployment for 2 hours ---
const STICKY_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const stickyMap = new Map<string, { deploymentId: string; until: number; manual?: boolean }>();

function getStickyDeployment(modelName: string): string | null {
  const entry = stickyMap.get(modelName);
  if (!entry) return null;
  if (Date.now() > entry.until) { stickyMap.delete(modelName); return null; }
  return entry.deploymentId;
}

export function clearStickyRoute(modelName?: string) {
  if (modelName) stickyMap.delete(modelName);
  else stickyMap.clear();
}

export function setStickyDeployment(modelName: string, deploymentId: string, ttlMs?: number, manual?: boolean) {
  const existing = stickyMap.get(modelName);
  // Don't overwrite a manual pin with an automatic one
  if (existing && existing.manual && !manual && Date.now() < existing.until) return;
  stickyMap.set(modelName, { deploymentId, until: Date.now() + (ttlMs ?? STICKY_TTL_MS), manual: !!manual });
}

export function getStickyInfo(): Record<string, { deploymentId: string; remainingMs: number; providerName?: string; modelName?: string }> {
  const result: Record<string, any> = {};
  const now = Date.now();
  for (const [model, entry] of stickyMap) {
    if (now < entry.until) {
      const dep = (listDeployments() as any[]).find((d: any) => d.id === entry.deploymentId);
      result[model] = {
        deploymentId: entry.deploymentId,
        remainingMs: entry.until - now,
        providerName: dep?.providerName,
        modelName: dep?.modelName,
        manual: !!entry.manual,
      };
    }
  }
  return result;
}

function getHealthyDeployments(modelName: string, skipSticky = false, stickyKey?: string): Deployment[] {
  const model: any = getModelByName(modelName);
  if (!model) return [];
  const deps = (listDeployments(model.id) as Deployment[]).filter(d => d.enabled && !isInCooldown(d.id));
  if (!skipSticky) {
    const stickyId = getStickyDeployment(stickyKey || modelName);
    if (stickyId) {
      const stickyIdx = deps.findIndex(d => d.id === stickyId);
      if (stickyIdx > 0) {
        const sticky = deps.splice(stickyIdx, 1)[0]!;
        deps.unshift(sticky);
      }
    }
  }
  return deps;
}

async function routeModel(modelName: string, path: string, method: string, headers: Headers, body: any, isStreaming: boolean, trace: RouteTrace): Promise<Response | null> {
  trace.steps.push({ action: "try_model", model: modelName });
  // When routing through a chain, check sticky by chain name (stickyKey), not individual model
  const stickyKey = trace.stickyKey || modelName;
  const deps = getHealthyDeployments(modelName, trace.skipSticky, stickyKey);
  const model: any = getModelByName(modelName);
  if (model) {
    const allDeps = listDeployments(model.id) as Deployment[];
    const cooldownDeps = allDeps.filter(d => d.enabled && isInCooldown(d.id));
    cooldownDeps.forEach(d => trace.steps.push({ action: "skip_cooldown", model: d.modelName, provider: d.providerName, deploymentId: d.id }));
  }
  if (deps.length === 0) { trace.steps.push({ action: "fallback", model: modelName, error: "no healthy deployments" }); return null; }
  for (const dep of deps) {
    const result = await tryDeployment(dep, modelName, path, method, headers, body, isStreaming, trace);
    if (result.final) return (result as any).response;
    trace.steps.push({ action: "fallback", model: dep.modelName, provider: dep.providerName, error: "deployment failed, trying next" });
  }
  return null;
}

async function routeModelsChain(modelNames: string[], path: string, method: string, headers: Headers, body: any, isStreaming: boolean, trace: RouteTrace): Promise<Response | null> {
  for (const mn of modelNames) {
    const resp = await routeModel(mn, path, method, headers, body, isStreaming, trace);
    if (resp) return resp;
  }
  return null;
}

async function routeProviderChain(items: { provider: string; models: string[] }[], path: string, method: string, headers: Headers, body: any, isStreaming: boolean, trace: RouteTrace): Promise<Response | null> {
  const allProviders = listProviders() as any[];
  const providerMap = new Map(allProviders.map(p => [p.name, p]));
  for (const item of items) {
    const provider = providerMap.get(item.provider);
    if (!provider) { trace.steps.push({ action: "fallback", provider: item.provider, error: "provider not found" }); continue; }
    for (const modelName of item.models) {
      const model: any = getModelByName(modelName);
      if (!model) { trace.steps.push({ action: "fallback", model: modelName, provider: item.provider, error: "model not found" }); continue; }
      trace.steps.push({ action: "try_model", model: modelName, provider: item.provider });
      const deps = (listDeployments(model.id) as Deployment[]).filter(d => d.providerId === provider.id && d.enabled && !isInCooldown(d.id));
      for (const dep of deps) {
        const result = await tryDeployment(dep, modelName, path, method, headers, body, isStreaming, trace);
        if (result.final) return (result as any).response;
      }
    }
  }
  return null;
}

export async function routeRequest(requestModelName: string, path: string, method: string, headers: Headers, body: any, isStreaming: boolean): Promise<Response> {
  const traceStart = Date.now();
  const trace: RouteTrace = { requestModel: requestModelName, steps: [], success: false, totalLatencyMs: 0 };

  const chain: any = getChainByName(requestModelName);
  // When routing through a chain, use chain name as sticky key (not individual model names)
  if (chain) trace.stickyKey = chain.name;
  let response: Response | null = null;

  if (chain) {
    let items: any;
    try { items = JSON.parse(chain.items); } catch { items = []; }
    trace.chainName = chain.name;
    trace.chainMode = chain.mode;
    trace.steps.push({ action: "chain_match", model: chain.name });

    // Try sticky deployment BEFORE chain — skip the whole chain trial if sticky works
    if (!trace.skipSticky) {
      const stickyId = getStickyDeployment(chain.name);
      if (stickyId) {
        const allDeps = listDeployments() as Deployment[];
        const stickyDep = allDeps.find(d => d.id === stickyId && d.enabled && !isInCooldown(d.id));
        if (stickyDep) {
          trace.steps.push({ action: "try_sticky", model: stickyDep.modelName, provider: stickyDep.providerName, deploymentId: stickyDep.id });
          const result = await tryDeployment(stickyDep, stickyDep.modelName, path, method, headers, body, isStreaming, trace);
          if (result.final) {
            trace.totalLatencyMs = Date.now() - traceStart;
            return (result as any).response;
          }
          trace.steps.push({ action: "fallback", provider: stickyDep.providerName, error: "sticky deployment failed, falling through to chain" });
          // Clear the failed sticky so chain doesn't try it again via getHealthyDeployments
          clearStickyRoute(chain.name);
        }
      }
    }

    if (chain.mode === "models") response = await routeModelsChain(items, path, method, headers, body, isStreaming, trace);
    else if (chain.mode === "provider") response = await routeProviderChain(items, path, method, headers, body, isStreaming, trace);
    else { const t = Array.isArray(items) ? items[0] : requestModelName; response = await routeModel(t, path, method, headers, body, isStreaming, trace); }
  } else {
    response = await routeModel(requestModelName, path, method, headers, body, isStreaming, trace);
  }

  trace.totalLatencyMs = Date.now() - traceStart;

  if (response) return response;

  trace.steps.push({ action: "fail", error: "all fallbacks exhausted" });
  return new Response(JSON.stringify({
    error: { message: chain ? `All fallbacks exhausted for chain "${requestModelName}" (mode: ${chain.mode})` : `All deployments failed for "${requestModelName}"`, type: "server_error" },
    _trace: trace,
  }), { status: 503, headers: { "Content-Type": "application/json" } });
}

// --- Test endpoint: route with trace only, returns trace info ---
export async function routeTestRequest(requestModelName: string, path: string, method: string, headers: Headers, body: any): Promise<RouteTrace> {
  const traceStart = Date.now();
  const trace: RouteTrace = { requestModel: requestModelName, steps: [], success: false, totalLatencyMs: 0, skipSticky: true };

  const chain: any = getChainByName(requestModelName);
  let response: Response | null = null;

  if (chain) {
    let items: any;
    try { items = JSON.parse(chain.items); } catch { items = []; }
    trace.chainName = chain.name;
    trace.chainMode = chain.mode;
    trace.steps.push({ action: "chain_match", model: chain.name });

    if (chain.mode === "models") response = await routeModelsChain(items, path, method, headers, body, false, trace);
    else if (chain.mode === "provider") response = await routeProviderChain(items, path, method, headers, body, false, trace);
    else { const t = Array.isArray(items) ? items[0] : requestModelName; response = await routeModel(t, path, method, headers, body, false, trace); }
  } else {
    response = await routeModel(requestModelName, path, method, headers, body, false, trace);
  }

  trace.totalLatencyMs = Date.now() - traceStart;
  if (!response) trace.steps.push({ action: "fail", error: "all fallbacks exhausted" });

  return trace;
}

// Direct provider test (bypass routing, for Playground custom mode)
export async function routeTestDirect(modelName: string, provider: any, headers: Headers, body: any): Promise<RouteTrace> {
  const traceStart = Date.now();
  const trace: RouteTrace = { requestModel: modelName, steps: [], success: false, totalLatencyMs: 0 };

  trace.steps.push({ action: "try_deployment", model: modelName, provider: provider.name });

  const baseUrl = provider.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  
  let url: string;
  let outHeaders: Record<string, string> = { "Content-Type": "application/json" };
  let requestBody: any;

  if (provider.apiType === "anthropic") {
    url = `${baseUrl}/v1/messages`;
    outHeaders["x-api-key"] = provider.apiKey;
    outHeaders["anthropic-version"] = headers.get("anthropic-version") || "2023-06-01";
    requestBody = { model: modelName, max_tokens: body.max_tokens || 20, messages: body.messages || [{ role: "user", content: "hi" }] };
  } else if (provider.apiType === "gemini") {
    url = `${baseUrl}/v1beta/models/${modelName}:generateContent`;
    outHeaders["x-goog-api-key"] = provider.apiKey;
    requestBody = { contents: body.contents || [{ parts: [{ text: "hi" }], role: "user" }] };
  } else {
    url = `${baseUrl}/v1/chat/completions`;
    outHeaders["Authorization"] = `Bearer ${provider.apiKey}`;
    requestBody = { model: modelName, max_tokens: body.max_tokens || 20, messages: body.messages || [{ role: "user", content: "hi" }] };
  }

  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    const resp = await fetch(url, { method: "POST", headers: outHeaders, body: JSON.stringify(requestBody), signal: controller.signal });
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - start;

    if (resp.ok) {
      trace.steps.push({ action: "success", provider: provider.name, model: modelName, status: resp.status, latencyMs });
      trace.success = true;
      trace.finalDeployment = { provider: provider.name, model: modelName, deploymentId: "direct-test" };
    } else {
      const errText = await resp.text().catch(() => "");
      trace.steps.push({ action: "fail", provider: provider.name, model: modelName, status: resp.status, error: errText.slice(0, 200) });
    }
  } catch (err: any) {
    trace.steps.push({ action: "fail", provider: provider.name, model: modelName, error: err.message });
  }

  trace.totalLatencyMs = Date.now() - traceStart;
  return trace;
}

