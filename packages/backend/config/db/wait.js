const { Client } = require('pg');
const { databaseConfig } = require('./connection');

async function waitForDatabase({
  timeoutMs = 60000,
  clientClass = Client,
  config = databaseConfig({ validate: true }),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let code = 'unavailable';
  do {
    const remaining = Math.max(1, deadline - Date.now());
    const client = new clientClass({
      ...config,
      user: config.username,
      connectionTimeoutMillis: Math.min(3000, remaining),
      query_timeout: Math.min(3000, remaining),
    });
    client.on('error', () => {}); // connect/query report failures; idle errors must not escape.
    try {
      await client.connect();
      await client.query('SELECT 1');
      return;
    } catch (error) {
      code = error.code || 'connection timeout';
      if (['28P01', '28000', '3D000', '42501'].includes(error.code)) {
        throw new Error(
          `PostgreSQL rejected the configured database credentials or access (${code}); check provisioning and APPLICATION_DB_*`,
        );
      }
    } finally {
      await client.end().catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(0, deadline - Date.now()))));
  } while (Date.now() < deadline);
  throw new Error(
    `PostgreSQL is unavailable (${code}); start shared-postgres independently and check its network and APPLICATION_DB_*`,
  );
}

if (require.main === module) {
  waitForDatabase()
    .then(() => console.log('PostgreSQL connection ready'))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
module.exports = { waitForDatabase };
