import { listDeployments, getModelByName, updateStats, getStats, insertLog, getChainByName, listProviders, getDeployment } from "./db";

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
  lastErrorResponse?: TestResponsePayload;
}

export interface TestResponsePayload {
  status: number;
  contentType: string;
  raw: string;
  body?: any;
  text?: string;
}

export interface RouteTestResult extends RouteTrace {
  response?: TestResponsePayload;
  errorResponse?: TestResponsePayload;
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
const PLAYGROUND_TEST_PATH = "/__playground_test__";
const RESPONSES_API_PATH = "/v1/responses";
const EMBEDDINGS_API_PATH = "/v1/embeddings";
const RERANK_API_PATH = "/v1/rerank";
const RERANK_API_ALT_PATH = "/v1/re-rank";
const RESPONSE_TRACK_TTL_MS = 24 * 60 * 60 * 1000;

type ResponseTransform = "none" | "gemini-chat" | "gemini-embeddings";

interface StoredResponseTarget {
  deploymentId: string;
  requestModel: string;
  expiresAt: number;
}

const responseTargetMap = new Map<string, StoredResponseTarget>();


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


function convertOpenAIToGemini(body: any): any {
  if (!body.messages) return body;
  
  // 分离 system 和其他消息
  const systemMsg = body.messages.find((m: any) => m.role === "system");
  const otherMsgs = body.messages.filter((m: any) => m.role !== "system");
  
  const contents = otherMsgs.map((msg: any, idx: number) => {
    const parts: { text: string }[] = [{ text: msg.content }];
    // 如果有 system 且是第一条 user 消息，把 system 作为前缀
    if (systemMsg && idx === 0 && msg.role === "user") {
      parts[0]!.text = `${systemMsg.content}\n\n${msg.content}`;
    }
    return {
      role: msg.role === "assistant" ? "model" : msg.role,
      parts
    };
  });
  
  const config: any = {};
  if (body.max_tokens) config.maxOutputTokens = body.max_tokens;
  if (body.temperature !== undefined) config.temperature = body.temperature;
  if (body.top_p !== undefined) config.topP = body.top_p;
  if (body.stop) config.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  
  const result: any = { contents };
  if (Object.keys(config).length > 0) {
    result.generationConfig = config;
  }
  
  return result;
}

function convertGeminiToOpenAI(geminiResp: any, model: string): any {
  const candidate = geminiResp.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text || "";
  const usage = geminiResp.usageMetadata;
  
  return {
    id: geminiResp.responseId || "chatcmpl-" + Date.now(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: candidate?.finishReason?.toLowerCase() || "stop"
    }],
    usage: {
      prompt_tokens: usage?.promptTokenCount || 0,
      completion_tokens: usage?.candidatesTokenCount || 0,
      total_tokens: usage?.totalTokenCount || 0
    }
  };
}

function convertOpenAIEmbeddingsToGemini(body: any) {
  const inputItems = Array.isArray(body.input) ? body.input : [body.input];
  return {
    requests: inputItems.map((item: any) => {
      const text = Array.isArray(item) ? item.join(" ") : String(item ?? "");
      return {
        content: { parts: [{ text }] },
        ...(body.task_type ? { taskType: body.task_type } : {}),
        ...(body.title ? { title: body.title } : {}),
        ...(body.dimensions ? { outputDimensionality: body.dimensions } : {}),
      };
    }),
  };
}

function convertGeminiEmbeddingsToOpenAI(geminiResp: any, model: string) {
  const embeddings = Array.isArray(geminiResp?.embeddings) ? geminiResp.embeddings : [];
  const promptTokens = embeddings.reduce((sum: number, item: any) => sum + (item?.statistics?.tokenCount || 0), 0);
  return {
    object: "list",
    data: embeddings.map((item: any, index: number) => ({
      object: "embedding",
      embedding: item?.values || [],
      index,
    })),
    model,
    usage: {
      prompt_tokens: promptTokens,
      total_tokens: promptTokens,
    },
  };
}

function pruneStoredResponses() {
  const now = Date.now();
  for (const [responseId, entry] of responseTargetMap) {
    if (entry.expiresAt <= now) responseTargetMap.delete(responseId);
  }
}

function rememberResponseTarget(responseId: string, deploymentId: string, requestModel: string) {
  pruneStoredResponses();
  responseTargetMap.set(responseId, {
    deploymentId,
    requestModel,
    expiresAt: Date.now() + RESPONSE_TRACK_TTL_MS,
  });
}

export function getStoredResponseModel(responseId: string): string | null {
  pruneStoredResponses();
  return responseTargetMap.get(responseId)?.requestModel || null;
}

function tryParseJson(raw: string, contentType = ""): any | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  const looksJson = contentType.includes("application/json") || text.startsWith("{") || text.startsWith("[");
  if (!looksJson) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function normalizeTextContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item?.type === "text" && typeof item.text === "string") return item.text;
        if (typeof item?.content === "string") return item.content;
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

function convertOpenAIToResponsesInput(body: any) {
  if (body.input !== undefined) return body.input;

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) {
    return [{ role: "user", content: [{ type: "input_text", text: "hi" }] }];
  }

  return messages.map((msg: any) => {
    const role = msg?.role === "assistant" ? "assistant" : msg?.role === "system" ? "system" : "user";
    const defaultType = role === "assistant" ? "output_text" : "input_text";
    const content = Array.isArray(msg?.content)
      ? msg.content.map((part: any) => {
          if (typeof part === "string") return { type: defaultType, text: part };
          const text = typeof part?.text === "string" ? part.text : typeof part?.content === "string" ? part.content : "";
          if (!text) return null;
          const partType = part?.type === "input_text" || part?.type === "output_text" ? part.type : defaultType;
          return { type: partType, text };
        }).filter(Boolean)
      : [{ type: defaultType, text: normalizeTextContent(msg?.content) || String(msg?.content || "") }];
    return { role, content };
  });
}

function extractTextFromSse(raw: string): string {
  if (!raw || !raw.includes("data:")) return "";
  const deltas: string[] = [];
  let completedText = "";

  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const event = JSON.parse(payload);
      if (typeof event?.delta === "string") deltas.push(event.delta);
      if (typeof event?.text === "string") deltas.push(event.text);
      if (typeof event?.response?.output_text === "string") completedText = event.response.output_text;
      if (Array.isArray(event?.response?.output)) {
        const text = event.response.output
          .flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
          .map((part: any) => typeof part?.text === "string" ? part.text : "")
          .filter(Boolean)
          .join("\n\n");
        if (text) completedText = text;
      }
    } catch {}
  }

  return completedText || deltas.join("");
}

function buildResponsesTestBody(body: any, modelName: string) {
  return {
    model: modelName,
    input: convertOpenAIToResponsesInput(body),
    ...(body.max_output_tokens !== undefined ? { max_output_tokens: body.max_output_tokens } : {}),
    ...(body.max_output_tokens === undefined && body.max_tokens !== undefined ? { max_output_tokens: body.max_tokens } : {}),
    ...(body.stream !== undefined ? { stream: body.stream } : {}),
  };
}

function isRerankPath(path: string) {
  return path === RERANK_API_PATH || path === RERANK_API_ALT_PATH;
}

function applyCustomHeaders(target: Record<string, string>, customHeaders?: string) {
  if (!customHeaders) return;
  try {
    Object.assign(target, JSON.parse(customHeaders));
  } catch {}
}

function extractResponseText(body: any, raw: string): string {
  if (!body) return extractTextFromSse(raw) || raw || "";
  if (typeof body === "string") return body;

  if (typeof body?.output_text === "string" && body.output_text) return body.output_text;

  const responsesText = body?.output
    ?.map((item: any) => {
      if (typeof item?.text === "string") return item.text;
      if (!Array.isArray(item?.content)) return "";
      return item.content
        .map((part: any) => {
          if (typeof part?.text === "string") return part.text;
          if (typeof part?.content === "string") return part.content;
          return "";
        })
        .filter(Boolean)
        .join("\n\n");
    })
    .filter(Boolean)
    .join("\n\n");
  if (responsesText) return responsesText;

  const openAiText = body?.choices
    ?.map((choice: any) => normalizeTextContent(choice?.message?.content) || choice?.text || "")
    .filter(Boolean)
    .join("\n\n");
  if (openAiText) return openAiText;

  const anthropicText = normalizeTextContent(body?.content);
  if (anthropicText) return anthropicText;

  const geminiText = body?.candidates
    ?.map((candidate: any) => normalizeTextContent(candidate?.content?.parts?.map((part: any) => part?.text || "")))
    .filter(Boolean)
    .join("\n\n");
  if (geminiText) return geminiText;

  if (typeof body?.output_text === "string") return body.output_text;
  return raw || "";
}

function buildTestResponsePayload(response: Response, raw: string): TestResponsePayload {
  const contentType = response.headers.get("content-type") || "application/json";
  const body = tryParseJson(raw, contentType);
  const text = extractResponseText(body, raw).trim();
  return {
    status: response.status,
    contentType,
    raw,
    body,
    text,
  };
}

async function finalizeTestResult(trace: RouteTrace, response: Response | null): Promise<RouteTestResult> {
  if (!response) {
    return {
      ...trace,
      ...(trace.lastErrorResponse ? { errorResponse: trace.lastErrorResponse } : {}),
    };
  }

  const raw = await response.text().catch(() => "");
  const payload = buildTestResponsePayload(response, raw);
  return {
    ...trace,
    ...(response.ok ? { response: payload } : { errorResponse: payload }),
  };
}

async function forwardRequest(deployment: Deployment, inboundPath: string, method: string, headers: Headers, body: any): Promise<{ resp: Response; responseTransform: ResponseTransform }> {
  const baseUrl = deployment.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  
  let url: string;
  let requestBody: any;
  const isStreaming = body.stream === true;
  let responseTransform: ResponseTransform = "none";
  const isResponsesProvider = deployment.apiType === "openai-responses";
  const isResponsesRequest = inboundPath === RESPONSES_API_PATH;
  const isEmbeddingsRequest = inboundPath === EMBEDDINGS_API_PATH;
  const isRerankRequest = isRerankPath(inboundPath);

  if (isResponsesRequest && !isResponsesProvider) {
    throw new Error(`Provider ${deployment.providerName} does not support /v1/responses`);
  }
  if (!isResponsesRequest && inboundPath !== PLAYGROUND_TEST_PATH && isResponsesProvider) {
    throw new Error(`Provider ${deployment.providerName} only supports /v1/responses`);
  }
  if (deployment.apiType === "gemini" && isRerankRequest) {
    throw new Error(`Provider ${deployment.providerName} does not support rerank`);
  }
  
  if (inboundPath === PLAYGROUND_TEST_PATH) {
    if (deployment.apiType === "anthropic") {
      url = `${baseUrl}/v1/messages`;
      requestBody = {
        model: deployment.modelName,
        max_tokens: body.max_tokens || 20,
        messages: body.messages || [{ role: "user", content: "hi" }],
      };
    } else if (deployment.apiType === "gemini") {
      url = `${baseUrl}/v1beta/models/${deployment.modelName}:generateContent`;
      requestBody = convertOpenAIToGemini(body);
      responseTransform = "gemini-chat";
    } else if (isResponsesProvider) {
      url = `${baseUrl}${RESPONSES_API_PATH}`;
      requestBody = buildResponsesTestBody(body, deployment.modelName);
    } else {
      url = `${baseUrl}/v1/chat/completions`;
      requestBody = { ...body, model: deployment.modelName };
    }
  } else if (isResponsesProvider) {
    url = `${baseUrl}${RESPONSES_API_PATH}`;
    requestBody = { ...body, model: deployment.modelName };
  } else if (deployment.apiType === "gemini" && isEmbeddingsRequest) {
    url = `${baseUrl}/v1beta/models/${deployment.modelName}:batchEmbedContents`;
    requestBody = convertOpenAIEmbeddingsToGemini(body);
    responseTransform = "gemini-embeddings";
  } else if (deployment.apiType === "gemini" && inboundPath.includes("/v1beta/models/")) {
    // Gemini native: use URL from inboundPath, don't modify body
    url = `${baseUrl}${inboundPath}`;
    // Add ?alt=sse for streaming endpoints
    if (inboundPath.includes(":streamGenerateContent")) {
      url += "?alt=sse";
    }
    requestBody = body;
  } else if (deployment.apiType === "gemini") {
    // Gemini via OpenAI format: convert to native
    const endpoint = isStreaming ? "streamGenerateContent" : "generateContent";
    url = `${baseUrl}/v1beta/models/${deployment.modelName}:${endpoint}`;
    if (isStreaming) {
      url += "?alt=sse";
    }
    requestBody = convertOpenAIToGemini(body);
    responseTransform = "gemini-chat";
  } else {
    // OpenAI/Anthropic: replace model name
    url = `${baseUrl}${inboundPath}`;
    requestBody = { ...body, model: deployment.modelName };
  }

  const outHeaders: Record<string, string> = { "Content-Type": "application/json" };

  // Apply custom headers from provider config
  applyCustomHeaders(outHeaders, deployment.customHeaders);

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
    const fetchOptions: any = { 
      method, 
      headers: outHeaders, 
      body: JSON.stringify(requestBody), 
      signal: controller.signal 
    };
    
    // Debug log for Gemini conversions
    if (responseTransform !== "none" && deployment.apiType === "gemini") {
      console.log(`[Gemini Convert] URL: ${url}`);
      console.log(`[Gemini Convert] Body:`, JSON.stringify(requestBody, null, 2));
    }
    
    const resp = await fetch(url, fetchOptions);
    clearTimeout(timeoutId);
    return { resp, responseTransform };
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
      const { resp, responseTransform } = await forwardRequest(dep, path, method, headers, body);
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
              if (responseTransform === "gemini-chat") {
                // Gemini streaming: convert SSE format
                try {
                  const text = new TextDecoder().decode(chunk);
                  const lines = text.split("\n").filter(l => l.trim());
                  for (const line of lines) {
                    if (!line.startsWith("data: ")) continue;
                    const geminiChunk = JSON.parse(line.slice(6));
                    const openaiChunk = {
                      id: "chatcmpl-" + Date.now(),
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model: modelName,
                      choices: [{
                        index: 0,
                        delta: { content: geminiChunk.candidates?.[0]?.content?.parts?.[0]?.text || "" },
                        finish_reason: geminiChunk.candidates?.[0]?.finishReason?.toLowerCase() || null
                      }]
                    };
                    controller.enqueue(new TextEncoder().encode("data: " + JSON.stringify(openaiChunk) + "\n\n"));
                    if (geminiChunk.usageMetadata) {
                      usageData = {
                        tokensIn: geminiChunk.usageMetadata.promptTokenCount || 0,
                        tokensOut: geminiChunk.usageMetadata.candidatesTokenCount || 0
                      };
                    }
                  }
                } catch {}
              } else {
                controller.enqueue(chunk);
                // Extract usage from OpenAI SSE
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
              }
            },
            flush() {
              insertLog({ model: modelName, deploymentId: dep.id, providerName: dep.providerName, status: resp.status, latencyMs, tokensIn: usageData?.tokensIn ?? 0, tokensOut: usageData?.tokensOut ?? 0 });
            },
          });
          return { response: new Response(resp.body.pipeThrough(transform), {
            status: resp.status,
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive",
              "X-Route-Provider": dep.providerName, "X-Route-Model": dep.modelName },
          }), final: true };
        }

        // Non-streaming: extract token stats and log once
        let respBody = await resp.text();
        let tokensIn = 0, tokensOut = 0;
        
        if (responseTransform === "gemini-chat") {
          // Convert Gemini response to OpenAI chat format
          try {
            const geminiResp = JSON.parse(respBody);
            const openaiResp = convertGeminiToOpenAI(geminiResp, modelName);
            respBody = JSON.stringify(openaiResp);
            tokensIn = openaiResp.usage.prompt_tokens;
            tokensOut = openaiResp.usage.completion_tokens;
          } catch (e) {
            console.error(`[Gemini Convert] Failed:`, e);
          }
        } else if (responseTransform === "gemini-embeddings") {
          try {
            const geminiResp = JSON.parse(respBody);
            const openaiResp = convertGeminiEmbeddingsToOpenAI(geminiResp, modelName);
            respBody = JSON.stringify(openaiResp);
            tokensIn = openaiResp.usage.prompt_tokens;
            tokensOut = 0;
          } catch (e) {
            console.error(`[Gemini Embeddings Convert] Failed:`, e);
          }
        } else {
          try {
            const parsed = JSON.parse(respBody);
            tokensIn = parsed.usage?.prompt_tokens ?? parsed.usage?.input_tokens ?? 0;
            tokensOut = parsed.usage?.completion_tokens ?? parsed.usage?.output_tokens ?? 0;
            if (path === RESPONSES_API_PATH && typeof parsed?.id === "string") {
              rememberResponseTarget(parsed.id, dep.id, modelName);
            }
          } catch (e) {
            console.error(`[Token Parse] Failed:`, e);
          }
        }
        
        insertLog({ model: modelName, deploymentId: dep.id, providerName: dep.providerName, status: resp.status, latencyMs, tokensIn, tokensOut });

        return { response: new Response(respBody, { status: resp.status, headers: { "Content-Type": resp.headers.get("content-type") || "application/json", "X-Route-Provider": dep.providerName, "X-Route-Model": dep.modelName } }), final: true };
      }

      const errorBody = await resp.text();
      lastError = errorBody.slice(0, 500);
      lastStatus = resp.status;
      trace.lastErrorResponse = buildTestResponsePayload(resp, errorBody);
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
      trace.lastErrorResponse = {
        status: 502,
        contentType: "text/plain",
        raw: lastError,
        text: lastError,
      };
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

export async function routeRetrieveResponse(responseId: string): Promise<Response> {
  pruneStoredResponses();
  const target = responseTargetMap.get(responseId);
  if (!target) {
    return new Response(JSON.stringify({ error: { message: `Unknown response id \"${responseId}\"`, type: "not_found_error" } }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const dep: any = getDeployment(target.deploymentId);
  if (!dep) {
    responseTargetMap.delete(responseId);
    return new Response(JSON.stringify({ error: { message: `Deployment for response \"${responseId}\" no longer exists`, type: "not_found_error" } }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const baseUrl = dep.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const outHeaders: Record<string, string> = {};
  applyCustomHeaders(outHeaders, dep.customHeaders);
  outHeaders["Authorization"] = `Bearer ${dep.apiKey}`;

  try {
    const resp = await fetch(`${baseUrl}${RESPONSES_API_PATH}/${encodeURIComponent(responseId)}`, {
      method: "GET",
      headers: outHeaders,
      signal: AbortSignal.timeout(Math.max((dep.timeout || 30) * 1000, 5000)),
    });
    const bodyText = await resp.text();
    return new Response(bodyText, {
      status: resp.status,
      headers: {
        "Content-Type": resp.headers.get("content-type") || "application/json",
        "X-Route-Provider": dep.providerName,
        "X-Route-Model": dep.modelName,
      },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: { message: err.message || String(err), type: "server_error" } }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// --- Test endpoint: route with trace only, returns trace info ---
export async function routeTestRequest(requestModelName: string, path: string, method: string, headers: Headers, body: any): Promise<RouteTestResult> {
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

  return finalizeTestResult(trace, response);
}

// Direct provider test (bypass routing, for Playground custom mode)
export async function routeTestDirect(modelName: string, provider: any, headers: Headers, body: any): Promise<RouteTestResult> {
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
    requestBody = body.contents ? { contents: body.contents } : convertOpenAIToGemini(body);
  } else if (provider.apiType === "openai-responses") {
    url = `${baseUrl}${RESPONSES_API_PATH}`;
    outHeaders["Authorization"] = `Bearer ${provider.apiKey}`;
    requestBody = buildResponsesTestBody(body, modelName);
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
      const errText = await resp.clone().text().catch(() => "");
      trace.lastErrorResponse = buildTestResponsePayload(resp, errText);
      trace.steps.push({ action: "fail", provider: provider.name, model: modelName, status: resp.status, error: errText.slice(0, 200) });
    }
    trace.totalLatencyMs = Date.now() - traceStart;
    return finalizeTestResult(trace, resp);
  } catch (err: any) {
    trace.lastErrorResponse = {
      status: 502,
      contentType: "text/plain",
      raw: err.message,
      text: err.message,
    };
    trace.steps.push({ action: "fail", provider: provider.name, model: modelName, error: err.message });
  }

  trace.totalLatencyMs = Date.now() - traceStart;
  return finalizeTestResult(trace, null);
}

export { PLAYGROUND_TEST_PATH };
