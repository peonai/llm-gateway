import { listDeployments, getModelByName, updateStats, getStats, insertLog, getChainByName, listProviders } from "./db";

interface Deployment {
  id: string; modelId: string; providerId: string; modelName: string;
  order: number; timeout: number; maxRetries: number; enabled: number;
  providerName: string; baseUrl: string; apiKey: string; apiType: string;
}

export interface RouteTrace {
  requestModel: string;
  chainName?: string;
  chainMode?: string;
  steps: RouteStep[];
  finalDeployment?: { provider: string; model: string; deploymentId: string };
  success: boolean;
  totalLatencyMs: number;
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

function recordSuccess(deploymentId: string) {
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

async function forwardRequest(deployment: Deployment, inboundPath: string, method: string, headers: Headers, body: any): Promise<Response> {
  // Determine the correct outbound path based on provider type
  // If inbound is OpenAI format but provider is Anthropic (or vice versa), convert
  const isInboundOpenAI = inboundPath.includes("/chat/completions");
  const isProviderAnthropic = deployment.apiType === "anthropic";

  let outPath: string;
  let requestBody: any;

  if (isInboundOpenAI && isProviderAnthropic) {
    // OpenAI -> Anthropic: convert format
    outPath = "/v1/messages";
    requestBody = convertOpenAIToAnthropic(body, deployment.modelName);
  } else if (!isInboundOpenAI && !isProviderAnthropic) {
    // Anthropic -> OpenAI: convert format
    outPath = "/v1/chat/completions";
    requestBody = convertAnthropicToOpenAI(body, deployment.modelName);
  } else {
    // Same protocol, pass through
    outPath = isProviderAnthropic ? "/v1/messages" : "/v1/chat/completions";
    requestBody = { ...body, model: deployment.modelName };
  }

  const url = `${deployment.baseUrl.replace(/\/$/, "")}${outPath}`;
  const outHeaders: Record<string, string> = { "Content-Type": "application/json" };

  if (isProviderAnthropic) {
    outHeaders["x-api-key"] = deployment.apiKey;
    outHeaders["anthropic-version"] = headers.get("anthropic-version") || "2023-06-01";
    const beta = headers.get("anthropic-beta");
    if (beta) outHeaders["anthropic-beta"] = beta;
  } else {
    outHeaders["Authorization"] = `Bearer ${deployment.apiKey}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), deployment.timeout * 1000);
  try {
    const resp = await fetch(url, { method, headers: outHeaders, body: JSON.stringify(requestBody), signal: controller.signal });
    clearTimeout(timeoutId);
    return resp;
  } catch (err: any) {
    clearTimeout(timeoutId);
    throw err.name === "AbortError" ? new Error(`Timeout after ${deployment.timeout}s`) : err;
  }
}

// --- Protocol converters ---
function convertOpenAIToAnthropic(body: any, modelName: string): any {
  const messages = (body.messages || []).map((m: any) => ({
    role: m.role === "system" ? "user" : m.role,
    content: m.content,
  }));
  // Extract system message
  const systemMsg = (body.messages || []).find((m: any) => m.role === "system");
  const result: any = {
    model: modelName,
    messages: messages.filter((m: any) => m.role !== "system" || !systemMsg),
    max_tokens: body.max_tokens || body.max_completion_tokens || 4096,
  };
  if (systemMsg) result.system = systemMsg.content;
  if (body.stream) result.stream = true;
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  return result;
}

function convertAnthropicToOpenAI(body: any, modelName: string): any {
  const messages: any[] = [];
  if (body.system) {
    messages.push({ role: "system", content: body.system });
  }
  (body.messages || []).forEach((m: any) => {
    messages.push({ role: m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) });
  });
  const result: any = {
    model: modelName,
    messages,
    max_tokens: body.max_tokens || 4096,
  };
  if (body.stream) result.stream = true;
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  return result;
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
      const resp = await forwardRequest(dep, path, method, headers, body);
      const latencyMs = Date.now() - start;

      if (resp.ok) {
        recordSuccess(dep.id);
        updateStats(dep.id, {
          totalRequests: (getStats(dep.id)?.totalRequests ?? 0) + 1,
          successCount: (getStats(dep.id)?.successCount ?? 0) + 1,
          avgLatencyMs: latencyMs, consecutiveFails: 0, cooldownUntil: 0,
        });
        insertLog({ model: modelName, deploymentId: dep.id, providerName: dep.providerName, status: resp.status, latencyMs });

        trace.steps.push({ action: "success", model: dep.modelName, provider: dep.providerName, status: resp.status, latencyMs });
        trace.finalDeployment = { provider: dep.providerName, model: dep.modelName, deploymentId: dep.id };
        trace.success = true;

        if (isStreaming && resp.body) {
          return { response: new Response(resp.body, {
            status: resp.status,
            headers: { "Content-Type": resp.headers.get("Content-Type") || "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive",
              "X-Route-Trace": JSON.stringify(trace) },
          }), final: true };
        }

        const respBody = await resp.text();
        try {
          const parsed = JSON.parse(respBody);
          const tokensIn = parsed.usage?.prompt_tokens ?? parsed.usage?.input_tokens ?? 0;
          const tokensOut = parsed.usage?.completion_tokens ?? parsed.usage?.output_tokens ?? 0;
          if (tokensIn || tokensOut) insertLog({ model: modelName, deploymentId: dep.id, providerName: dep.providerName, status: resp.status, latencyMs, tokensIn, tokensOut });
        } catch {}

        return { response: new Response(respBody, { status: resp.status, headers: { "Content-Type": "application/json", "X-Route-Trace": JSON.stringify(trace) } }), final: true };
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

      if (retries > 0) { retries--; await new Promise(r => setTimeout(r, 2000)); continue; }
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
      if (retries > 0) { retries--; await new Promise(r => setTimeout(r, 2000)); continue; }
      recordFailure(dep.id);
      break;
    }
  }
  return { error: lastError, status: lastStatus, final: false };
}

function getHealthyDeployments(modelName: string): Deployment[] {
  const model: any = getModelByName(modelName);
  if (!model) return [];
  return (listDeployments(model.id) as Deployment[]).filter(d => d.enabled && !isInCooldown(d.id));
}

async function routeModel(modelName: string, path: string, method: string, headers: Headers, body: any, isStreaming: boolean, trace: RouteTrace): Promise<Response | null> {
  trace.steps.push({ action: "try_model", model: modelName });
  const deps = getHealthyDeployments(modelName);
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
  let response: Response | null = null;

  if (chain) {
    let items: any;
    try { items = JSON.parse(chain.items); } catch { items = []; }
    trace.chainName = chain.name;
    trace.chainMode = chain.mode;
    trace.steps.push({ action: "chain_match", model: chain.name });

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
  const trace: RouteTrace = { requestModel: requestModelName, steps: [], success: false, totalLatencyMs: 0 };

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

  const isAnthropic = provider.apiType === "anthropic";
  const path = isAnthropic ? "/v1/messages" : "/v1/chat/completions";
  const url = `${provider.baseUrl.replace(/\/$/, "")}${path}`;

  const outHeaders: Record<string, string> = { "Content-Type": "application/json" };
  if (isAnthropic) {
    outHeaders["x-api-key"] = provider.apiKey;
    outHeaders["anthropic-version"] = headers.get("anthropic-version") || "2023-06-01";
  } else {
    outHeaders["Authorization"] = `Bearer ${provider.apiKey}`;
  }

  let requestBody: any;
  if (isAnthropic) {
    requestBody = { model: modelName, max_tokens: body.max_tokens || 20, messages: body.messages || [{ role: "user", content: "hi" }] };
  } else {
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
      trace.finalDeployment = { provider: provider.name, model: modelName };
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
