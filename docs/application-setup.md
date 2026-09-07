# Local Application Setup Guide

This guide will walk you through setting up the Budget Tracker project on your local machine.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Project Architecture](#project-architecture)
- [Quick Start with Docker](#quick-start-with-docker)
- [Manual Setup (Without Docker)](#manual-setup-without-docker)
- [Configuration](#configuration)
- [Running the Application](#running-the-application)
- [Database Migrations](#database-migrations)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

## Prerequisites

### Required Software

- **Node.js**: v23.10.0
- **npm**: Comes with Node.js
- **Docker & Docker Compose**: Only for containerized development
- **PostgreSQL 16 and Redis 7**: Required on the host when running without Docker
- **mkcert**: Recommended for locally trusted HTTPS certificates

## Project Architecture

Budget Tracker is a monorepo with the following structure:

```
budget-tracker/
├── packages/
│   ├── backend/          # Node.js / Express.js / Sequelize / PostgreSQL / Redis backend
│   └── frontend/         # Vue 3 + Vite frontend
├── docker/
│   ├── dev/              # Development Docker configurations
│   ├── test/             # Test environment configurations
├── scripts/              # Utility scripts
└── .env.development      # Development environment variables
```

**Tech Stack:**

- **Backend**: Node.js, Express, TypeScript, Sequelize (ORM), PostgreSQL, Redis, BullMQ
- **Frontend**: Vue 3, TypeScript, Vite, Pinia, TailwindCSS, Reka UI
- **Infrastructure**: Docker, Docker Compose, pgAdmin

## Quick Start with Docker

### 1. Clone the Repository

```bash
git clone https://github.com/letehaha/budget-tracker
cd budget-tracker
```

### 2. Install Dependencies

```bash
npm install
```

This will install all workspace dependencies for both frontend and backend packages.

### 3. Generate SSL Certificates

The development environment uses HTTPS. Generate self-signed SSL certificates:

```bash
npm run generate-ssl-certs
```

This creates certificates in `docker/dev/certs/`.

### 4. Configure Environment Variables

The project comes with a `.env.template` file. See #Environment Variables to get information about each key and how to fill/obtain it.

### 5. Start Docker Services

```bash
npm run docker:dev
```

This will:

- Build and start all Docker containers (backend, frontend, PostgreSQL, Redis, currency-rates-api, pgAdmin)
- Backend will be available at `https://localhost:8081`
- Frontend will be available at `https://localhost:8100`
- pgAdmin will be available at `http://localhost:8001`

### 6. Run Database Migrations

In a new terminal, run migrations to set up the database schema:

```bash
npm run docker:dev:migrate
```

### 7. Access the Application

- **Frontend**: https://localhost:8100
- **Backend API**: https://localhost:8081
- **pgAdmin**: http://localhost:8001
  - Email: `PGADMIN_DEFAULT_EMAIL` (env variable)
  - Password: `PGADMIN_DEFAULT_PASSWORD` (env variable)

**Note**: Your browser will show a security warning due to self-signed certificates. This is expected in development - accept the certificate to proceed.

### Running From Multiple Git Worktrees

`npm run docker:dev` goes through `scripts/docker-dev.sh`, which isolates each git worktree into its own Docker Compose project (separate containers, volumes/database, and host ports), so several worktrees can run dev stacks simultaneously.

- The **main checkout** keeps the default ports above and its existing volumes.
- A **linked worktree** gets free ports auto-assigned on first run (in the 18000+ range) and written to `.env.development.local` (gitignored), together with the derived URLs (`VITE_APP_API_HTTP`, `ALLOWED_ORIGINS`, etc.). The exact URLs are printed on every run.
- To pick ports yourself: `FRONTEND_PORT=9100 BACKEND_PORT=9081 npm run docker:dev` (also supported: `DB_PORT`, `REDIS_PORT`, `CURRENCY_RATES_PORT`, `PGADMIN_PORT`). Explicit values regenerate `.env.development.local`.
- To re-roll auto-assigned ports, delete `.env.development.local` and run again.

Each worktree needs its own `.env.development` copy (the file is gitignored).

## Manual Setup (Without Docker)

In this setup, the backend and frontend run as local npm processes. PostgreSQL
and Redis must also be installed and running on the host; npm does not provide
those services. The custom currency-rates service is optional because the
backend can fall back to its online providers.

### 1. Install Dependencies

From the repository root, install the versions in `package-lock.json`:

```bash
npm ci
```

The root `package.json` pins Node.js 23.10.0 through Volta. If you do not use
Volta, select that Node.js version with your preferred version manager before
installing dependencies.

### 2. Start PostgreSQL and Redis

Install PostgreSQL 16 and Redis 7 using the package manager or native installer
for your operating system, then make sure both services are running.

Redis must listen on `127.0.0.1:6379`. `MAP_REDIS_PORT_TO_OS_PORT` only controls
Docker port mapping and is not read by the locally running backend.

Create a development database and owner (run this as a PostgreSQL administrator):

```sql
CREATE ROLE budget_tracker WITH LOGIN PASSWORD 'development-password';
CREATE DATABASE budget_tracker OWNER budget_tracker;
```

You can verify Redis from a terminal if `redis-cli` is installed:

```bash
redis-cli ping
```

It should print `PONG`.

### 3. Create the Development Environment File

macOS or Linux:

```bash
cp .env.template .env.development
```

Windows PowerShell:

```powershell
Copy-Item .env.template .env.development
```

Edit `.env.development` and replace the Docker-only hostnames and database
credentials with the local values:

```dotenv
APPLICATION_DB_HOST=127.0.0.1
APPLICATION_DB_PORT=5432
APPLICATION_DB_USERNAME=budget_tracker
APPLICATION_DB_PASSWORD=development-password
APPLICATION_DB_DATABASE=budget_tracker

APPLICATION_REDIS_HOST=127.0.0.1

# Use a locally installed currency-rates service here if you have one.
# Otherwise this fails fast and the backend uses its online fallback providers.
CURRENCY_RATES_API_URL=http://127.0.0.1:8102

BETTER_AUTH_URL=https://localhost:8081
AUTH_ORIGIN=https://localhost:8100
```

The API keys in the template are optional for basic local development. Never
commit `.env.development`; it is already ignored by Git.

### 4. Configure Local HTTPS

The checked-in development configuration expects HTTPS for authentication and
passkeys. Install `mkcert`, then run:

```bash
npm run generate-ssl-certs
```

The backend and Vite both use the generated files in `docker/dev/certs/`; the
directory name does not mean Docker is required.

To use plain HTTP instead, do not generate the certificates and change every
local public URL in `.env.development` to HTTP, including:

```dotenv
BETTER_AUTH_URL=http://localhost:8081
AUTH_ORIGIN=http://localhost:8100
ENABLE_BANKING_REDIRECT_URL=http://localhost:8100/bank-callback
PLAID_REDIRECT_URI=http://localhost:8100/plaid-oauth-return
```

### 5. Run Database Migrations

From the repository root:

```bash
npm run db:migrate
```

Run this once during initial setup and again after pulling changes that add
database migrations.

### 6. Start With npm

Use two terminals from the repository root:

```bash
# Terminal 1: Express API with nodemon
npm run dev:backend
```

```bash
# Terminal 2: Vue/Vite development server
npm run dev:frontend
```

Open `https://localhost:8100`. The backend API runs at
`https://localhost:8081`. Both processes watch their source files for changes.

### 7. Start and Debug With VS Code

1. Open the repository root in VS Code.
2. Create `.env.development`, start PostgreSQL and Redis, and run the migrations
   as described above.
3. Open **Run and Debug** (`Ctrl+Shift+D` / `Cmd+Shift+D`).
4. Select **App: backend + frontend** and press `F5`.

The checked-in `.vscode/launch.json` starts both npm processes as a compound
debug session. When Vite is ready, VS Code opens Chrome at the frontend URL.
Stopping the compound session stops both processes. Backend TypeScript
breakpoints and frontend browser breakpoints are supported.

You can also select **Backend: npm dev** or **Frontend: npm dev** to launch only
one half of the application.

## Configuration

### Environment Variables

Key environment variables in `.env.development`:

- `NODE_ENV`: Environment (development/production/test)

**Backend Configuration:**

- `APPLICATION_HOST`: Backend host (default: 127.0.0.1)
- `APPLICATION_PORT`: Backend port (default: 8081)
- `APPLICATION_JWT_SECRET`: JWT secret for authentication

**Database Configuration:**

- `APPLICATION_DB_HOST`: PostgreSQL host. Default to `db`. Uses service name defined in the `/docker/dev/docker-compose.yml`.
- `APPLICATION_DB_PORT`: PostgreSQL port
- `APPLICATION_DB_USERNAME`: Database username (define yours)
- `APPLICATION_DB_PASSWORD`: Database password (define yours)
- `APPLICATION_DB_DATABASE`: Database name (define yours)
- `APPLICATION_DB_DIALECT`: Database dialect, default to `postgres`. Used by Sequelize. Details: https://sequelize.org/docs/v6/other-topics/dialect-specific-things/. If you wanna change it, keep in mind that different DBs support different functionality. This project is written with a full support for Postgres, other DBs support is not guaranteed
- `DB_QUERY_LOGGING`: Enable SQL query logging (true/false)

**Redis Configuration:**

- `APPLICATION_REDIS_HOST`: Redis host. Default to `redis`. Uses service name defined in the `/docker/dev/docker-compose.yml`.
- `MAP_REDIS_PORT_TO_OS_PORT`: Port mapping for local Redis access. Mostly needed for debugging, yet required to be set. Can be set to default `6379`, but to avoid conflicts with local Redis instsances, better define custom port.

**API Keys (Optional but recommended for full functionality):**

- `POLYGON_API_KEY`: Stock market data. Can be obtained at https://massive.com/ (previously polygon.io)
- `ALPHA_VANTAGE_API_KEY`: Financial data. Can be obtained at https://www.alphavantage.co/
- `FMP_API_KEY`: Financial Data API. Can be obtained at https://site.financialmodelingprep.com/
- `API_LAYER_API_KEYS`: Currency exchange rates (comma-separated for multiple keys). Can be obtained at https://marketplace.apilayer.com/fixer-api. Better define several keys
- `CURRENCY_RATES_API_URL`: Base URL for the self-hosted currency rates service (default `http://currency-rates-api:8080`). It supplies ECB + NBU rates for ~38 currencies, with `API_LAYER_API_KEYS` covering the exotic long tail.
- `ENABLE_BANKING_REDIRECT_URL`: OAuth redirect URL required by Enable Banking – bank integration provider.

**Frontend Configuration:**

- `HOST`: Frontend host domain (default: `localhost`)
- `PORT`: Frontend port (default: `8100`)
- `VITE_APP_API_HTTP`: Backend API URL (default: `http://127.0.0.1:8081`)
- `VITE_APP_API_VER`: API version prefix (default: `/api/v1`)

**Security:**

- `ALLOWED_ORIGINS`: CORS allowed origins (comma-separated)
- `APP_SESSION_ID_SECRET`: Session secret
- `ADMIN_USERS`: usernames of users that should be considered as admins. Admins have extra functionality available

### Database Configuration

Database configuration is managed by Sequelize. Connection settings are read from environment variables in the backend package.

## Running the Application

Most of the time the only command you will need is: `npm run docker:dev`. It will start all required services.

`npm run docker:dev:migrate` is required on the first run. Also it might be required if you decide to pull new code changes which might essentialy contain DB structure updates.

### Development Commands

Below is a quick walk-throught for all development-related commands.

```bash
npm run lint # Run linting (both packages)
npm run test # Run all tests
```

#### Backend-Specific Commands

```bash
cd packages/backend

# Start development server
npm run dev

# Build for production
npm run build

# Run production server
npm run prod

# Run tests
npm run test
npm run test:unit
npm run test:e2e

# Database migrations
npm run migrate:dev           # Run migrations (dev)
npm run migrate:dev:undo      # Undo last migration (dev)
npm run migrate:generate      # Generate new migration
```

#### Frontend-Specific Commands

```bash
cd packages/frontend

# Start development server
npm run dev

# Build for production
npm run build

# Run tests
npm run test
npm run test:unit

# Run Storybook
npm run storybook
```

## Testing

Running tests requires creating `.env.test` file which should mostly looks the same as the `.env.development` with a few critical changes. Use following values for tests:

```yml
APPLICATION_DB_HOST=test-db
APPLICATION_REDIS_HOST=test-redis

# define how many Jest workers should be used for parallel tests execution
# min: 1, max: <whatever>, but better about 70-80% of your CPU cores
JEST_WORKERS_AMOUNT=6
# define if you wanna see logger. logs in tests. Useful for debugging
SHOW_LOGS_IN_TESTS=false

# Better use `test` values to avoid calling external APIs with real credentials.
# It might drain your usage limits.
# It shouldn't happen tho
POLYGON_API_KEY=test
ALPHA_VANTAGE_API_KEY=test
FMP_API_KEY=test
API_LAYER_API_KEYS=test
```

### Running All Tests

```bash
npm run test
```

### Backend Tests

```bash
cd packages/backend

# All tests
npm run test

# Unit tests only
npm run test:unit

# E2E tests only
npm run test:e2e
```

**Note**: E2E tests automatically set up test databases and run migrations. The number of test workers is configured via `JEST_WORKERS_AMOUNT` in `.env.development`.

### Frontend Tests

```bash
cd packages/frontend

# Run unit tests
npm run test:unit
```

## Troubleshooting

### SSL Certificate Issues

**Problem**: HTTPS not working

```bash
# Regenerate certificates
npm run generate-ssl-certs

# Restart Docker services
npm run docker:dev:down
npm run docker:dev
```

### API Key Issues

**Problem**: External API features not working

- Check that API keys are set in `.env.development`
- Verify API keys are valid and have not expired
- Some features (stock market data, currency rates) require valid API keys

### pgAdmin Connection

To connect to the database from pgAdmin:

1. Open http://localhost:8001
2. Login with credentials from `.env.development`
3. Add new server:
   - **Name**: `foo_bar`
   - **Host**: `APPLICATION_DB_HOST`
   - **Port**: `APPLICATION_DB_PORT`
   - **Database**: `APPLICATION_DB_DATABASE`
   - **Username**: `APPLICATION_DB_USERNAME`
   - **Password**: `APPLICATION_DB_PASSWORD`

## Additional Resources

- **Main README**: [../README.md](../README.md)
- **License**: [../LICENSE](../LICENSE)
- **Backend README**: [packages/backend/README.md](../packages/backend/README.md)
- **Docker Compose Files**: `docker/dev/docker-compose.yml`
- **Backend Package**: `packages/backend/`
- **Frontend Package**: `packages/frontend/`

## Getting Help

If you encounter issues not covered here:

1. Check existing GitHub issues
2. Review Docker logs: `npm run docker:dev:logs`
3. Verify environment variables in `.env.development`
4. Ensure all prerequisites are installed and up-to-date
