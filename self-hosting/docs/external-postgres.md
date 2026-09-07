# External PostgreSQL operations and migration

Budget-tracker requires an independently running PostgreSQL 17 server from
`~/repos/shared-postgres`. Its Compose stacks never provision a database server.
Schemas and migrations remain in budget-tracker. Each application environment,
worktree, preview, and test worker receives its own database and owner role.

## First installation

Run these infrastructure commands explicitly on the application host:

```sh
cd ~/repos/shared-postgres
python3 scripts/start.py
python3 scripts/provision.py budget_tracker budget_tracker
# For development, provision budget_tracker_dev with role budget_tracker_dev instead.
```

Provisioning prompts for a password and installs `vector` and `pgcrypto`. Put the
project password in budget-tracker's private environment file; never copy the
cluster administrator password. Existing credentials are preserved on reruns.

Containers use `APPLICATION_DB_HOST=shared-postgres`, `APPLICATION_DB_PORT=5432`,
and `SHARED_POSTGRES_NETWORK=shared-postgres`. If infrastructure overrides the
network name, use the same override in budget-tracker. Host-run processes use
`127.0.0.1` and the infrastructure project's `POSTGRES_PORT`. The shared host port
remains bound only to loopback. A Docker network provides container access.

After configuring `self-hosting/.env`, build the changed application images:

```sh
cd ~/repos/budget-tracker/self-hosting
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

Published images must contain this change before using the pull-only stack.
Production startup checks database access, applies migrations, then serves HTTP.
Development runs migrations explicitly with `npm run docker:dev:migrate`.
Readiness retries transient failures for 60 seconds; invalid credentials or a
missing database fail immediately. Restart the backend after correcting settings.

`APPLICATION_DB_POOL_MAX` defaults to 10 (5 per test worker) and
`APPLICATION_DB_POOL_MIN` to 0. Size the server's connection budget for all apps,
workers, previews, and administrative connections before increasing these values.
Each backend has both a Sequelize pool and an authentication pool; these limits
apply to each pool.
Do not apply the former disposable test server's durability settings to a shared
server.

## Existing database migration: PostgreSQL 16 to 17

Perform a maintenance window for each persistent environment, including existing
previews and worktrees. Do not attach PostgreSQL 16's data directory to version 17.

1. Record the old image/revision, Compose project, database name, role, and volume
   (`docker volume ls`). Keep a copy of the old Compose configuration and private
   environment file. Record table counts, representative account balances and
   transactions, and `SequelizeMeta`. Preserve application encryption/auth secrets.
2. Stop backend writers and background jobs. Keep the old database available for
   the dump. If it occupies host port 5432, configure another shared-postgres host
   port before starting infrastructure; container connections still use 5432.
3. Create a custom-format archive from the old database using its existing
   PostgreSQL client. Substitute the inventoried container, role, and database:

   ```sh
   umask 077
   docker exec OLD_DATABASE_CONTAINER pg_dump -U OLD_ROLE -d OLD_DATABASE \
     --format=custom --no-owner --no-acl > budget-tracker-before-move.dump
   ```

   Check that `pg_dump` succeeded before proceeding. Store the archive separately
   from database volumes. Provision a new target using the first-install commands.

4. Restore through infrastructure tooling:

   ```sh
   cd ~/repos/shared-postgres
   python3 scripts/restore.py budget_tracker budget_tracker /absolute/path/budget-tracker-before-move.dump
   ```

   Restore requires an empty database, runs transactionally, and assigns ownership
   to the project role. Original ownership, grants, and extension comments are
   omitted. Restored databases retain infrastructure-installed extensions.

5. Compare the recorded counts, balances, transactions, and migration history.
   Switch budget-tracker's database settings; start the updated backend, run
   pending migrations, and verify login, dashboard reads, and transaction writes.
   Take and restore a new backup into another empty database before acceptance.
6. Reopen normal use only after acceptance. Retain the old container configuration,
   PostgreSQL 16 volume, and archive. Removing old server containers is a separate
   operator action; never run old `down -v` commands during this migration.

Before normal writes resume, rollback means stopping the new backend and restoring
the prior application revision/configuration against the old database. After new
writes begin, preserve and reconcile them before rollback; switching back directly
would lose those writes.

Legacy `.sql` / `.sql.gz` backups are not accepted by the new restore wrapper.
Restore a trusted legacy dump into an isolated PostgreSQL 16 database managed by
infrastructure, then create a custom-format archive with `pg_dump` as above. If
the original database is available, dump it directly instead. Preview deployment
requires a new `.dump` backup in R2 and fails rather than silently using empty data.

## Development and worktrees

The development launcher assigns each new worktree a suggested database/role name
in `.env.development.local`, with a password placeholder. Provision that database
in shared-postgres and fill its credentials before starting the backend. Port
regeneration preserves database overrides. Existing worktrees must receive their
own database credentials before first startup after this change.

Environment precedence is exported process variables, `.env.MODE.local`, then
`.env.MODE`. Compose loads the corresponding files with local values taking
precedence. Use container hostnames for Docker commands and explicit host/port
overrides when running commands on the host:

```sh
APPLICATION_DB_HOST=127.0.0.1 APPLICATION_DB_PORT=5432 npm run migrate:dev -w packages/backend
```

`docker:dev:clean` removes application resources only. Shared PostgreSQL and its
data survive application teardown. Reset data by provisioning a fresh database,
not by deleting shared volumes or dropping shared schemas.

## Tests and CI

Install the updated shared-postgres tooling on each runner host and start its
server independently. Set `SHARED_POSTGRES_DIR` if it is not under
`$HOME/repos/shared-postgres`. Create `.env.test` from `.env.test.example` and supply the
test service/API settings described in the backend test README.

`npm run test:e2e -w packages/backend` allocates a unique database and role per Jest
worker through infrastructure tooling, mounts a private manifest into the runner,
applies migrations to each database, then runs tests. Runtime code reads worker
credentials from `TEST_DATABASE_MANIFEST`; application credentials cannot create
or drop databases. Test-runner containers never receive administrator credentials.
The template-cloning cache has been removed.

Cleanup runs on exit and cancellation. After a killed host/process, release the
allocation recorded in the logs and `.test-databases/`:

```sh
python3 ~/repos/shared-postgres/scripts/allocations.py release ALLOCATION_NAME
```

The infrastructure manifest records exact resources; release checks ownership and
privileges before deletion. Never clean databases by matching a name prefix.

Backend integration CI uses a dedicated self-hosted Linux runner labeled
`shared-postgres`. Configure the GitHub environment `database-integration` with
required reviewers before enabling it. Only owner/member/collaborator PRs are
eligible; review the actual commit before approving. Use a dedicated test host
without production databases. Other CI jobs remain on GitHub-hosted runners.
CI run/attempt/shard IDs namespace allocations and images; an `always()` step
provides additional cleanup. Runner hosts need Docker Compose, Python 3.10+, Node,
and the independently installed infrastructure checkout.

## Previews and backups

Provisioning and release run on the preview host using shared-postgres tooling.
Set repository variable `SHARED_POSTGRES_DIR` for a non-default remote path.
Preview allocations use `bt_preview_PRNUMBER`; `.database-initialized` records
successful restoration. Redeployment preserves that allocation. Teardown removes
only its recorded database/role. Migrate existing previews before deployment,
export their allocation credentials to `.database.env` and update `.env` to the new host, then create the initialization
marker after verifying the restored data.

Scheduled backups target `APPLICATION_DB_DATABASE` explicitly through infrastructure
`backup.py`, upload custom-format `.dump` archives to R2, and retain the existing
60-day retention policy. `DB_SERVICE_NAME` and shared `PREVIEW_DB_PASSWORD` secrets
are no longer used. A new preview requires an available custom-format backup.

For an explicit local backup or restore using the configured development target:

```sh
node packages/backend/config/db/backup.js backup /absolute/path/budget.dump
bash scripts/restore-backup.sh /absolute/path/budget.dump
# Omit the restore filename to download the latest .dump from configured R2 storage.
```

Restore refuses existing tables. Provision a new target and update local overrides
before restoring; it never drops/recreates the active database. Infrastructure's
`backup.py` and `restore.py` are also available directly for self-hosted operations.
