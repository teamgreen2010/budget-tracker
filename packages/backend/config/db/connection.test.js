const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { databaseConfig, databasePool } = require('./connection');
const { waitForDatabase } = require('./wait');

const config = { host: 'localhost', port: 5432, username: 'example', password: 'secret', database: 'example' };
function client(failures) {
  return class {
    on() {}
    async connect() {
      const code = failures.shift();
      if (code) throw Object.assign(new Error('private details'), { code });
    }
    async query() {}
    async end() {}
  };
}
test('readiness recovers from a transient connection failure', async () => {
  await waitForDatabase({ config, clientClass: client(['ECONNREFUSED']), timeoutMs: 2000 });
});
for (const code of ['28P01', '3D000', '42501']) {
  test(`readiness rejects ${code} immediately without exposing credentials`, async () => {
    await assert.rejects(waitForDatabase({ config, clientClass: client([code]) }), (error) => {
      assert.match(error.message, new RegExp(code));
      assert.doesNotMatch(error.message, /secret|private details/);
      return true;
    });
  });
}
test('readiness times out with external-server instructions', async () => {
  await assert.rejects(
    waitForDatabase({ config, clientClass: client(['ECONNREFUSED']), timeoutMs: 10 }),
    /start shared-postgres independently/,
  );
});
test('configuration isolates test workers and validates pool and credentials', () => {
  const previous = { ...process.env };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-config-'));
  try {
    Object.assign(process.env, { NODE_ENV: 'test', TEST_DATABASE_MANIFEST: path.join(directory, 'workers.json') });
    fs.writeFileSync(
      process.env.TEST_DATABASE_MANIFEST,
      JSON.stringify({
        version: 1,
        host: 'shared-postgres',
        port: 5432,
        workers: [
          { database: 'one', username: 'one', password: 'one-secret' },
          { database: 'two', username: 'two', password: 'two-secret' },
        ],
      }),
    );
    assert.equal(databaseConfig({ workerId: '2', validate: true }).database, 'two');
    assert.throws(() => databaseConfig({ workerId: '3' }), /worker ID/);
    process.env.APPLICATION_DB_POOL_MAX = '3';
    process.env.APPLICATION_DB_POOL_MIN = '4';
    assert.throws(databasePool, /pool limits/);
    delete process.env.TEST_DATABASE_MANIFEST;
    process.env.APPLICATION_DB_PASSWORD = '__REPLACE_ME__';
    assert.throws(() => databaseConfig({ validate: true }), /placeholder/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    fs.rmSync(directory, { recursive: true });
  }
});

test('exported settings outrank local overrides, which outrank base settings', () => {
  const previous = { ...process.env };
  const cwd = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-env-'));
  try {
    fs.mkdirSync(path.join(directory, 'packages/backend'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'packages/backend/package.json'), '{}');
    fs.writeFileSync(
      path.join(directory, '.env.development'),
      'APPLICATION_DB_HOST=base\nAPPLICATION_DB_DATABASE=base\n',
    );
    fs.writeFileSync(
      path.join(directory, '.env.development.local'),
      'APPLICATION_DB_HOST=local\nAPPLICATION_DB_DATABASE=local\n',
    );
    process.chdir(path.join(directory, 'packages/backend'));
    process.env.NODE_ENV = 'development';
    process.env.APPLICATION_DB_HOST = 'exported';
    delete process.env.APPLICATION_DB_DATABASE;
    assert.equal(databaseConfig().host, 'exported');
    assert.equal(databaseConfig().database, 'local');
  } finally {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    fs.rmSync(directory, { recursive: true });
  }
});
