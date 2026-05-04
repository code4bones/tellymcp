#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$SCRIPT_DIR"

OUTPUT_DIR="${1:-$SCRIPT_DIR/artifacts}"

mkdir -p "$OUTPUT_DIR"

docker build \
  -f Dockerfile.tmux-proxy \
  --output "type=local,dest=$OUTPUT_DIR" \
  .

chmod +x "$OUTPUT_DIR/tmux-proxy-go"

echo "tmux-proxy-go exported to: $OUTPUT_DIR/tmux-proxy-go"
