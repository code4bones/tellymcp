#!/usr/bin/env bash
set -euo pipefail

DOCKER_IMAGE="${DOCKER_IMAGE:-tellymcp-build:node24}"

docker build --pull -f Dockerfile.build -t "${DOCKER_IMAGE}" .

echo "Building TellyMCP package artifact inside ${DOCKER_IMAGE}"

rm -f deadragdoll-tellymcp-*.tgz

# Keep queue regression checks on a dedicated PostgreSQL container/network.
# Only IDs created by this invocation are removed by the exit trap.
test_network_id=""
test_postgres_id=""
cleanup_test_database() {
  if [[ -n "$test_postgres_id" ]]; then docker rm -f "$test_postgres_id" >/dev/null 2>&1 || true; fi
  if [[ -n "$test_network_id" ]]; then docker network rm "$test_network_id" >/dev/null 2>&1 || true; fi
}
trap cleanup_test_database EXIT
test_network_id="$(docker network create "tellymcp-package-test-${CI_JOB_ID:-$$}")"
test_postgres_id="$(docker run --rm -d --network "$test_network_id" \
  --network-alias tellymcp-test-db -e POSTGRES_PASSWORD=tellymcp-ci-test postgres:17-alpine)"

docker run --rm \
  --network "$test_network_id" \
  -e TELLY_TEST_POSTGRES_URL=postgres://postgres:tellymcp-ci-test@tellymcp-test-db:5432/postgres \
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
