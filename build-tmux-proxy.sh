#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$SCRIPT_DIR"

PLATFORM="${1:-linux/amd64}"

case "$PLATFORM" in
  */*)
    TARGET_OS="${PLATFORM%%/*}"
    TARGET_ARCH="${PLATFORM##*/}"
    ;;
  *)
    echo "Invalid platform: $PLATFORM"
    echo "Expected format: <os>/<arch>, for example linux/amd64 or darwin/arm64"
    exit 1
    ;;
esac

DEFAULT_OUTPUT_DIR="$SCRIPT_DIR/artifacts"
if [[ "$PLATFORM" != "linux/amd64" ]]; then
  DEFAULT_OUTPUT_DIR="$SCRIPT_DIR/artifacts/${TARGET_OS}-${TARGET_ARCH}"
fi

OUTPUT_DIR="${2:-$DEFAULT_OUTPUT_DIR}"

mkdir -p "$OUTPUT_DIR"

docker build \
  -f Dockerfile.tmux-proxy \
  --build-arg "TARGETOS=$TARGET_OS" \
  --build-arg "TARGETARCH=$TARGET_ARCH" \
  --output "type=local,dest=$OUTPUT_DIR" \
  .

chmod +x "$OUTPUT_DIR/tmux-proxy-go"

echo "tmux-proxy-go ($PLATFORM) exported to: $OUTPUT_DIR/tmux-proxy-go"
