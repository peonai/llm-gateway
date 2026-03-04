---
name: gateway-ops
description: LLM Gateway 运维管理。查看状态、日志、provider/deployment/chain 管理、sticky 路由、测试路由。当用户提到 gateway、路由、provider、deployment、sticky、/sticky 时激活。
user-invocable: true
---

# LLM Gateway 运维

Gateway 默认地址: `http://localhost:3456`（可通过环境变量 `LLM_GATEWAY_URL` 覆盖）

## 状态检查

### 健康检查
```bash
curl -s http://localhost:3456/health | jq .
```

### 总览统计
```bash
curl -s http://localhost:3456/api/stats | jq '.summary'
```

### 查看所有 provider
```bash
curl -s http://localhost:3456/api/providers | jq '.[] | {name, baseUrl, apiType, tags}'
```

### 查看所有 deployment（含统计）
```bash
curl -s http://localhost:3456/api/stats | jq '.deployments[] | {providerName, modelName, enabled, stats: {totalRequests: .stats.totalRequests, successCount: .stats.successCount, avgLatencyMs: .stats.avgLatencyMs, consecutiveFails: .stats.consecutiveFails}}'
```

### 查看 fallback chains
```bash
curl -s http://localhost:3456/api/chains | jq '.[] | {name, mode, enabled, items: (.items | fromjson)}'
```

### 查看最近请求日志
```bash
curl -s "http://localhost:3456/api/logs?limit=20" | jq '.[] | {model, providerName, status, latencyMs, tokensIn, tokensOut, createdAt: (.createdAt / 1000 | strftime("%H:%M:%S"))}'
```

### 查看 cooldown 状态
```bash
curl -s http://localhost:3456/api/stats | jq '.cooldowns'
```

## 路由测试

### 测试路由（跳过 sticky，遍历所有 deployment）
```bash
curl -s -X POST http://localhost:3456/api/test-route \
  -H "Content-Type: application/json" \
  -d '{"model": "MODEL_NAME"}' | jq '.steps[] | {action, provider, model, status, latencyMs, error}'
```

## Deployment 管理

### 启用/禁用 deployment
```bash
# 禁用
curl -s -X PUT http://localhost:3456/api/deployments/DEPLOYMENT_ID \
  -H "Content-Type: application/json" -d '{"enabled": 0}'
# 启用
curl -s -X PUT http://localhost:3456/api/deployments/DEPLOYMENT_ID \
  -H "Content-Type: application/json" -d '{"enabled": 1}'
```

### 更新 chain 排序
```bash
curl -s -X PUT http://localhost:3456/api/chains/CHAIN_ID \
  -H "Content-Type: application/json" \
  -d '{"items": "[\"model1\",\"model2\"]"}'
```
注意：items 值是 JSON 字符串（字符串化的数组）。

## Sticky 路由管理

Sticky 让 Gateway 记住上次成功的 deployment，后续请求优先走同一个。

### 查看所有 sticky
```bash
curl -s http://localhost:3456/api/stats | jq '.sticky'
```
或使用 CLI 工具：
```bash
node sticky.js
```

### 查看指定模型的 sticky
```bash
node sticky.js <model-name>
```

### 手动设置 sticky
```bash
node sticky.js set <model-name> <deployment-id> [ttl-ms]
```
等效 API：
```
POST /api/sticky
{"modelName": "<model>", "deploymentId": "<id>", "ttlMs": <optional>}
```

### 清除 sticky
```bash
# 清除指定模型
node sticky.js clear <model-name>
# 清除全部
node sticky.js clear
```
等效 API：
```
DELETE /api/sticky/<model-name>   (URL encode model name)
DELETE /api/sticky                (clear all)
```

### 查看所有 deployment ID（设置 sticky 时需要）
```bash
node sticky.js deployments
```

### Sticky 行为说明
- 存在内存中，Gateway 重启后丢失
- 默认 TTL: 2 小时（自动 sticky）
- 手动设置的 sticky 优先级高于自动 sticky
- Chain 级别的 sticky 绑定在 chain name 上，不是单个 model

## 用户指令映射

- `/sticky` 或 `查看 sticky` → 列出所有当前 sticky
- `/sticky <model>` → 查看指定模型的 sticky
- `/sticky set <model> <id>` → 手动设置 sticky
- `/sticky clear [model]` → 清除 sticky
- `gateway 状态` / `网关状态` → 执行健康检查 + 总览统计
- `查看日志` / `最近请求` → 查看最近请求日志
- `测试路由 <model>` → 执行路由测试

## 进程管理

```bash
# 重启
pm2 restart llm-gateway
# 查看日志
pm2 logs llm-gateway --lines 50
# 状态
pm2 show llm-gateway
```

## 注意事项

- Gateway 端口是 **3456**（不是 3000）
- API 路径是 `/api/stats`（不是 `/api/status`）
- pm2 进程名是 `llm-gateway`
- `sticky.js` 位于本 skill 目录下，需要 Node.js 18+（原生 fetch）
