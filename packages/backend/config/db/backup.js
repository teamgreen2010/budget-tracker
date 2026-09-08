const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { databaseConfig } = require('./connection');

function run(command, args, options = {}) {
  const environment = { ...process.env };
  // Development dotenv files can contain the application's Compose project name.
  // Infrastructure must resolve its own project from its own configuration.
  delete environment.COMPOSE_PROJECT_NAME;
  const result = spawnSync(command, args, { stdio: 'inherit', env: environment, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed; see diagnostics above`);
  return result.stdout;
}

function main() {
  const config = databaseConfig();
  const [action, input] = process.argv.slice(2);
  if (!['backup', 'restore'].includes(action))
    throw new Error('Usage: backup.js backup OUTPUT.dump | restore [FILE.dump | R2_KEY]');
  const directory = process.env.SHARED_POSTGRES_DIR || path.join(os.homedir(), 'repos/shared-postgres');
  if (!config.database || !config.username)
    throw new Error('Configure APPLICATION_DB_DATABASE and APPLICATION_DB_USERNAME');
  if (action === 'backup') {
    if (!input) throw new Error('An output filename is required');
    run('python3', [path.join(directory, 'scripts/backup.py'), config.database, input]);
    return;
  }
  let temporary;
  try {
    let file = input;
    if (!file || !fs.existsSync(file)) {
      const env = process.env;
      for (const key of ['R2_ENDPOINT_URL', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BACKUP_BUCKET']) {
        if (!env[key]) throw new Error(`Missing ${key}`);
      }
      const awsEnv = {
        ...env,
        AWS_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
        AWS_DEFAULT_REGION: 'auto',
      };
      const prefix = env.R2_BACKUP_PREFIX || '';
      let key = input && prefix + input;
      if (!key) {
        const listing = run(
          'aws',
          [
            's3api',
            'list-objects-v2',
            '--bucket',
            env.R2_BACKUP_BUCKET,
            '--prefix',
            prefix,
            '--endpoint-url',
            env.R2_ENDPOINT_URL,
            '--output',
            'json',
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env: awsEnv },
        );
        const objects = (JSON.parse(listing).Contents || []).filter(
          (entry) => entry.Key.endsWith('.dump') && entry.Size > 100,
        );
        objects.sort((a, b) => a.LastModified.localeCompare(b.LastModified));
        key = objects.at(-1)?.Key;
      }
      if (!key) throw new Error('No custom-format .dump backup found in R2');
      temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-restore-'));
      file = path.join(temporary, 'backup.dump');
      run('aws', ['s3', 'cp', `s3://${env.R2_BACKUP_BUCKET}/${key}`, file, '--endpoint-url', env.R2_ENDPOINT_URL], {
        env: awsEnv,
      });
    }
    const handle = fs.openSync(file, 'r');
    const signature = Buffer.alloc(5);
    try {
      fs.readSync(handle, signature, 0, 5, 0);
    } finally {
      fs.closeSync(handle);
    }
    if (signature.toString() !== 'PGDMP') {
      throw new Error(
        'Use a custom-format PostgreSQL .dump archive. See self-hosting/docs/external-postgres.md for legacy SQL conversion.',
      );
    }
    run('python3', [path.join(directory, 'scripts/restore.py'), config.database, config.username, path.resolve(file)]);
  } finally {
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  }
}
try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
