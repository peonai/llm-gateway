# LLM Gateway

轻量级 LLM 代理网关。多 Provider 管理、自动 Fallback、Web UI 监控。

## 快速启动

```bash
# 安装依赖
bun install

# 启动（默认端口 3456）
bun run src/index.ts

# 自定义端口
PORT=4000 bun run src/index.ts
```

打开浏览器：`http://localhost:3456/ui`

## 配置流程

1. **添加 Provider** — Providers 页面，填 name / base URL / API key / 类型（OpenAI 或 Anthropic）
2. **创建 Model** — Models 页面，定义对外模型名（如 `claude-opus`）
3. **添加 Deployment** — 给 Model 绑定 Provider，设置优先级、超时、重试次数
4. **开始使用** — 客户端请求 `http://localhost:3456/v1/chat/completions` 或 `/v1/messages`

## 对接 OpenClaw

在 `openclaw.json` 中添加一个 provider：

```jsonc
{
  "models": {
    "providers": {
      "gateway": {
        "baseUrl": "http://localhost:3456",
        "api": "openai-chat"
      }
    }
  },
  "agents": {
    "defaults": {
      "model": "gateway/claude-opus"
    }
  }
}
```

## API

### 代理端点

| 端点 | 说明 |
|------|------|
| `POST /v1/chat/completions` | OpenAI 兼容 |
| `POST /v1/messages` | Anthropic 兼容 |
| `GET /v1/models` | 列出已配置的模型 |

### 管理端点

| 端点 | 说明 |
|------|------|
| `GET/POST /api/providers` | Provider CRUD |
| `GET/POST /api/models` | Model CRUD |
| `GET/POST /api/deployments` | Deployment CRUD |
| `GET /api/stats` | 统计数据 |
| `GET /api/logs` | 请求日志 |
| `POST /api/providers/:id/test` | 测试连接 |

## Fallback 逻辑

```
请求进来 → 匹配 model → 按优先级排序 deployments
  → 过滤 cooldown 中的 → 依次尝试
    → 成功：返回响应
    → 失败：重试 N 次 → 切下一个 deployment
    → 连续 3 次失败：进入 cooldown（2 分钟）
```

**任何非 2xx 响应都会触发 fallback**，不仅仅是 auth 或 rate limit 错误。

## 技术栈

- **Bun** — Runtime
- **Hono** — Web 框架
- **SQLite** — 存储（bun:sqlite，零额外依赖）
- 前端：单文件 HTML，无构建步骤

## 后台运行

```bash
# systemd（推荐）
# 创建 ~/.config/systemd/user/llm-gateway.service

# 或者简单 nohup
nohup bun run src/index.ts > gateway.log 2>&1 &

# 或者 pm2
pm2 start "bun run src/index.ts" --name llm-gateway
```

## 数据

- 配置和日志存在 `gateway.db`（SQLite，项目根目录）
- 日志自动保留最近 500 条
