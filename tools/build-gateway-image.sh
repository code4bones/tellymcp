#!/usr/bin/env bash
set -euo pipefail

mapfile -t archives < <(find . -maxdepth 1 -type f -name 'deadragdoll-tellymcp-*.tgz')
if [[ ${#archives[@]} -ne 1 ]]; then
  echo 'Expected exactly one TellyMCP package artifact.' >&2
  exit 1
fi
version="$(tar -xOf "${archives[0]}" package/package.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')"
if [[ -n "${CI_COMMIT_TAG:-}" && "${CI_COMMIT_TAG}" != "v${version}" ]]; then
  echo "Tag ${CI_COMMIT_TAG} does not match package version ${version}." >&2
  exit 1
fi
revision="${CI_COMMIT_SHA:-$(git rev-parse HEAD)}"
image="${TELLYMCP_IMAGE_REPOSITORY:-tellymcp-gateway}:${version}-${revision:0:12}"

docker build --pull -f Dockerfile.gateway \
  --build-arg "TELLYMCP_VERSION=${version}" \
  --build-arg "VCS_REF=${revision}" -t "${image}" .
docker run --rm --entrypoint node "${image}" -e \
  "require('/usr/local/lib/node_modules/@deadragdoll/tellymcp/node_modules/node-pty'); console.log('Packaged native PTY loaded')"
printf 'TELLYMCP_IMAGE=%s\n' "${image}" > build.env
echo "Built ${image}"
