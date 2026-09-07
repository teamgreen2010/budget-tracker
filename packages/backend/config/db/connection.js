const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

function loadEnvironment() {
  // Supports commands run from the repository, package, or compiled dist directory.
  let root = process.cwd();
  while (!fs.existsSync(path.join(root, 'packages/backend/package.json'))) {
    const parent = path.dirname(root);
    if (parent === root) return;
    root = parent;
  }
  const mode = process.env.NODE_ENV || 'development';
  dotenv.config({ path: [path.join(root, `.env.${mode}.local`), path.join(root, `.env.${mode}`)] });
}

function databaseConfig({ workerId = process.env.JEST_WORKER_ID, validate = false } = {}) {
  loadEnvironment();
  const env = process.env;
  let config = {
    host: env.APPLICATION_DB_HOST,
    port: Number(env.APPLICATION_DB_PORT || 5432),
    username: env.APPLICATION_DB_USERNAME,
    password: env.APPLICATION_DB_PASSWORD,
    database: env.APPLICATION_DB_DATABASE,
    dialect: 'postgres',
  };
  if (env.NODE_ENV === 'test' && env.TEST_DATABASE_MANIFEST) {
    const manifest = JSON.parse(fs.readFileSync(env.TEST_DATABASE_MANIFEST, 'utf8'));
    const index = Number(workerId);
    if (manifest.version !== 1 || !Number.isInteger(index) || index < 1 || !manifest.workers[index - 1]) {
      throw new Error('A valid test database manifest and Jest worker ID are required');
    }
    config = { ...config, host: manifest.host, port: manifest.port, ...manifest.workers[index - 1] };
  }
  if (validate) {
    for (const key of ['host', 'username', 'password', 'database']) {
      if (typeof config[key] !== 'string' || !config[key] || config[key].startsWith('__REPLACE_ME__')) {
        throw new Error(
          `Database ${key} is missing or a placeholder; configure APPLICATION_DB_* with a provisioned database`,
        );
      }
    }
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      throw new Error('APPLICATION_DB_PORT must be an integer between 1 and 65535');
    }
    if (env.APPLICATION_DB_DIALECT && env.APPLICATION_DB_DIALECT !== 'postgres') {
      throw new Error('APPLICATION_DB_DIALECT must be postgres');
    }
  }
  return config;
}

function databasePool() {
  const max = Number(process.env.APPLICATION_DB_POOL_MAX || (process.env.NODE_ENV === 'test' ? 5 : 10));
  const min = Number(process.env.APPLICATION_DB_POOL_MIN || 0);
  if (!Number.isInteger(max) || max < 1 || !Number.isInteger(min) || min < 0 || min > max) {
    throw new Error('Database pool limits must be integers with 0 <= min <= max and max >= 1');
  }
  return { max, min, idle: 30000, evict: 10000, acquire: 60000 };
}

module.exports = { databaseConfig, databasePool, loadEnvironment };
