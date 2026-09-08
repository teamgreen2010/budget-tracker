import path from 'path';
import { Sequelize } from 'sequelize-typescript';

import { databaseConfig } from '../../config/db/connection';

/**
 * Standalone script to run migrations on the worker database.
 * Called by setup-e2e-tests.sh after infrastructure provisions worker databases.
 *
 * Usage: npx ts-node src/tests/run-worker-migrations.ts
 */
// Register ts-node with transpileOnly to avoid TypeScript errors across migration files
// Each migration file is an independent module, but ts-node in full type-check mode
// can report false positives for redeclared variables across files
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: {
    module: 'commonjs',
  },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Umzug = require('umzug');

if (process.env.NODE_ENV !== 'test' || !process.env.TEST_DATABASE_MANIFEST) {
  throw new Error('Worker migrations require NODE_ENV=test and an isolated database manifest');
}

const DB_CONFIG = databaseConfig({ validate: true });
const DATABASE_NAME = DB_CONFIG.database;

console.log('='.repeat(60));
console.log('WORKER MIGRATION RUNNER - with TypeScript support');
console.log('='.repeat(60));

async function runMigrations() {
  console.log(`Running migrations on worker database: ${DATABASE_NAME}`);

  const sequelize = new Sequelize({
    ...DB_CONFIG,
    logging: false,
  });

  const umzug = new Umzug({
    migrations: {
      path: path.join(__dirname, '../migrations'),
      pattern: /\.(js|ts)$/,
      params: [sequelize.getQueryInterface(), Sequelize],
    },
    storage: 'sequelize',
    storageOptions: {
      sequelize,
    },
  });

  try {
    console.log('Starting migrations...');
    const pending = await umzug.pending();
    console.log(`Pending migrations: ${pending.length}`);
    pending.forEach((m) => console.log(`  - ${m.file}`));

    const migrations = await umzug.up();
    console.log(`Successfully ran ${migrations.length} migrations`);
    migrations.forEach((m) => console.log(`  - ${m.file}`));

    // Debug: Verify critical seed data after migrations
    const [currenciesResult] = await sequelize.query('SELECT COUNT(*) as count FROM "Currencies"');
    const [exchangeRatesResult] = await sequelize.query('SELECT COUNT(*) as count FROM "ExchangeRates"');

    console.log('[DEBUG] Currencies count:', (currenciesResult as { count: string }[])[0]?.count);
    console.log('[DEBUG] ExchangeRates count:', (exchangeRatesResult as { count: string }[])[0]?.count);

    const exchangeRateCount = Number((exchangeRatesResult as { count: string }[])[0]?.count);
    if (!Number.isFinite(exchangeRateCount) || exchangeRateCount < 10000) {
      throw new Error('Worker database has insufficient seeded exchange rates');
    }
    await sequelize.close();
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    await sequelize.close();
    process.exit(1);
  }
}

runMigrations();
