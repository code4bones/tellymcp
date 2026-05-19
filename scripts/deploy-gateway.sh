#!/usr/bin/env bash
set -euo pipefail

GATEWAY_ENV_FILE="${GATEWAY_ENV_FILE:-}"
DEPLOY_TAG="${CI_COMMIT_TAG:-}"
LOG_HOST_DIR="${LOG_HOST_DIR:-}"

if [[ -z "${GATEWAY_ENV_FILE}" ]]; then
  echo "GATEWAY_ENV_FILE is required." >&2
  exit 1
fi

if [[ ! -f "${GATEWAY_ENV_FILE}" ]]; then
  echo "Missing gateway env file: ${GATEWAY_ENV_FILE}" >&2
  exit 1
fi

ARCHIVE="$(find . -maxdepth 1 -type f -name 'deadragdoll-tellymcp-*.tgz' | sort | tail -n 1)"
if [[ -z "${ARCHIVE}" ]]; then
  echo "No deadragdoll-tellymcp-*.tgz artifact found in current workspace." >&2
  exit 1
fi

extract_package_version() {
  local package_json
  package_json="$(<package.json)"
  sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*$/\1/p' \
    <<<"${package_json}" \
    | head -n 1
}

PACKAGE_VERSION="$(extract_package_version)"
if [[ -z "${PACKAGE_VERSION}" ]]; then
  echo "Failed to extract version from package.json" >&2
  exit 1
fi
if [[ -n "${DEPLOY_TAG}" ]]; then
  if [[ "${DEPLOY_TAG}" != "${PACKAGE_VERSION}" && "${DEPLOY_TAG}" != "v${PACKAGE_VERSION}" ]]; then
    echo "Tag ${DEPLOY_TAG} does not match package.json version ${PACKAGE_VERSION}" >&2
    exit 1
  fi
fi

if [[ -z "${LOG_HOST_DIR}" ]]; then
  LOG_HOST_DIR="$(dirname "${GATEWAY_ENV_FILE}")/.tellymcp"
fi

mkdir -p "${LOG_HOST_DIR}"

export TELLYMCP_VERSION="${PACKAGE_VERSION}"
export GATEWAY_ENV_FILE
export LOG_HOST_DIR

echo "Deploying TellyMCP gateway ${TELLYMCP_VERSION}"
echo "Artifact: ${ARCHIVE}"
echo "Gateway env: ${GATEWAY_ENV_FILE}"
echo "Log host dir: ${LOG_HOST_DIR}"

echo "Rebuilding gateway container stack"
docker compose build --pull tellymcp-gateway
docker compose up -d --force-recreate

echo "Gateway deployment completed"
docker compose ps
