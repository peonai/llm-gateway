# LLM Gateway

Lightweight LLM API gateway with multi-provider routing, automatic fallback chains, sticky routing, and a built-in management UI.

## Features

- Multi-provider support (OpenAI, Anthropic, and compatible APIs)
- Automatic fallback with health-based routing
- Sticky routing — successful deployments are preferred for 2 hours (configurable)
- Fallback chains with visual builder
- API key management with per-key model restrictions
- Request logging and analytics dashboard
- Protocol auto-conversion (OpenAI ↔ Anthropic)

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

## Configuration

Set the port via environment variable:

```bash
PORT=8080 bun run dev
PORT=8080 npm run dev:node
```

## API Endpoints

| Endpoint | Description |
|---|---|
| `POST /v1/chat/completions` | OpenAI-compatible proxy |
| `POST /v1/messages` | Anthropic-compatible proxy |
| `GET /v1/models` | List available models |
| `GET /api/stats` | Gateway statistics |
| `/ui` | Management dashboard |

## License

MIT
