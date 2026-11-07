#!/usr/bin/env bash
set -euo pipefail
umask 077

source_dir="${CI_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
deploy_dir="${DEPLOY_DIR:-/opt/tellymcp}"
: "${TELLYMCP_IMAGE:?Use the image produced by build-gateway-image.sh}"
health_url="${DEPLOY_HEALTH_URL:-https://tellymcp.deadragdoll.net/api/healthz}"

if [[ ! -f "${deploy_dir}/.migration-ready" ]]; then
  echo "Complete the initial data migration and create ${deploy_dir}/.migration-ready first." >&2
  exit 1
fi
test -f "${deploy_dir}/.env-gateway"
docker image inspect "${TELLYMCP_IMAGE}" >/dev/null

exec 9>"${deploy_dir}/.deploy.lock"
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }

snapshot="${deploy_dir}/releases/$(date -u +%Y%m%dT%H%M%SZ)-${CI_JOB_ID:-manual}"
mkdir -p "${snapshot}" "${deploy_dir}/nginx" "${deploy_dir}/state"
cp "${deploy_dir}/.env-gateway" "${snapshot}/.env-gateway"
if [[ -f "${deploy_dir}/docker-compose.yml" ]]; then
  cp "${deploy_dir}/docker-compose.yml" "${snapshot}/docker-compose.yml"
fi
if [[ -f "${deploy_dir}/nginx/default.conf" ]]; then
  cp "${deploy_dir}/nginx/default.conf" "${snapshot}/default.conf"
fi

compose() {
  docker compose --project-directory "${deploy_dir}" --env-file "${deploy_dir}/.env-gateway" "$@"
}

rollback() {
  trap - ERR
  echo 'Deployment failed; restoring the previous image and configuration.' >&2
  cp "${snapshot}/.env-gateway" "${deploy_dir}/.env-gateway"
  if [[ -f "${snapshot}/docker-compose.yml" && -f "${snapshot}/default.conf" ]]; then
    cp "${snapshot}/docker-compose.yml" "${deploy_dir}/docker-compose.yml"
    cp "${snapshot}/default.conf" "${deploy_dir}/nginx/default.conf"
    # The previous image comes from the restored file, not the CI dotenv variable.
    unset TELLYMCP_IMAGE
    compose up -d --no-deps --wait --wait-timeout 180 tellymcp-gateway nginx || true
    compose exec -T nginx nginx -s reload || true
  fi
  echo "Previous configuration saved in ${snapshot}. Database volumes were not rolled back." >&2
  exit 1
}
trap rollback ERR

install -m 644 "${source_dir}/docker-compose.yml" "${deploy_dir}/docker-compose.yml"
install -m 644 "${source_dir}/nginx/default.conf" "${deploy_dir}/nginx/default.conf"
python3 - "${deploy_dir}/.env-gateway" "${TELLYMCP_IMAGE}" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
lines = [line for line in p.read_text().splitlines() if not line.startswith('TELLYMCP_IMAGE=')]
p.write_text('\n'.join(lines) + '\nTELLYMCP_IMAGE=' + sys.argv[2] + '\n')
PY

compose config --quiet
# Only the application and its proxy are reconciled during a normal release.
compose up -d --no-deps --wait --wait-timeout 180 tellymcp-gateway nginx
# Reload configuration even when only the bind-mounted nginx file changed.
compose exec -T nginx nginx -t
compose exec -T nginx nginx -s reload
compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -Atc "SELECT 1"' >/dev/null
[[ "$(compose exec -T redis redis-cli ping)" == PONG ]]
compose exec -T rabbitmq rabbitmq-diagnostics -q check_running
curl --noproxy '*' --fail --silent --show-error --retry 5 --retry-delay 2 --max-time 15 "${health_url}"

trap - ERR
echo
echo "Deployed ${TELLYMCP_IMAGE}; previous configuration: ${snapshot}"
compose ps
