import '../bootstrap';

import { BANK_PROVIDER_TYPE } from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import { importPlaidItem, PlaidConnectionRepository } from '@services/bank-data-providers/plaid/import-existing-item';
import { randomUUID } from 'crypto';
import { Dialect, QueryTypes, Sequelize } from 'sequelize';

const startedAt = Date.now();

function logProgress(message: string): void {
  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  logger.info(`[Plaid Import +${elapsedSeconds}s] ${message}`);
}

function optionalEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function getAccessToken(): string {
  const importToken = optionalEnv('PLAID_IMPORT_ACCESS_TOKEN');
  const legacyToken = optionalEnv('PLAID_ACCESS_TOKEN');

  if (importToken && legacyToken && importToken !== legacyToken) {
    throw new Error('PLAID_IMPORT_ACCESS_TOKEN and PLAID_ACCESS_TOKEN must not contain different values');
  }

  const token = importToken || legacyToken;
  if (!token) {
    throw new Error('PLAID_IMPORT_ACCESS_TOKEN (or PLAID_ACCESS_TOKEN) is required');
  }
  return token;
}

function parseBoolean(name: string): boolean {
  const value = optionalEnv(name);
  if (!value) return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be either true or false`);
}

interface ImportUser {
  id: number;
}

function createDatabaseConnection(): Sequelize {
  return new Sequelize({
    host: process.env.APPLICATION_DB_HOST,
    username: process.env.APPLICATION_DB_USERNAME,
    password: process.env.APPLICATION_DB_PASSWORD,
    database: process.env.APPLICATION_DB_DATABASE,
    port: Number(process.env.APPLICATION_DB_PORT || 5432),
    dialect: (process.env.APPLICATION_DB_DIALECT || 'postgres') as Dialect,
    logging: process.env.DB_QUERY_LOGGING === 'true',
  });
}

async function getTargetUser(database: Sequelize): Promise<ImportUser> {
  const userIdValue = optionalEnv('PLAID_IMPORT_USER_ID');
  const userEmail = optionalEnv('PLAID_IMPORT_USER_EMAIL');

  if (Boolean(userIdValue) === Boolean(userEmail)) {
    throw new Error('Configure exactly one of PLAID_IMPORT_USER_ID or PLAID_IMPORT_USER_EMAIL');
  }

  if (userIdValue) {
    const userId = Number(userIdValue);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw new Error('PLAID_IMPORT_USER_ID must be a positive integer');
    }
    const users = await database.query<ImportUser>('SELECT "id" FROM "Users" WHERE "id" = :userId LIMIT 1', {
      replacements: { userId },
      type: QueryTypes.SELECT,
    });
    const user = users[0];
    if (!user) throw new Error(`No application user exists with ID ${userId}`);
    return user;
  }

  const users = await database.query<ImportUser>('SELECT "id" FROM "Users" WHERE "email" = :userEmail LIMIT 1', {
    replacements: { userEmail },
    type: QueryTypes.SELECT,
  });
  const user = users[0];
  if (!user) throw new Error(`No application user exists with email ${userEmail}`);
  return user;
}

function createConnectionRepository(database: Sequelize): PlaidConnectionRepository {
  return {
    async findByItemId(itemId) {
      const connections = await database.query<{ id: string; userId: number }>(
        `SELECT "id", "userId"
           FROM "BankDataProviderConnections"
          WHERE "providerType" = :providerType
            AND "metadata"->>'itemId' = :itemId
          LIMIT 1`,
        {
          replacements: { providerType: BANK_PROVIDER_TYPE.PLAID, itemId },
          type: QueryTypes.SELECT,
        },
      );
      return connections[0] || null;
    },
    async create(input) {
      const id = randomUUID();
      const now = new Date();
      await database.query(
        `INSERT INTO "BankDataProviderConnections"
          ("id", "userId", "providerType", "providerName", "isActive", "credentials", "metadata", "lastSyncAt", "createdAt", "updatedAt")
         VALUES
          (:id, :userId, :providerType, :providerName, :isActive, CAST(:credentials AS JSONB), CAST(:metadata AS JSONB), NULL, :createdAt, :updatedAt)`,
        {
          replacements: {
            id,
            userId: input.userId,
            providerType: input.providerType,
            providerName: input.providerName,
            isActive: input.isActive,
            credentials: JSON.stringify(input.credentials),
            metadata: JSON.stringify(input.metadata),
            createdAt: now,
            updatedAt: now,
          },
          type: QueryTypes.INSERT,
        },
      );
      return { id };
    },
  };
}

async function importPlaidConnection(database: Sequelize): Promise<void> {
  const accessToken = getAccessToken();
  const expectedItemId = optionalEnv('PLAID_IMPORT_EXPECTED_ITEM_ID');
  const connectionName = optionalEnv('PLAID_IMPORT_CONNECTION_NAME');
  const updateWebhook = parseBoolean('PLAID_IMPORT_UPDATE_WEBHOOK');

  logProgress(
    `Connecting to PostgreSQL at ${process.env.APPLICATION_DB_HOST || 'localhost'}:${process.env.APPLICATION_DB_PORT || '5432'}/${process.env.APPLICATION_DB_DATABASE || '(database not configured)'}`,
  );
  await database.authenticate();
  logProgress('PostgreSQL connection established');

  logProgress(`Resolving target user by ${optionalEnv('PLAID_IMPORT_USER_ID') ? 'ID' : 'email'}`);
  const user = await getTargetUser(database);
  logProgress(`Target user resolved (ID=${user.id})`);
  const result = await importPlaidItem(
    {
      userId: user.id,
      accessToken,
      expectedItemId,
      connectionName,
      updateWebhook,
      provisioningSource: 'external',
      allowExisting: true,
      validateAccounts: true,
      requireTransactions: true,
    },
    {
      connectionRepository: createConnectionRepository(database),
      onProgress: logProgress,
    },
  );

  logger.info(
    `[Plaid Import] ${result.created ? 'Created' : 'Reused'} connection ${result.connectionId} for user ${user.id}; ` +
      `institution=${result.institutionName || 'unknown'}, availableAccounts=${result.accountCount}`,
  );
}

logProgress('Starting Plaid connection import');
const database = createDatabaseConnection();

importPlaidConnection(database)
  .catch((error) => {
    logger.error({ message: '[Plaid Import] Failed to import connection', error });
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      logProgress('Closing PostgreSQL connection');
      await database.close();
      logProgress('Import utility finished');
    } catch (error) {
      logger.error({
        message: '[Plaid Import] Failed to close the database connection',
        error: error instanceof Error ? error : new Error(String(error)),
      });
      process.exitCode = 1;
    }
  });
