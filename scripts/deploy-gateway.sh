#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-}"
DEPLOY_REF="${CI_COMMIT_SHA:-${1:-HEAD}}"
DEPLOY_TAG="${CI_COMMIT_TAG:-}"
RUN_LINT="${RUN_LINT:-true}"
RUN_TESTS="${RUN_TESTS:-true}"

if [[ -z "${DEPLOY_DIR}" ]]; then
  echo "DEPLOY_DIR is required." >&2
  exit 1
fi

if [[ ! -d "${DEPLOY_DIR}" ]]; then
  echo "DEPLOY_DIR does not exist: ${DEPLOY_DIR}" >&2
  exit 1
fi

if [[ ! -d "${DEPLOY_DIR}/.git" ]]; then
  echo "DEPLOY_DIR must be a git checkout: ${DEPLOY_DIR}" >&2
  exit 1
fi

if [[ ! -f "${DEPLOY_DIR}/.env-gateway" ]]; then
  echo "Missing ${DEPLOY_DIR}/.env-gateway" >&2
  exit 1
fi

echo "Deploy directory: ${DEPLOY_DIR}"
echo "Deploy ref: ${DEPLOY_REF}"

cd "${DEPLOY_DIR}"

git fetch --tags origin
git checkout --force "${DEPLOY_REF}"
git clean -fdx -e .env-gateway -e .tellymcp

PACKAGE_VERSION="$(node -p "require('./package.json').version")"
if [[ -n "${DEPLOY_TAG}" ]]; then
  if [[ "${DEPLOY_TAG}" != "${PACKAGE_VERSION}" && "${DEPLOY_TAG}" != "v${PACKAGE_VERSION}" ]]; then
    echo "Tag ${DEPLOY_TAG} does not match package.json version ${PACKAGE_VERSION}" >&2
    exit 1
  fi
fi

echo "Installing dependencies for ${PACKAGE_VERSION}"
yarn install --frozen-lockfile

if [[ "${RUN_LINT}" == "true" ]]; then
  echo "Running lint"
  yarn lint
fi

if [[ "${RUN_TESTS}" == "true" ]]; then
  echo "Running tests"
  yarn test
fi

echo "Packing npm archive"
rm -f deadragdoll-tellymcp-*.tgz
npm pack

echo "Rebuilding gateway container stack"
docker compose up -d --build --force-recreate

echo "Gateway deployment completed"
docker compose ps
