#!/usr/bin/env bash
set -euo pipefail

export REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
export REDIS_PORT="${REDIS_PORT:-6379}"
export REDIS_DB="${REDIS_DB:-0}"

export MCP_HTTP_HOST="${MCP_HTTP_HOST:-0.0.0.0}"
export MCP_HTTP_PORT="${MCP_HTTP_PORT:-8787}"
export MCP_HTTP_PATH="${MCP_HTTP_PATH:-/mcp}"

mkdir -p /var/log/telegram-human-mcp /run/redis /var/lib/redis

redis-server /etc/redis/redis.conf &
REDIS_PID=$!

node /app/dist/app/http.js &
APP_PID=$!

terminate() {
  kill -TERM "$APP_PID" "$REDIS_PID" 2>/dev/null || true
  wait "$APP_PID" "$REDIS_PID" 2>/dev/null || true
}

trap terminate SIGINT SIGTERM

wait -n "$REDIS_PID" "$APP_PID"
STATUS=$?
terminate
exit "$STATUS"
