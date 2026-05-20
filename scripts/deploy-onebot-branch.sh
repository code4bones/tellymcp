#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${CI_PROJECT_DIR:-$(pwd)}"

if [[ ! -d "${PROJECT_DIR}" ]]; then
  echo "Missing project directory: ${PROJECT_DIR}" >&2
  exit 1
fi

cd "${PROJECT_DIR}"

PACKAGE_ARCHIVE="$(find . -maxdepth 1 -type f -name 'deadragdoll-tellymcp-*.tgz' | sort | tail -n 1)"

if [[ -z "${PACKAGE_ARCHIVE}" ]]; then
  echo "Missing package archive in ${PROJECT_DIR}. Expected deadragdoll-tellymcp-*.tgz artifact." >&2
  exit 1
fi

echo "Installing TellyMCP from archive: ${PACKAGE_ARCHIVE}"
npm install -g "${PACKAGE_ARCHIVE}"

echo "Installed version:"
tellymcp help | sed -n '1,2p'
