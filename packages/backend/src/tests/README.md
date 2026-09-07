# Backend integration tests

Start shared-postgres independently and install its updated allocation tooling.
The default checkout is `$HOME/repos/shared-postgres`; override with
`SHARED_POSTGRES_DIR`. Docker Compose, Python 3.10+, and npm are required.

Copy the root `.env.test.example` to `.env.test`. Set `APPLICATION_REDIS_HOST=test-redis`,
`JEST_WORKERS_AMOUNT` (1–32, default 4), and nonempty test values for
`POLYGON_API_KEY`, `ALPHA_VANTAGE_API_KEY`, `API_LAYER_API_KEYS`, `FMP_API_KEY`,
`COINGECKO_API_KEY`, and `LOGO_DEV_SECRET_KEY`. Use `ADMIN_USERS=test1` for the admin endpoint fixtures. Auth secrets may use test values.
Database settings in this file are superseded by the private worker manifest.

Run `npm run test:e2e -w packages/backend`; Jest arguments are forwarded after `--`.
The host requests isolated databases from infrastructure, then starts only Redis
and a test runner. Each worker has its own non-superuser role and database. All
migrations run for each worker and seeded exchange-rate counts are verified before
Jest starts. There is no template database or template dump cache.

`TEST_DATABASE_MANIFEST` selects credentials by `JEST_WORKER_ID`; database names
are never derived from production/development settings. Redis retains per-worker
key prefixes and per-suite cleanup. Use `SHOW_LOGS_IN_TESTS=true` for diagnostics.

Unique allocations isolate concurrent worktrees/runs. Exit and signal handlers
release them, with an additional CI cleanup step. If a machine crashes, release
the logged allocation using shared-postgres `scripts/allocations.py release NAME`.
See the [operations runbook](../../../../self-hosting/docs/external-postgres.md)
for runner setup and ownership boundaries.
