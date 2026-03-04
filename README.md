# LLM Gateway

Lightweight LLM API gateway with multi-provider routing, automatic fallback chains, sticky routing, and a built-in management UI.

## Features

- Multi-provider support (OpenAI, Anthropic, and compatible APIs)
- Automatic fallback with health-based routing and exponential backoff
- Sticky routing — successful deployments are preferred for 2 hours (configurable)
- Fallback chains with visual builder (models or provider-based)
- API key management with per-key model restrictions
- Admin authentication for management API
- Request logging with 7-day retention and analytics dashboard
- EMA-based latency tracking for accurate performance metrics

## Why I Built This

Running multiple AI agents means juggling a dozen LLM providers — some cheap but flaky, others reliable but expensive. OpenClaw's built-in failover only triggers on auth and rate-limit errors, which isn't enough when providers go silently degraded or return garbage. I needed a single gateway that sits in front of everything: automatically retries on any failure, sticks to the last working deployment for a while (sticky routing), and lets me manage providers, models, and API keys through a UI instead of editing JSON by hand. This is that gateway.

## Quick Start

### With Bun (recommended)

```bash
bun install
bun run dev
```

### With Node.js (v18+)

```bash
npm install
npm run dev:node
```

> Node.js support uses [tsx](https://github.com/privatenumber/tsx) to run TypeScript directly, [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) for the database, and [@hono/node-server](https://github.com/honojs/node-server) for the HTTP server.

Open `http://localhost:3456/ui` to access the management dashboard.

## Authentication

### Management API (`/api/*`)

Protected by `ADMIN_KEY` environment variable. If not set, the management API is open (suitable for local-only access).

```bash
# Set admin key
export ADMIN_KEY="your-secret-key"

# Access with header
curl -H "x-admin-key: $ADMIN_KEY" http://localhost:3456/api/providers

# Or via Authorization header
curl -H "Authorization: Bearer $ADMIN_KEY" http://localhost:3456/api/providers

# Or via query parameter (for browser/UI access)
curl "http://localhost:3456/api/providers?admin_key=$ADMIN_KEY"
```

### Proxy Endpoints (`/v1/*`)

Protected by gateway API keys (prefix `gw-`). Create keys via the management UI or API.

- If **no API keys exist**: proxy is open (initial setup mode)
- If **API keys exist**: every proxy request must include a valid `gw-` key

```bash
# Via Authorization header
curl -H "Authorization: Bearer gw-xxxxx" http://localhost:3456/v1/messages

# Via x-api-key header (Anthropic-style)
curl -H "x-api-key: gw-xxxxx" http://localhost:3456/v1/messages
```

Keys support per-key model restrictions and usage tracking.

### Health Check

`GET /health` — always accessible, no auth required. Returns `{ ok: true, uptimeMs: <ms> }`.

## Production Deployment (pm2)

```bash
# Using ecosystem config
pm2 start ecosystem.config.cjs

# Or manually with env
ADMIN_KEY=your-key pm2 start "npx tsx src/index.ts" --name llm-gateway
```

## For AI Agents

If you're an AI agent with tool access, read `llms.txt` at the gateway URL for the full API reference:

```
Read http://<gateway-host>:<port>/llms.txt
```

## Configuration

Set port and admin key via environment variables:

```bash
PORT=3456 ADMIN_KEY=your-secret npm run dev:node
```

## API Endpoints

| Endpoint | Auth | Description |
|---|---|---|
| `GET /health` | None | Health check |
| `POST /v1/chat/completions` | API Key (`gw-`) | OpenAI-compatible proxy |
| `POST /v1/messages` | API Key (`gw-`) | Anthropic-compatible proxy |
| `GET /v1/models` | None | List available models |
| `GET /api/providers` | Admin Key | List providers |
| `GET /api/stats` | Admin Key | Gateway statistics + sticky info |
| `GET /api/logs` | Admin Key | Request logs |
| `POST /api/sticky` | Admin Key | Pin deployment to model |
| `GET /api/chains` | Admin Key | List fallback chains |
| `/ui` | None (local) | Management dashboard |

## License

MIT
