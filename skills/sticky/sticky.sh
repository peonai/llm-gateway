#!/usr/bin/env bash
# /sticky - View and manage LLM Gateway sticky deployments
# Usage:
#   /sticky              - Show all sticky deployments
#   /sticky <model>      - Show sticky for a specific model
#   /sticky set <model> <deploymentId> [ttlMs] - Set sticky deployment
#   /sticky clear <model> - Clear sticky for a model
#   /sticky clear        - Clear all sticky deployments

set -euo pipefail

GATEWAY_URL="${LLM_GATEWAY_URL:-http://localhost:3456}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

cmd="${1:-list}"

case "$cmd" in
  list|"")
    # Show all sticky deployments
    response=$(curl -s "$GATEWAY_URL/api/stats")
    sticky=$(echo "$response" | jq -r '.sticky // {}')
    
    if [ "$(echo "$sticky" | jq 'length')"  -eq 0 ]; then
      echo -e "${YELLOW}No sticky deployments${NC}"
      exit 0
    fi
    
    echo -e "${GREEN}Sticky Deployments:${NC}"
    echo "$sticky" | jq -r 'to_entries[] | "\(.key): \(.value.providerName)/\(.value.modelName) (deployment: \(.value.deploymentId), remaining: \((.value.remainingMs / 1000 | floor))s)"'
    ;;
    
  set)
    model="${2:-}"
    deploymentId="${3:-}"
    ttlMs="${4:-}"
    
    if [ -z "$model" ] || [ -z "$deploymentId" ]; then
      echo -e "${RED}Usage: /sticky set <model> <deploymentId> [ttlMs]${NC}"
      exit 1
    fi
    
    payload="{\"modelName\":\"$model\",\"deploymentId\":\"$deploymentId\""
    if [ -n "$ttlMs" ]; then
      payload="$payload,\"ttlMs\":$ttlMs"
    fi
    payload="$payload}"
    
    response=$(curl -s -X POST "$GATEWAY_URL/api/sticky" \
      -H "Content-Type: application/json" \
      -d "$payload")
    
    if echo "$response" | jq -e '.ok' > /dev/null 2>&1; then
      echo -e "${GREEN}✓ Sticky set for $model → $deploymentId${NC}"
    else
      echo -e "${RED}✗ Failed: $(echo "$response" | jq -r '.error // "unknown error"')${NC}"
      exit 1
    fi
    ;;
    
  clear)
    model="${2:-}"
    
    if [ -z "$model" ]; then
      # Clear all
      response=$(curl -s -X DELETE "$GATEWAY_URL/api/sticky")
      if echo "$response" | jq -e '.ok' > /dev/null 2>&1; then
        echo -e "${GREEN}✓ All sticky deployments cleared${NC}"
      else
        echo -e "${RED}✗ Failed${NC}"
        exit 1
      fi
    else
      # Clear specific model
      response=$(curl -s -X DELETE "$GATEWAY_URL/api/sticky/$(echo -n "$model" | jq -sRr @uri)")
      if echo "$response" | jq -e '.ok' > /dev/null 2>&1; then
        echo -e "${GREEN}✓ Sticky cleared for $model${NC}"
      else
        echo -e "${RED}✗ Failed${NC}"
        exit 1
      fi
    fi
    ;;
    
  *)
    # Treat as model name, show sticky for that model
    model="$cmd"
    response=$(curl -s "$GATEWAY_URL/api/stats")
    sticky=$(echo "$response" | jq -r ".sticky.\"$model\" // null")
    
    if [ "$sticky" = "null" ]; then
      echo -e "${YELLOW}No sticky deployment for $model${NC}"
      exit 0
    fi
    
    echo -e "${GREEN}Sticky for $model:${NC}"
    echo "$sticky" | jq -r '"Provider: \(.providerName)\nModel: \(.modelName)\nDeployment: \(.deploymentId)\nRemaining: \((.remainingMs / 1000 | floor))s"'
    ;;
esac
