#!/usr/bin/env bash
set -euo pipefail

DOCKER_IMAGE="${DOCKER_IMAGE:-node:24-bookworm-slim}"

echo "Building TellyMCP package artifact inside ${DOCKER_IMAGE}"

rm -f deadragdoll-tellymcp-*.tgz

docker run --rm \
  -u "$(id -u):$(id -g)" \
  -v "${PWD}:/work" \
  -w /work \
  "${DOCKER_IMAGE}" \
  bash -lc '
    set -euo pipefail
    corepack enable
    yarn install --frozen-lockfile
    yarn lint
    yarn test
    npm pack
  '

echo "Built package artifacts:"
ls -1 deadragdoll-tellymcp-*.tgz
