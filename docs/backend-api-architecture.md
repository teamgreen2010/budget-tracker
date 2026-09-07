# Backend API and Database Architecture

This document explains how the backend API is organized, how requests reach the database, how Sequelize is used as the ORM, and how database migrations keep the PostgreSQL schema current.

## Architecture at a Glance

The backend is a Node.js and TypeScript application built around Express, Sequelize, PostgreSQL, and Better Auth.

```text
HTTP request
  -> global Express middleware
  -> feature router
  -> authentication and request validation
  -> controller
  -> service
  -> Sequelize model or raw database query
  -> PostgreSQL
  -> serializer
  -> JSON response
```

The backend is located in [`packages/backend`](../packages/backend). Its important architectural areas are:

| Concern                              | Primary location                                                         |
| ------------------------------------ | ------------------------------------------------------------------------ |
| Application startup                  | [`src/app.ts`](../packages/backend/src/app.ts)                           |
| Global middleware                    | [`src/setup-middleware.ts`](../packages/backend/src/setup-middleware.ts) |
| Top-level route mounting             | [`src/setup-routes.ts`](../packages/backend/src/setup-routes.ts)         |
| Feature routes                       | [`src/routes`](../packages/backend/src/routes)                           |
| HTTP controllers and request schemas | [`src/controllers`](../packages/backend/src/controllers)                 |
| Business logic                       | [`src/services`](../packages/backend/src/services)                       |
| ORM models and query helpers         | [`src/models`](../packages/backend/src/models)                           |
| Database migrations                  | [`src/migrations`](../packages/backend/src/migrations)                   |

## 1. Endpoint Definitions

### Application setup

The Express application is created in [`src/app.ts`](../packages/backend/src/app.ts):

```ts
export const app = express();

setupMiddleware(app);
setupRoutes(app);
```

`setupMiddleware` installs cross-cutting middleware such as request IDs, CORS, request-body parsing, request logging, session context, and language detection. `setupRoutes` then registers the application's HTTP endpoints.

The standard API prefix is defined in [`src/config.ts`](../packages/backend/src/config.ts):

```ts
export const API_PREFIX = '/api/v1';
```

### Top-level route mounting

[`src/setup-routes.ts`](../packages/backend/src/setup-routes.ts) attaches feature-specific routers to URL prefixes:

```ts
app.use(`${API_PREFIX}/accounts`, accountsRoutes);
app.use(`${API_PREFIX}/transactions`, transactionsRoutes);
app.use(`${API_PREFIX}/budgets`, budgetsRoutes);
```

These statements mount the routers under:

```text
/api/v1/accounts
/api/v1/transactions
/api/v1/budgets
```

Most endpoint definitions are in [`src/routes`](../packages/backend/src/routes). Each route file defines the HTTP method, path relative to its mount point, middleware, and controller.

For example, [`src/routes/transactions.route.ts`](../packages/backend/src/routes/transactions.route.ts) defines the following routes. The excerpt is reformatted onto single lines for brevity, but the paths, middleware, and handlers match the current route definitions:

```ts
router.get('/', authenticateSession, validateEndpoint(getTransactions.schema), getTransactions.handler);
router.get('/:id', authenticateSession, validateEndpoint(getTransactionById.schema), getTransactionById.handler);
router.post(
  '/',
  authenticateSession,
  checkBaseCurrencyLock,
  validateEndpoint(createTransaction.schema),
  createTransaction.handler,
);
router.put(
  '/:id',
  authenticateSession,
  checkBaseCurrencyLock,
  validateEndpoint(updateTransaction.schema),
  updateTransaction.handler,
);
router.delete(
  '/:id',
  authenticateSession,
  checkBaseCurrencyLock,
  validateEndpoint(deleteTransaction.schema),
  deleteTransaction.handler,
);
```

Because the router is mounted at `/api/v1/transactions`, the resulting endpoints are:

```http
GET    /api/v1/transactions
GET    /api/v1/transactions/:id
POST   /api/v1/transactions
PUT    /api/v1/transactions/:id
DELETE /api/v1/transactions/:id
```

Route order matters in Express. This is why named paths such as `/refund` and `/planned-summary` appear before the general `/:id` route: otherwise Express could interpret the named path as an `id` value.

### Middleware, controllers, and services

The route itself does not normally contain business logic. Instead, it assembles a processing pipeline:

1. [`authenticateSession`](../packages/backend/src/middlewares/better-auth.ts) validates the Better Auth session, finds the corresponding application user, and attaches it to `req.user`.
2. [`validateEndpoint`](../packages/backend/src/middlewares/validations.ts) parses `req.body`, `req.params`, and `req.query` with the controller's Zod schema.
3. The controller translates the validated HTTP request into service arguments.
4. The service enforces business rules and calls models or other services.
5. The shared [`createController`](../packages/backend/src/controllers/helpers/controller-factory.ts) helper converts the result into the standard JSON response envelope and maps thrown errors to API errors.

For example, [`src/controllers/transactions.controller/get-transaction.ts`](../packages/backend/src/controllers/transactions.controller/get-transaction.ts) defines the query-string schema for listing transactions and invokes `transactionsService.getTransactions()`. Despite the singular `get-transaction.ts` filename, this file implements the transaction-list endpoint; the separate `GET /:id` handler is exported elsewhere.

### Direct and generated endpoints

There are two notable variations from the feature-router pattern:

- A small number of routes, including `GET /health`, are defined directly in [`src/setup-routes.ts`](../packages/backend/src/setup-routes.ts).
- Most `/api/v1/auth/*` endpoints are provided by Better Auth. Express mounts Better Auth's catch-all handler rather than defining every sign-in, sign-out, session, OAuth, and passkey endpoint separately.

## 2. Database Communication and Query Execution

### Runtime Sequelize connection

The main application database connection is created in [`src/models/index.ts`](../packages/backend/src/models/index.ts). Connection settings come from environment variables:

```text
APPLICATION_DB_HOST
APPLICATION_DB_PORT
APPLICATION_DB_USERNAME
APPLICATION_DB_PASSWORD
APPLICATION_DB_DATABASE
APPLICATION_DB_DIALECT
```

The application constructs one Sequelize instance and registers all model classes with it:

```ts
const sequelize = new Sequelize({
  ...DBConfig,
  models,
  pool: {
    /* pool configuration */
  },
  dialectOptions: { keepAlive: true },
  logging: process.env.DB_QUERY_LOGGING === 'true',
});
```

For the configured PostgreSQL dialect, Sequelize uses the `pg` driver. The Sequelize instance maintains a connection pool and checks out a connection when a query needs to run. In tests, the configuration selects a database name specific to each Jest worker.

[`src/models/connection.ts`](../packages/backend/src/models/connection.ts) also configures CLS transaction context:

```ts
export const namespace = cls.createNamespace('budget-tracker-namespace');
Sequelize.useCLS(namespace);
```

This allows queries executed within a managed Sequelize transaction to share the current transaction without every call site having to pass it manually.

### ORM queries

Most application queries use Sequelize model methods. Common examples include:

```ts
Accounts.findAll({ where });
Accounts.findOne({ where: { userId, id } });
Accounts.create(values);
Accounts.update(values, { where });
Transactions.destroy({ where });
```

These calls can specify:

- `where` conditions for filtering rows.
- `attributes` for selecting columns.
- `include` for loading related models through SQL joins.
- `order`, `limit`, and `offset` for sorting and pagination.
- `transaction` for transaction-scoped operations.
- `raw: true` when the caller needs plain row objects instead of Sequelize model instances.

Sequelize operators are used to express more complex SQL. For example:

```ts
whereClause.accountId = {
  [Op.in]: accountIds,
};
```

Sequelize translates this object into a parameterized SQL condition equivalent to an `IN` predicate.

### Representative request: listing transactions

`GET /api/v1/transactions` demonstrates the full request-to-database flow:

1. [`src/setup-routes.ts`](../packages/backend/src/setup-routes.ts) mounts the transactions router at `/api/v1/transactions`.
2. [`src/routes/transactions.route.ts`](../packages/backend/src/routes/transactions.route.ts) matches `GET /` and runs authentication and Zod validation.
3. [`src/controllers/transactions.controller/get-transaction.ts`](../packages/backend/src/controllers/transactions.controller/get-transaction.ts) converts validated query parameters into service arguments, including money and pagination values.
4. [`src/services/transactions/get-transactions.ts`](../packages/backend/src/services/transactions/get-transactions.ts) determines the accounts and budgets visible to the current user and applies the relevant access policy.
5. The service invokes `Transactions.findWithFilters()`.
6. [`src/models/transactions.model.ts`](../packages/backend/src/models/transactions.model.ts) builds Sequelize `where`, `include`, ordering, and pagination options, then executes `Transactions.findAll()`.
7. Sequelize generates SQL, runs it through the PostgreSQL connection pool, and returns model instances or raw rows.
8. The controller serializes money values and the controller factory returns the standard JSON response.

The services are therefore responsible for business and access rules, while the model/query layer is responsible for expressing those rules as database operations.

### Raw SQL and the Better Auth pool

Sequelize is the normal database-access path, but the application also uses raw SQL when an operation is difficult or inefficient to express through ORM methods:

```ts
connection.sequelize.query(/* SQL and bind values */);
```

Better Auth has a separate `pg.Pool`, created in [`src/config/auth.ts`](../packages/backend/src/config/auth.ts), because Better Auth operates on its tables with raw SQL. Some auth-related application queries use this pool directly:

```ts
authPool.query('SELECT ... WHERE id = $1', [id]);
```

The Sequelize pool and Better Auth pool are separate connection pools, but they use the same PostgreSQL connection settings and database.

## 3. ORM: Sequelize and `sequelize-typescript`

The backend dependencies are declared in [`packages/backend/package.json`](../packages/backend/package.json):

| Package                | Version  | Purpose                                    |
| ---------------------- | -------- | ------------------------------------------ |
| `sequelize`            | `6.37.8` | Promise-based ORM and query API            |
| `sequelize-typescript` | `2.1.6`  | TypeScript decorators for Sequelize models |
| `pg`                   | `8.11.5` | PostgreSQL database driver                 |

Sequelize is the ORM. `sequelize-typescript` adds decorator-based TypeScript model declarations on top of Sequelize.

For example, [`src/models/transactions.model.ts`](../packages/backend/src/models/transactions.model.ts) maps the `Transactions` class to the `Transactions` table:

```ts
@Table({
  timestamps: true,
  tableName: 'Transactions',
  freezeTableName: true,
})
export default class Transactions extends Model {
  @Column(IdColumn())
  declare id: RecordId;

  @ForeignKey(() => Accounts)
  @Column({ allowNull: true, type: DataType.UUID })
  accountId!: RecordId;

  @BelongsTo(() => Accounts)
  account!: Accounts;
}
```

The decorators have distinct responsibilities:

- `@Table` maps a model class to a table and configures table-level behavior.
- `@Column` maps a class property to a column and describes its SQL type and constraints.
- `@ForeignKey` identifies a foreign-key column.
- `@BelongsTo`, `@HasMany`, and `@BelongsToMany` define associations that Sequelize can load with `include` or association methods.
- Lifecycle decorators such as `@BeforeCreate`, `@BeforeUpdate`, and `@AfterCreate` register model hooks.

Because the class extends Sequelize's `Model`, it receives static query methods such as:

```ts
Model.findByPk(...);
Model.findOne(...);
Model.findAll(...);
Model.create(...);
Model.update(...);
Model.destroy(...);
```

Sequelize translates these calls into SQL and, by default, hydrates query results into model instances. Model instances provide field getters, setters, validations, hooks, and association behavior. Passing `raw: true` bypasses instance hydration and returns plain database values, so it must be used carefully when model-level getters are significant.

### Models are not schema migrations

The model declarations describe how the application expects the database to look. They do not automatically alter the database schema.

The backend does not run `sequelize.sync()` during application startup. Consequently, adding an `@Column` property to a model is not sufficient to add the corresponding PostgreSQL column. A matching migration must update the physical schema.

## 4. Database Schema Migrations

### Migration technology and location

The project uses `sequelize-cli` version `6.6.2` to manage explicit database migrations. Sequelize CLI uses Umzug internally to discover, execute, and record migrations.

Timestamped migration files live in [`src/migrations`](../packages/backend/src/migrations). Their filenames establish their execution order, for example:

```text
20260812000000-add-original-currency-to-transactions.ts
20260813000000-create-real-transactions-view.ts
20260820000000-create-transaction-automations.ts
```

[`packages/backend/.sequelizerc`](../packages/backend/.sequelizerc) tells Sequelize CLI where to find its configuration, models, migrations, and seeders:

```js
module.exports = {
  config: path.resolve('./config/db', 'config.js'),
  'models-path': path.resolve('./src/models'),
  'migrations-path': path.resolve('./src/migrations'),
  'seeders-path': path.resolve('./src/seeders'),
};
```

The CLI database connection is configured separately from the runtime Sequelize instance in [`config/db/config.ts`](../packages/backend/config/db/config.ts). [`config/db/config.js`](../packages/backend/config/db/config.js) registers `ts-node` so Sequelize CLI can load the TypeScript configuration and TypeScript migration files.

### Migration structure

Each migration exports two operations:

- `up` applies the schema or data change.
- `down` reverses the change when rollback is supported.

For example, [`20260812000000-add-original-currency-to-transactions.ts`](../packages/backend/src/migrations/20260812000000-add-original-currency-to-transactions.ts) adds two transaction columns in `up` and removes them in `down`.

Migrations normally use Sequelize's `QueryInterface`:

```ts
await queryInterface.createTable(...);
await queryInterface.addColumn(...);
await queryInterface.addIndex(...);
await queryInterface.removeColumn(...);
await queryInterface.dropTable(...);
```

They can also execute raw SQL when PostgreSQL-specific operations or data transformations require it:

```ts
await queryInterface.sequelize.query(/* SQL */);
```

Many migrations explicitly wrap related operations in a database transaction so a failure can roll back the entire change.

### Pending-migration tracking

When `sequelize-cli db:migrate` runs, it:

1. Reads the timestamped files from the migrations directory.
2. Reads the database's `SequelizeMeta` table.
3. Identifies migration filenames that have not yet been applied.
4. Runs their `up` functions in filename order.
5. Records each successfully applied filename in `SequelizeMeta`.

The application also reads `SequelizeMeta` when adding the most recently applied migration to a backup manifest; see [`src/services/backup/manifest.ts`](../packages/backend/src/services/backup/manifest.ts).

Rollback commands run a migration's `down` function and remove its applied record from the migration history.

Rollback safety depends on the individual migration's `down` implementation. Before rolling back in production, inspect that function to determine whether it fully reverses both schema and data changes and ensure an appropriate database backup exists.

### Migration commands

The backend package defines these scripts:

```text
npm run migrate:dev       # apply pending development migrations
npm run migrate           # apply pending production migrations
npm run migrate:dev:undo  # undo the latest development migration
npm run migrate:undo      # undo the latest production migration
npm run migrate:generate  # generate a new migration file
```

The development scripts set `NODE_ENV=development`, while the production scripts set `NODE_ENV=production`. [`.sequelizerc`](../packages/backend/.sequelizerc) loads the matching `.env.<environment>` file, and [`config/db/config.ts`](../packages/backend/config/db/config.ts) selects the database configuration stored under that `NODE_ENV` key. This is how the same CLI commands target the correct database credentials for each environment.

When using the repository's development Docker stack, the root-level commands are:

```text
npm run docker:dev:migrate
npm run docker:dev:migrate-undo
```

Development migration execution is currently manual: the automatic migration section in [`docker/dev/backend/docker-entrypoint.sh`](../docker/dev/backend/docker-entrypoint.sh) is disabled.

For the self-hosted production image, [`self-hosting/backend/docker-entrypoint.sh`](../self-hosting/backend/docker-entrypoint.sh) runs `npm run migrate` before starting the backend. If a migration fails, the application is not started.

The application process itself does not invoke migrations from `app.ts`. Deployments that do not use the self-hosting entrypoint must therefore run the production migration command as a separate deployment step.

## Summary

1. **Endpoint definitions:** Express feature routers under `src/routes` define HTTP methods and relative paths. `src/setup-routes.ts` mounts those routers under `/api/v1` prefixes. Controllers validate and translate requests; services contain business logic.
2. **Database communication:** A Sequelize instance in `src/models/index.ts` manages the main PostgreSQL connection pool. Services issue queries through model methods, with raw SQL used selectively. Better Auth uses a separate `pg.Pool` against the same database.
3. **ORM:** The ORM is Sequelize 6 with `sequelize-typescript`. Decorated TypeScript classes map tables, columns, relationships, validations, and hooks, while Sequelize model methods generate SQL and hydrate results.
4. **Schema maintenance:** The schema is updated through timestamped `sequelize-cli` migrations with `up` and `down` functions. Applied migrations are tracked in `SequelizeMeta`. Development migrations are manual, while the self-hosted production entrypoint applies them before application startup.

## External References

- [Express routing](https://expressjs.com/en/guide/routing.html)
- [`sequelize-typescript` documentation](https://github.com/sequelize/sequelize-typescript)
- [Sequelize CLI migrations](https://github.com/sequelize/cli/blob/main/docs/README.md)
