#!/usr/bin/env bash
set -euo pipefail

DOCKER_IMAGE="${DOCKER_IMAGE:-node:24-bookworm-slim}"

echo "Building TellyMCP package artifact inside ${DOCKER_IMAGE}"

rm -f deadragdoll-tellymcp-*.tgz

docker run --rm \
  -u "$(id -u):$(id -g)" \
  -e HOME=/tmp/tellymcp-build-home \
  -e npm_config_cache=/tmp/tellymcp-npm-cache \
  -v "${PWD}:/work" \
  -w /work \
  "${DOCKER_IMAGE}" \
  bash -lc '
    set -euo pipefail
    mkdir -p "$HOME" "$npm_config_cache"
    npx -y yarn@1.22.22 install --frozen-lockfile
    npx -y yarn@1.22.22 lint
    npx -y yarn@1.22.22 test
    npm pack
  '

echo "Built package artifacts:"
ls -1 deadragdoll-tellymcp-*.tgz
