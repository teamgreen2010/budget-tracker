#!/usr/bin/env bash
# PostgreSQL must already be running; infrastructure tooling allocates worker databases.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
SHARED_POSTGRES_DIR="${SHARED_POSTGRES_DIR:-$HOME/repos/shared-postgres}"
cd "$ROOT"
[[ -f .env.test ]] || { echo 'Create .env.test from .env.template first.' >&2; exit 1; }
[[ -f "$SHARED_POSTGRES_DIR/scripts/allocations.py" ]] || { echo 'Install updated shared-postgres tooling first.' >&2; exit 1; }
# Parse dotenv with the same implementation as the backend; never execute env contents as shell code.
WORKERS=$(node -e 'require("dotenv").config({path:".env.test"}); process.stdout.write(process.env.JEST_WORKERS_AMOUNT || "4")')
[[ "$WORKERS" =~ ^[1-9][0-9]*$ ]] && (( WORKERS <= 32 )) || { echo 'JEST_WORKERS_AMOUNT must be 1..32' >&2; exit 1; }
export JEST_WORKERS_AMOUNT="$WORKERS"
export TEST_DB_ALLOCATION="${TEST_DB_ALLOCATION:-bt_test_$(python3 -c 'import secrets; print(secrets.token_hex(12))')}"
TEST_COMPOSE_PROJECT="${TEST_DB_ALLOCATION//_/-}"
export TEST_DATABASE_MANIFEST="$ROOT/.test-databases/$TEST_DB_ALLOCATION.json"
BUILT_LOCAL_IMAGE=0
[[ -n "${TEST_RUNNER_IMAGE:-}" ]] || BUILT_LOCAL_IMAGE=1
export TEST_RUNNER_IMAGE="${TEST_RUNNER_IMAGE:-$TEST_COMPOSE_PROJECT-runner}"
compose() { docker compose -p "$TEST_COMPOSE_PROJECT" -f "$ROOT/docker/test/backend/docker-compose.yml" --env-file "$ROOT/.env.test" "$@"; }
cleanup() {
  local result=$?
  trap - EXIT
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  if python3 "$SHARED_POSTGRES_DIR/scripts/allocations.py" release "$TEST_DB_ALLOCATION"; then
    rm -f "$TEST_DATABASE_MANIFEST"
  else
    echo "Allocation cleanup failed; retry release for $TEST_DB_ALLOCATION" >&2
    result=1
  fi
  if [[ "$BUILT_LOCAL_IMAGE" == 1 ]]; then docker image rm "$TEST_RUNNER_IMAGE" >/dev/null 2>&1 || true; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 "$SHARED_POSTGRES_DIR/scripts/allocations.py" provision "$TEST_DB_ALLOCATION" --workers "$WORKERS" --output "$TEST_DATABASE_MANIFEST"
export SHARED_POSTGRES_NETWORK=$(node -e 'process.stdout.write(require(process.env.TEST_DATABASE_MANIFEST).network)')
if [[ "${TEST_RUNNER_PREBUILT:-false}" == true ]]; then
  compose up -d --no-build
else
  compose up -d --build
fi
for attempt in $(seq 1 60); do
  if compose exec -T test-redis redis-cli ping >/dev/null 2>&1; then break; fi
  [[ "$attempt" != 60 ]] || { echo 'Redis unavailable' >&2; exit 1; }
  sleep 1
done
# Migrate each isolated database as its owner. No cluster privileges enter the runner.
for worker in $(seq 1 "$WORKERS"); do
  compose exec -T -e JEST_WORKER_ID="$worker" test-runner node packages/backend/config/db/wait.js
  compose exec -T -e JEST_WORKER_ID="$worker" test-runner npx ts-node packages/backend/src/tests/run-worker-migrations.ts
done
compose exec -T -e SHOW_LOGS_IN_TESTS="${SHOW_LOGS_IN_TESTS:-}" test-runner \
  npx jest -c packages/backend/jest.config.e2e.ts --passWithNoTests --forceExit --colors "$@"
