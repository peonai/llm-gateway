import { listDeployments, getModelByName, updateStats, getStats, insertLog } from "./db";

interface Deployment {
  id: string;
  modelId: string;
  providerId: string;
  modelName: string;
  order: number;
  timeout: number;
  maxRetries: number;
  enabled: number;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  apiType: string;
}

interface RouteResult {
  response: Response;
  deployment: Deployment;
  latencyMs: number;
  status: number;
}

// In-memory cooldown tracker
const cooldowns = new Map<string, number>(); // deploymentId -> cooldownUntil timestamp
const consecutiveFails = new Map<string, number>();

const COOLDOWN_BASE = 120_000; // 2 minutes
const MAX_CONSECUTIVE_FAILS = 3;

function isInCooldown(deploymentId: string): boolean {
  const until = cooldowns.get(deploymentId);
  if (!until) return false;
  if (Date.now() >= until) {
    cooldowns.delete(deploymentId);
    consecutiveFails.delete(deploymentId);
    return false;
  }
  return true;
}

function recordSuccess(deploymentId: string) {
  consecutiveFails.set(deploymentId, 0);
  cooldowns.delete(deploymentId);
}

function recordFailure(deploymentId: string) {
  const fails = (consecutiveFails.get(deploymentId) ?? 0) + 1;
  consecutiveFails.set(deploymentId, fails);
  if (fails >= MAX_CONSECUTIVE_FAILS) {
    const cooldownMs = COOLDOWN_BASE * Math.min(fails - MAX_CONSECUTIVE_FAILS + 1, 5);
    cooldowns.set(deploymentId, Date.now() + cooldownMs);
    updateStats(deploymentId, { cooldownUntil: Date.now() + cooldownMs, consecutiveFails: fails });
  }
}

export function getCooldownInfo() {
  const info: Record<string, { until: number; fails: number }> = {};
  for (const [id, until] of cooldowns) {
    if (Date.now() < until) {
      info[id] = { until, fails: consecutiveFails.get(id) ?? 0 };
    }
  }
  return info;
}

async function forwardRequest(
  deployment: Deployment,
  path: string,
  method: string,
  headers: Headers,
  body: any,
  isStreaming: boolean
): Promise<Response> {
  const url = `${deployment.baseUrl.replace(/\/$/, "")}${path}`;

  // Build outgoing headers
  const outHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (deployment.apiType === "anthropic") {
    outHeaders["x-api-key"] = deployment.apiKey;
    outHeaders["anthropic-version"] = headers.get("anthropic-version") || "2023-06-01";
    // Forward anthropic-beta if present
    const beta = headers.get("anthropic-beta");
    if (beta) outHeaders["anthropic-beta"] = beta;
  } else {
    // OpenAI compatible
    outHeaders["Authorization"] = `Bearer ${deployment.apiKey}`;
  }

  // Replace model name in body with the deployment's actual model name
  let requestBody = body;
  if (typeof body === "object") {
    requestBody = { ...body, model: deployment.modelName };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), deployment.timeout * 1000);

  try {
    const resp = await fetch(url, {
      method,
      headers: outHeaders,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return resp;
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error(`Timeout after ${deployment.timeout}s`);
    }
    throw err;
  }
}

export async function routeRequest(
  modelName: string,
  path: string,
  method: string,
  headers: Headers,
  body: any,
  isStreaming: boolean
): Promise<Response> {
  // Find model
  const model: any = getModelByName(modelName);
  if (!model) {
    return new Response(JSON.stringify({ error: { message: `Model "${modelName}" not found`, type: "invalid_request_error" } }), { status: 404, headers: { "Content-Type": "application/json" } });
  }

  // Get deployments sorted by order
  const deployments = listDeployments(model.id) as Deployment[];
  const available = deployments.filter(d => d.enabled && !isInCooldown(d.id));

  if (available.length === 0) {
    // Check if all are in cooldown vs just none configured
    const allCooldown = deployments.filter(d => d.enabled && isInCooldown(d.id));
    if (allCooldown.length > 0) {
      return new Response(JSON.stringify({ error: { message: `All deployments for "${modelName}" are in cooldown`, type: "server_error" } }), { status: 503, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: { message: `No deployments available for "${modelName}"`, type: "invalid_request_error" } }), { status: 404, headers: { "Content-Type": "application/json" } });
  }

  let lastError: string = "";
  let lastStatus: number = 500;

  for (const dep of available) {
    const start = Date.now();
    let retries = dep.maxRetries;

    while (retries >= 0) {
      try {
        const resp = await forwardRequest(dep, path, method, headers, body, isStreaming);
        const latencyMs = Date.now() - start;

        if (resp.ok) {
          // Success
          recordSuccess(dep.id);
          updateStats(dep.id, {
            totalRequests: (getStats(dep.id)?.totalRequests ?? 0) + 1,
            successCount: (getStats(dep.id)?.successCount ?? 0) + 1,
            avgLatencyMs: latencyMs,
            consecutiveFails: 0,
            cooldownUntil: 0,
          });
          insertLog({ model: modelName, deploymentId: dep.id, providerName: dep.providerName, status: resp.status, latencyMs });

          // For streaming, pass through the response as-is
          if (isStreaming && resp.body) {
            return new Response(resp.body, {
              status: resp.status,
              headers: {
                "Content-Type": resp.headers.get("Content-Type") || "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
              },
            });
          }

          // Non-streaming: extract token usage and return
          const respBody = await resp.text();
          try {
            const parsed = JSON.parse(respBody);
            const tokensIn = parsed.usage?.prompt_tokens ?? parsed.usage?.input_tokens ?? 0;
            const tokensOut = parsed.usage?.completion_tokens ?? parsed.usage?.output_tokens ?? 0;
            // Update log with token counts
            insertLog({ model: modelName, deploymentId: dep.id, providerName: dep.providerName, status: resp.status, latencyMs, tokensIn, tokensOut });
          } catch {}

          return new Response(respBody, {
            status: resp.status,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Non-2xx: treat as failure
        const errorBody = await resp.text();
        lastError = errorBody.slice(0, 500);
        lastStatus = resp.status;

        insertLog({ model: modelName, deploymentId: dep.id, providerName: dep.providerName, status: resp.status, latencyMs, error: lastError });
        updateStats(dep.id, {
          totalRequests: (getStats(dep.id)?.totalRequests ?? 0) + 1,
          failCount: (getStats(dep.id)?.failCount ?? 0) + 1,
          lastError: lastError.slice(0, 200),
          lastErrorAt: Date.now(),
        });

        if (retries > 0) {
          retries--;
          await new Promise(r => setTimeout(r, 2000)); // wait 2s before retry
          continue;
        }

        // No more retries, record failure and try next deployment
        recordFailure(dep.id);
        break;
      } catch (err: any) {
        const latencyMs = Date.now() - start;
        lastError = err.message || String(err);
        lastStatus = 502;

        insertLog({ model: modelName, deploymentId: dep.id, providerName: dep.providerName, status: 502, latencyMs, error: lastError });
        updateStats(dep.id, {
          totalRequests: (getStats(dep.id)?.totalRequests ?? 0) + 1,
          failCount: (getStats(dep.id)?.failCount ?? 0) + 1,
          lastError: lastError.slice(0, 200),
          lastErrorAt: Date.now(),
        });

        if (retries > 0) {
          retries--;
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }

        recordFailure(dep.id);
        break;
      }
    }
  }

  // All deployments failed
  return new Response(JSON.stringify({
    error: { message: `All deployments failed for "${modelName}". Last error: ${lastError}`, type: "server_error" }
  }), { status: lastStatus, headers: { "Content-Type": "application/json" } });
}
