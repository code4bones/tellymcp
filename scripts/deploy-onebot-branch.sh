#!/usr/bin/env bash
set -euo pipefail

GATEWAY_ENV_FILE="${GATEWAY_ENV_FILE:-}"
PROJECT_DIR="${CI_PROJECT_DIR:-$(pwd)}"
PID_FILE="${ONEBOT_PID_FILE:-${HOME}/.tellymcp-onebot.pid}"
LOG_FILE="${ONEBOT_LOG_FILE:-${HOME}/.tellymcp-onebot.log}"

if [[ -z "${GATEWAY_ENV_FILE}" ]]; then
  echo "GATEWAY_ENV_FILE is required." >&2
  exit 1
fi

if [[ ! -d "${PROJECT_DIR}" ]]; then
  echo "Missing project directory: ${PROJECT_DIR}" >&2
  exit 1
fi

if [[ ! -f "${GATEWAY_ENV_FILE}" ]]; then
  echo "Missing gateway env file: ${GATEWAY_ENV_FILE}" >&2
  exit 1
fi

mkdir -p "$(dirname "${PID_FILE}")"
mkdir -p "$(dirname "${LOG_FILE}")"

echo "Project directory: ${PROJECT_DIR}"
echo "Gateway env: ${GATEWAY_ENV_FILE}"
echo "PID file: ${PID_FILE}"
echo "Log file: ${LOG_FILE}"

cd "${PROJECT_DIR}"

if [[ ! -f "dist/cli.js" ]]; then
  echo "Missing dist/cli.js in ${PROJECT_DIR}. Ensure build artifacts are available." >&2
  exit 1
fi

if [[ -f "${PID_FILE}" ]]; then
  EXISTING_PID="$(cat "${PID_FILE}")"
  if [[ -n "${EXISTING_PID}" ]] && kill -0 "${EXISTING_PID}" 2>/dev/null; then
    echo "Stopping previous onebot process ${EXISTING_PID}"
    kill "${EXISTING_PID}" || true
    sleep 2
  fi
  rm -f "${PID_FILE}"
fi

echo "Starting onebot process from current GitLab checkout"
nohup node dist/cli.js run --env "${GATEWAY_ENV_FILE}" >>"${LOG_FILE}" 2>&1 &
NEW_PID="$!"
echo "${NEW_PID}" > "${PID_FILE}"
sleep 3

if ! kill -0 "${NEW_PID}" 2>/dev/null; then
  echo "onebot process failed to start; tailing log" >&2
  tail -n 200 "${LOG_FILE}" >&2 || true
  exit 1
fi

echo "onebot process started: ${NEW_PID}"
tail -n 40 "${LOG_FILE}" || true
