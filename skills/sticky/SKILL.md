---
name: sticky
description: View and manage LLM Gateway sticky deployments. Use /sticky to list, inspect, set, or clear sticky routing for any model.
user-invocable: true
---

# LLM Gateway Sticky Manager

Gateway URL: `http://localhost:3456`

## Commands

When the user invokes `/sticky` or asks about sticky deployments, call the appropriate API:

### List all sticky deployments
```
GET http://localhost:3456/api/stats
```
Read `.sticky` from the response. Show each key (model/chain name), the `providerName`, `modelName`, `deploymentId`, and remaining TTL (compute from `remainingMs`).

### Set sticky deployment
```
POST http://localhost:3456/api/sticky
Content-Type: application/json
{"modelName": "<model>", "deploymentId": "<deploymentId>", "ttlMs": <optional>}
```

### Clear sticky for a specific model
```
DELETE http://localhost:3456/api/sticky/<model>
```
URL-encode the model name.

### Clear all sticky deployments
```
DELETE http://localhost:3456/api/sticky
```

### Get deployment list (to find valid deploymentIds)
```
GET http://localhost:3456/api/deployments
```

## User input patterns

- `/sticky` → list all current sticky deployments
- `/sticky best-model` → show sticky info for a specific model
- `/sticky set best-model <deploymentId>` → set sticky, optional TTL in ms as 4th arg
- `/sticky clear best-model` → clear sticky for that model
- `/sticky clear` → clear all

## Response format

Always show results in a clean, readable format. For list:
- If no sticky: "目前没有 sticky deployments"
- If sticky exists: list each model → provider/deployment, remaining time in minutes/seconds

For set/clear: confirm success or show error message.

## Notes

- Sticky is stored in memory (lost on gateway restart)
- Default TTL is 2 hours (set by gateway when auto-sticky triggers)
- Manual sticky (via POST) takes priority over auto-sticky
- If a model belongs to a chain, the sticky is set on the chain name automatically
- `deploymentId` is a UUID; get valid ones from `/api/deployments` or run `node sticky.js deployments`
