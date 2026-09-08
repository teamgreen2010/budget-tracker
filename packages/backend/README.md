# Budget-tracker backend

Install dependencies with `npm ci`. Create `.env.development` from `.env.template`
and `.env.test` from `.env.test.example`, then fill the service and API settings.

PostgreSQL 17 is an external dependency managed in `~/repos/shared-postgres`.
Follow the [provisioning and migration runbook](../../self-hosting/docs/external-postgres.md)
before starting the backend. Use a dedicated database/role for each environment.

Start Docker development with `npm run docker:dev`, then run
`npm run docker:dev:migrate`. Changes reload through mounted source directories.
The backend checks authenticated database access before startup; it never starts
a database server. Worktree database credentials live in `.env.development.local`.

For host development, keep Redis available and override `APPLICATION_DB_HOST` to
`127.0.0.1` and `APPLICATION_DB_PORT` to the shared host port. Run
`npm run migrate:dev -w packages/backend` and `npm run dev -w packages/backend`.
Exported variables take precedence over local and base environment files.

Development pgAdmin is available on port 8001 by default. Use host
`shared-postgres`, port 5432, and the provisioned database/role/password; set its
maintenance database to the application database because project roles cannot
connect to the cluster maintenance databases.

`npm run docker:dev:down` stops application containers. `docker:dev:clean` also
removes application volumes; neither command deletes shared database data.

See the [integration test setup](src/tests/README.md) and
[backend service documentation](docs/).
