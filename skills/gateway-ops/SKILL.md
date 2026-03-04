---
name: gateway-ops
description: LLM Gateway 运维管理。查看状态、日志、provider/deployment/chain 管理、sticky 路由、测试路由。当用户提到 gateway、路由、provider、deployment、sticky、/sticky 时激活。
user-invocable: true
---

# LLM Gateway 运维

Gateway 地址: `http://localhost:3456`（可通过 `LLM_GATEWAY_URL` 环境变量覆盖）

## 认证

管理 API (`/api/*`) 需要 admin key。从环境变量或 `ecosystem.config.cjs` 获取：
```bash
ADMIN_KEY=$(node -e "console.log(require('$HOME/projects/llm-gateway/ecosystem.config.cjs').apps[0].env.ADMIN_KEY)")
```

所有 `/api/*` 请求需带 header：
```bash
-H "x-admin-key: $ADMIN_KEY"
```

代理端点 (`/v1/*`) 需要 `gw-` 前缀的 API key（通过管理 UI 创建）。

健康检查 `GET /health` 无需认证。

## 状态检查

### 健康检查
```bash
curl -s http://localhost:3456/health | jq .
```

### 总览统计
```bash
curl -s -H "x-admin-key: $ADMIN_KEY" http://localhost:3456/api/stats | jq '.summary'
```

### 查看所有 provider
```bash
curl -s -H "x-admin-key: $ADMIN_KEY" http://localhost:3456/api/providers | jq '.[] | {name, baseUrl, apiType, tags}'
```
注意：apiKey 在响应中已遮蔽（`sk-xxx...xxxx`）。

### 查看所有 deployment（含统计）
```bash
curl -s -H "x-admin-key: $ADMIN_KEY" http://localhost:3456/api/stats | jq '.deploymentStats'
```

### 查看 fallback chains
```bash
curl -s -H "x-admin-key: $ADMIN_KEY" http://localhost:3456/api/chains | jq '.[] | {name, mode, enabled, items: (.items | fromjson)}'
```

### 查看最近请求日志
```bash
curl -s -H "x-admin-key: $ADMIN_KEY" "http://localhost:3456/api/logs?limit=20" | jq '.[] | {model, providerName, status, latencyMs, tokensIn, tokensOut, createdAt: (.createdAt / 1000 | strftime("%H:%M:%S"))}'
```

### 查看 cooldown 状态
```bash
curl -s -H "x-admin-key: $ADMIN_KEY" http://localhost:3456/api/stats | jq '.cooldowns'
```

## 路由测试

```bash
curl -s -X POST http://localhost:3456/api/test-route \
  -H "Content-Type: application/json" \
  -H "x-admin-key: $ADMIN_KEY" \
  -d '{"model": "MODEL_NAME"}' | jq '.steps[] | {action, provider, model, status, latencyMs, error}'
```

## Deployment 管理

### 启用/禁用 deployment
```bash
curl -s -X PUT http://localhost:3456/api/deployments/DEPLOYMENT_ID \
  -H "Content-Type: application/json" -H "x-admin-key: $ADMIN_KEY" \
  -d '{"enabled": 0}'  # 0=禁用, 1=启用
```

### 更新 chain 排序
```bash
curl -s -X PUT http://localhost:3456/api/chains/CHAIN_ID \
  -H "Content-Type: application/json" -H "x-admin-key: $ADMIN_KEY" \
  -d '{"items": "[\"model1\",\"model2\"]"}'
```

## Sticky 路由管理

### 查看所有 sticky
```bash
curl -s -H "x-admin-key: $ADMIN_KEY" http://localhost:3456/api/stats | jq '.sticky'
```
或使用 CLI：
```bash
node sticky.js
```

### 手动设置 sticky
```bash
node sticky.js set <model-name> <deployment-id> [ttl-ms]
```

### 清除 sticky
```bash
node sticky.js clear [model-name]  # 不带参数清除全部
```

### 查看所有 deployment ID
```bash
node sticky.js deployments
```

### Sticky 行为
- 存内存，重启丢失
- 默认 TTL 2 小时
- 手动 pin 优先于自动 sticky
- Chain 级别 sticky 绑定在 chain name 上

## 用户指令映射

- `/sticky` → 列出所有 sticky
- `/sticky <model>` → 查看指定模型 sticky
- `/sticky set <model> <id>` → 手动设置
- `/sticky clear [model]` → 清除
- `gateway 状态` → 健康检查 + 统计
- `查看日志` → 最近请求日志
- `测试路由 <model>` → 路由测试

## 进程管理

```bash
# 使用 ecosystem 配置启动/重启（推荐，会加载 ADMIN_KEY）
cd ~/projects/llm-gateway && pm2 start ecosystem.config.cjs
pm2 restart llm-gateway

# 查看日志
pm2 logs llm-gateway --lines 50
```

## 注意事项

- 端口 **3456**（不是 3000）
- API 路径 `/api/stats`（不是 `/api/status`）
- Provider apiKey 在 API 响应中已遮蔽，不会泄露明文
- `gw-` API key 在列表中显示完整（方便复制）
- `sticky.js` 在本 skill 目录下，Node.js 18+
