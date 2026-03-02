# LLM Gateway — 轻量级 LLM 代理网关

## 目标
一个轻量、好用的本地 LLM 代理服务。统一管理多个 Provider，自动 fallback，Web UI 配置和监控。

## 核心功能

### 1. Provider & Model 管理
- Web UI 增删改 Provider（name, baseUrl, apiKey, api 类型）
- 支持 OpenAI Chat 和 Anthropic Messages 两种 API 协议
- 每个 Model 可配多个 Provider 部署，指定优先级（order）
- "拉取模型列表"：从 Provider 的 /models 端点获取可用模型

### 2. 智能路由 & Fallback
- 请求进来按 model name 匹配，按 order 优先走便宜的
- **任何非 2xx 响应**都触发 fallback（不只是 auth/rate-limit）
- 超时自动切换（可配超时时间）
- 同一 deployment 重试 N 次后切下一个
- Cooldown：连续失败的 deployment 暂时移出

### 3. 监控面板
- 每个 Provider/Deployment 的：成功率、平均延迟、最近错误
- 请求日志（最近 100 条），显示走了哪个 provider、耗时、状态
- 实时状态：健康/cooldown/offline

### 4. 对外 API
- 暴露 OpenAI 兼容的 /v1/chat/completions（含 streaming）
- 暴露 Anthropic 兼容的 /v1/messages（含 streaming）
- OpenClaw 配一个 provider 指向这个服务即可

## 技术选型

- **Runtime**: Bun（快、轻、原生 TypeScript）
- **后端框架**: Hono（轻量、快、Bun 原生支持）
- **存储**: SQLite（via bun:sqlite，零依赖）
- **前端**: 单文件 HTML + Vanilla JS + CSS（内嵌到后端 serve，不需要构建步骤）
- **部署**: bun run server.ts，无 Docker

## 架构

```
┌─────────────────────────────────────────────┐
│                Web UI (:3456/ui)             │
│   Provider管理 │ Model路由 │ 监控面板       │
└──────────────┬──────────────────────────────┘
               │
┌──────────────▼──────────────────────────────┐
│           Hono Server (:3456)               │
│                                              │
│  /v1/chat/completions  (OpenAI 兼容)        │
│  /v1/messages          (Anthropic 兼容)     │
│  /api/providers        (CRUD)               │
│  /api/models           (CRUD)               │
│  /api/stats            (监控数据)           │
│  /api/logs             (请求日志)           │
│                                              │
│  ┌─────────────────────────────────┐        │
│  │         Router Engine           │        │
│  │  优先级排序 → 重试 → Fallback   │        │
│  │  Cooldown → 健康检查            │        │
│  └─────────────────────────────────┘        │
│                                              │
│  ┌─────────────────────────────────┐        │
│  │     SQLite (config + logs)      │        │
│  └─────────────────────────────────┘        │
└─────────────────────────────────────────────┘
```

## 数据模型

### providers
| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID |
| name | TEXT | 显示名 |
| baseUrl | TEXT | API base URL |
| apiKey | TEXT | API Key |
| apiType | TEXT | "openai" 或 "anthropic" |
| createdAt | INTEGER | 时间戳 |

### models
| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID |
| name | TEXT | 对外模型名（如 claude-opus）|
| createdAt | INTEGER | 时间戳 |

### deployments
| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID |
| modelId | TEXT FK | 关联 model |
| providerId | TEXT FK | 关联 provider |
| modelName | TEXT | Provider 侧的真实模型名 |
| order | INTEGER | 优先级，1 最高 |
| timeout | INTEGER | 超时秒数，默认 60 |
| maxRetries | INTEGER | 重试次数，默认 2 |
| enabled | BOOLEAN | 是否启用 |

### request_logs
| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | UUID |
| model | TEXT | 请求的模型名 |
| deploymentId | TEXT | 实际使用的 deployment |
| status | INTEGER | HTTP 状态码 |
| latencyMs | INTEGER | 耗时 |
| tokensIn | INTEGER | 输入 token |
| tokensOut | INTEGER | 输出 token |
| error | TEXT | 错误信息 |
| createdAt | INTEGER | 时间戳 |

### deployment_stats（内存维护，定期持久化）
| 字段 | 类型 | 说明 |
|------|------|------|
| deploymentId | TEXT | |
| totalRequests | INTEGER | |
| successCount | INTEGER | |
| failCount | INTEGER | |
| avgLatencyMs | REAL | |
| lastError | TEXT | |
| lastErrorAt | INTEGER | |
| cooldownUntil | INTEGER | |
| consecutiveFails | INTEGER | |

## Fallback 逻辑

```
1. 收到请求，匹配 model name
2. 获取该 model 的所有 enabled deployments，按 order 排序
3. 过滤掉处于 cooldown 的 deployments
4. 依次尝试：
   a. 发送请求到 deployment 的 provider
   b. 如果成功（2xx）→ 返回响应，记录日志
   c. 如果失败 → 记录错误，incrementFailCount
      - consecutiveFails >= 3 → 进入 cooldown（120秒）
      - 还有下一个 deployment → 继续尝试
      - 没有了 → 返回最后一个错误
5. Cooldown 到期后自动恢复
```

## UI 设计方向

**风格**: 工业控制台 × 赛博朋克
- 深色主题，黑色背景 + 荧光绿/琥珀色点缀
- 等宽字体为主（JetBrains Mono / Fira Code）
- 状态用颜色编码：绿=健康，琥珀=cooldown，红=offline
- 请求日志像终端输出一样滚动
- 卡片式布局展示 provider 和 model
- 极简动效：状态变化闪烁，数字滚动

**页面**:
1. **Dashboard** — 总览：请求量、成功率、活跃 provider、最近日志
2. **Providers** — 增删改 provider，测试连接，拉取模型列表
3. **Models** — 管理 model 和 deployment 映射，拖拽排序优先级
4. **Logs** — 请求日志表格，可筛选

## API 端点

### 代理端点
- POST /v1/chat/completions — OpenAI 兼容
- POST /v1/messages — Anthropic 兼容

### 管理端点
- GET/POST /api/providers — Provider CRUD
- GET/POST /api/models — Model CRUD
- GET/POST /api/deployments — Deployment CRUD
- GET /api/stats — 监控统计
- GET /api/logs — 请求日志
- POST /api/providers/:id/test — 测试连接
- POST /api/providers/:id/models — 拉取远端模型列表

## 默认端口
- 3456
