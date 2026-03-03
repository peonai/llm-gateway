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

// Clean request body for OpenAI providers - strip Anthropic-specific fields
function cleanForOpenAI(body: any): any {
  const cleaned = { ...body };
  // Clean messages - strip cache_control and other Anthropic-specific fields from content
  if (cleaned.messages && Array.isArray(cleaned.messages)) {
    cleaned.messages = cleaned.messages.map((m: any) => {
      const msg: any = { role: m.role };
      if (typeof m.content === "string") {
        msg.content = m.content;
      } else if (Array.isArray(m.content)) {
        // Clean each content block
        msg.content = m.content.map((block: any) => {
          if (typeof block === "string") return block;
          // Remove cache_control and keep only OpenAI-compatible fields
          const { cache_control, ...rest } = block;
          return rest;
        });
      } else {
        msg.content = m.content;
      }
      return msg;
    });
  }
  // Remove Anthropic-specific top-level fields
  delete cleaned.system; // OpenAI uses messages with role "system"
  return cleaned;
}

async function forwardRequest(deployment: Deployment, inboundPath: string, method: string, headers: Headers, body: any): Promise<{ resp: Response; needsResponseConversion: "toAnthropic" | "toOpenAI" | null }> {
  // Determine the correct outbound path based on provider type
  // If inbound is OpenAI format but provider is Anthropic (or vice versa), convert
  const isInboundOpenAI = inboundPath.includes("/chat/completions");
  const isProviderAnthropic = deployment.apiType === "anthropic";

  let outPath: string;
  let requestBody: any;
  let needsResponseConversion: "toAnthropic" | "toOpenAI" | null = null;

  if (isInboundOpenAI && isProviderAnthropic) {
    // OpenAI -> Anthropic: convert format, need to convert response back to OpenAI
    outPath = "/v1/messages";
    requestBody = convertOpenAIToAnthropic(body, deployment.modelName);
    needsResponseConversion = "toOpenAI";
  } else if (!isInboundOpenAI && !isProviderAnthropic) {
    // Anthropic -> OpenAI: convert format, need to convert response back to Anthropic
    outPath = "/v1/chat/completions";
    requestBody = convertAnthropicToOpenAI(body, deployment.modelName);
    needsResponseConversion = "toAnthropic";
  } else if (!isProviderAnthropic) {
    // OpenAI -> OpenAI: pass through but clean Anthropic-specific fields
    outPath = "/v1/chat/completions";
    requestBody = cleanForOpenAI({ ...body, model: deployment.modelName });
  } else {
    // Anthropic -> Anthropic: pass through
    outPath = "/v1/messages";
    requestBody = { ...body, model: deployment.modelName };
  }

  // Auto-handle /v1 path for OpenAI-type providers
  let baseUrl = deployment.baseUrl.replace(/\/$/, "");
  if (!isProviderAnthropic && !baseUrl.endsWith("/v1")) {
    baseUrl += "/v1";
  }

  const url = `${baseUrl}${outPath.startsWith("/v1") ? outPath.slice(3) : outPath}`;
  const outHeaders: Record<string, string> = { "Content-Type": "application/json" };

  // Apply custom headers from provider config
  if (deployment.customHeaders) {
    try {
      const custom = JSON.parse(deployment.customHeaders);
      Object.assign(outHeaders, custom);
    } catch {}
  }

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
    return { resp, needsResponseConversion };
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
    // System can be string or array of content blocks
    const systemContent = typeof body.system === "string"
      ? body.system
      : (Array.isArray(body.system) ? body.system.map((b: any) => b.text || "").join("") : String(body.system));
    messages.push({ role: "system", content: systemContent });
  }
  (body.messages || []).forEach((m: any) => {
    let content: string;
    if (typeof m.content === "string") {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      // Extract text from content blocks, stripping cache_control and other Anthropic-specific fields
      content = m.content.map((block: any) => {
        if (typeof block === "string") return block;
        if (block.type === "text") return block.text || "";
        if (block.type === "image") {
          // Convert Anthropic image format to OpenAI format
          return ""; // Skip images for now in text conversion
        }
        return "";
      }).join("");
    } else {
      content = String(m.content);
    }
    messages.push({ role: m.role, content });
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

// --- Response converters ---
function convertOpenAIResponseToAnthropic(openaiResp: any, modelName: string): any {
  // Convert OpenAI chat completion response to Anthropic messages response
  const choice = openaiResp.choices?.[0];
  const message = choice?.message;
  const content = message?.content || "";

  return {
    id: openaiResp.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: modelName,
    content: [{ type: "text", text: content }],
    stop_reason: choice?.finish_reason === "stop" ? "end_turn" : (choice?.finish_reason || "end_turn"),
    stop_sequence: null,
    usage: {
      input_tokens: openaiResp.usage?.prompt_tokens || 0,
      output_tokens: openaiResp.usage?.completion_tokens || 0,
    },
  };
}

function convertAnthropicResponseToOpenAI(anthropicResp: any, modelName: string): any {
  // Convert Anthropic messages response to OpenAI chat completion response
  const content = anthropicResp.content || [];
  const textContent = content.map((c: any) => c.type === "text" ? c.text : "").join("");

  return {
    id: anthropicResp.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [{
      index: 0,
      message: { role: "assistant", content: textContent },
      finish_reason: anthropicResp.stop_reason === "end_turn" ? "stop" : (anthropicResp.stop_reason || "stop"),
    }],
    usage: {
      prompt_tokens: anthropicResp.usage?.input_tokens || 0,
      completion_tokens: anthropicResp.usage?.output_tokens || 0,
      total_tokens: (anthropicResp.usage?.input_tokens || 0) + (anthropicResp.usage?.output_tokens || 0),
    },
  };
}

// --- Streaming response converters ---
function convertOpenAIStreamToAnthropic(stream: ReadableStream<Uint8Array>, modelName: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let messageStartSent = false;
  let contentBlockStartSent = false;
  const msgId = `msg_${Date.now()}`;

  return new ReadableStream({
    async start(controller) {
      const reader = stream.getReader();

      // Send message_start event first
      const messageStart = {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          model: modelName,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      };
      controller.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`));
      messageStartSent = true;

      // Send content_block_start
      controller.enqueue(encoder.encode(`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`));
      contentBlockStartSent = true;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6).trim();
              if (data === "[DONE]") {
                // Send content_block_stop
                controller.enqueue(encoder.encode(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`));
                // Send message_delta with stop_reason
                controller.enqueue(encoder.encode(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}}\n\n`));
                // Send message_stop
                controller.enqueue(encoder.encode(`event: message_stop\ndata: {"type":"message_stop"}\n\n`));
                continue;
              }
              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta;
                const content = delta?.content;
                if (content) {
                  const anthropicDelta = {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: content }
                  };
                  controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(anthropicDelta)}\n\n`));
                }
                // Check for finish_reason
                const finishReason = parsed.choices?.[0]?.finish_reason;
                if (finishReason) {
                  controller.enqueue(encoder.encode(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`));
                  const stopReason = finishReason === "stop" ? "end_turn" : finishReason;
                  controller.enqueue(encoder.encode(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"${stopReason}","stop_sequence":null},"usage":{"output_tokens":0}}\n\n`));
                  controller.enqueue(encoder.encode(`event: message_stop\ndata: {"type":"message_stop"}\n\n`));
                }
              } catch {}
            }
          }
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    }
  });
}

function convertAnthropicStreamToOpenAI(stream: ReadableStream<Uint8Array>, modelName: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  const chatId = `chatcmpl-${Date.now()}`;

  return new ReadableStream({
    async start(controller) {
      const reader = stream.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          let currentEvent = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              const data = line.slice(6).trim();
              try {
                const parsed = JSON.parse(data);

                if (currentEvent === "content_block_delta" && parsed.delta?.type === "text_delta") {
                  const openaiChunk = {
                    id: chatId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: modelName,
                    choices: [{
                      index: 0,
                      delta: { content: parsed.delta.text },
                      finish_reason: null
                    }]
                  };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`));
                } else if (currentEvent === "message_delta" && parsed.delta?.stop_reason) {
                  const finishReason = parsed.delta.stop_reason === "end_turn" ? "stop" : parsed.delta.stop_reason;
                  const openaiChunk = {
                    id: chatId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: modelName,
                    choices: [{
                      index: 0,
                      delta: {},
                      finish_reason: finishReason
                    }]
                  };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`));
                } else if (currentEvent === "message_stop") {
                  controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
                }
              } catch {}
              currentEvent = "";
            }
          }
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    }
  });
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
      const { resp, needsResponseConversion } = await forwardRequest(dep, path, method, headers, body);
      const latencyMs = Date.now() - start;


      if (resp.ok) {
        recordSuccess(dep.id, modelName);
        updateStats(dep.id, {
          totalRequests: (getStats(dep.id)?.totalRequests ?? 0) + 1,
          successCount: (getStats(dep.id)?.successCount ?? 0) + 1,
          avgLatencyMs: latencyMs, consecutiveFails: 0, cooldownUntil: 0,
        });
        insertLog({ model: modelName, deploymentId: dep.id, providerName: dep.providerName, status: resp.status, latencyMs });

        trace.steps.push({ action: "success", model: dep.modelName, provider: dep.providerName, status: resp.status, latencyMs });
        trace.finalDeployment = { provider: dep.providerName, model: dep.modelName, deploymentId: dep.id };
        trace.success = true;
        if (!trace.skipSticky) setStickyDeployment(trace.stickyKey || modelName, dep.id);

        // For streaming, handle format conversion if needed
        if (isStreaming && resp.body) {
          if (needsResponseConversion === "toAnthropic") {
            const convertedStream = convertOpenAIStreamToAnthropic(resp.body, dep.modelName);
            return { response: new Response(convertedStream, {
              status: resp.status,
              headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive",
                "X-Route-Provider": dep.providerName, "X-Route-Model": dep.modelName },
            }), final: true };
          } else if (needsResponseConversion === "toOpenAI") {
            const convertedStream = convertAnthropicStreamToOpenAI(resp.body, dep.modelName);
            return { response: new Response(convertedStream, {
              status: resp.status,
              headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive",
                "X-Route-Provider": dep.providerName, "X-Route-Model": dep.modelName },
            }), final: true };
          }
          // No conversion needed, pass through
          return { response: new Response(resp.body, {
            status: resp.status,
            headers: { "Content-Type": resp.headers.get("Content-Type") || "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive",
              "X-Route-Provider": dep.providerName, "X-Route-Model": dep.modelName },
          }), final: true };
        }

        let respBody = await resp.text();

        try {
          let parsed = JSON.parse(respBody);
          const tokensIn = parsed.usage?.prompt_tokens ?? parsed.usage?.input_tokens ?? 0;
          const tokensOut = parsed.usage?.completion_tokens ?? parsed.usage?.output_tokens ?? 0;
          if (tokensIn || tokensOut) insertLog({ model: modelName, deploymentId: dep.id, providerName: dep.providerName, status: resp.status, latencyMs, tokensIn, tokensOut });

          // Convert response format if needed
          if (needsResponseConversion === "toAnthropic") {
            parsed = convertOpenAIResponseToAnthropic(parsed, dep.modelName);
            respBody = JSON.stringify(parsed);
          } else if (needsResponseConversion === "toOpenAI") {
            parsed = convertAnthropicResponseToOpenAI(parsed, dep.modelName);
            respBody = JSON.stringify(parsed);
          }
        } catch {}

        return { response: new Response(respBody, { status: resp.status, headers: { "Content-Type": "application/json", "X-Route-Provider": dep.providerName, "X-Route-Model": dep.modelName } }), final: true };
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
        const [sticky] = deps.splice(stickyIdx, 1);
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
          const result = await tryDeployment(stickyDep as Deployment, stickyDep.modelName, path, method, headers, body, isStreaming, trace);
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

  const isAnthropic = provider.apiType === "anthropic";
  const path = isAnthropic ? "/v1/messages" : "/v1/chat/completions";

  // Auto-handle /v1 path for OpenAI-type providers
  let baseUrl = provider.baseUrl.replace(/\/$/, "");
  if (!isAnthropic && !baseUrl.endsWith("/v1")) {
    baseUrl += "/v1";
  }

  const url = `${baseUrl}${path.startsWith("/v1") ? path.slice(3) : path}`;

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

