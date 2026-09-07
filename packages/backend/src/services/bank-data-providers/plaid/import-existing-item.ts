/* eslint-disable @typescript-eslint/no-explicit-any */
import { BANK_PROVIDER_TYPE } from '@bt/shared/types';
import { t } from '@i18n/index';
import { ValidationError } from '@js/errors';

import { encryptCredentials } from '../utils/credential-encryption';
import { createPlaidClient, getPlaidConfig } from './config';
import { PlaidExistingItemImportInput, PlaidExistingItemImportResult, PlaidMetadata } from './types';

export interface PlaidItemImportOptions extends PlaidExistingItemImportInput {
  institutionId?: string;
  institutionName?: string;
  provisioningSource: 'link' | 'external';
  allowExisting: boolean;
  validateAccounts: boolean;
  requireTransactions: boolean;
}

interface PlaidConnectionRecord {
  id: string;
  userId: number;
}

interface PlaidConnectionCreateInput {
  userId: number;
  providerType: BANK_PROVIDER_TYPE.PLAID;
  providerName: string;
  isActive: boolean;
  credentials: string;
  metadata: PlaidMetadata;
}

export interface PlaidConnectionRepository {
  findByItemId(itemId: string): Promise<PlaidConnectionRecord | null>;
  create(input: PlaidConnectionCreateInput): Promise<{ id: string }>;
}

type PlaidImportProgressLogger = (message: string) => void;

async function createModelRepository(): Promise<PlaidConnectionRepository> {
  const BankDataProviderConnections = (await import('@models/bank-data-provider-connections.model')).default;
  return {
    async findByItemId(itemId) {
      return BankDataProviderConnections.findOne({
        where: { providerType: BANK_PROVIDER_TYPE.PLAID, metadata: { itemId } } as any,
      });
    },
    async create(input) {
      return BankDataProviderConnections.create(input as any);
    },
  };
}

/**
 * Validates an existing Plaid Item and persists the same encrypted connection
 * record used by the Link flow. Kept separate from PlaidProvider so one-shot
 * provisioning does not initialize transaction-sync workers.
 */
export async function importPlaidItem(
  {
    userId,
    accessToken,
    expectedItemId,
    connectionName,
    updateWebhook = false,
    institutionId: institutionIdOverride,
    institutionName: institutionNameOverride,
    provisioningSource,
    allowExisting,
    validateAccounts,
    requireTransactions,
  }: PlaidItemImportOptions,
  dependencies: {
    connectionRepository?: PlaidConnectionRepository;
    onProgress?: PlaidImportProgressLogger;
  } = {},
): Promise<PlaidExistingItemImportResult> {
  const reportProgress = dependencies.onProgress || (() => undefined);
  const token = accessToken.trim();
  if (!token) {
    throw new ValidationError({ message: t({ key: 'bankDataProviders.plaid.invalidStoredCredentials' }) });
  }

  const config = getPlaidConfig();
  if (!config) throw new ValidationError({ message: t({ key: 'bankDataProviders.plaid.notConfigured' }) });

  reportProgress(`Plaid configuration loaded (environment=${config.environment})`);

  const client = createPlaidClient(config);

  reportProgress('Calling Plaid item/get to validate the access token');

  const itemResponse = (await client.itemGet({ access_token: token })).data;
  const item = itemResponse.item;
  const itemId = item.item_id;

  reportProgress(`Plaid Item validated (institution=${item.institution_name || 'unknown'})`);

  if (expectedItemId && expectedItemId !== itemId) {
    throw new ValidationError({ message: t({ key: 'bankDataProviders.plaid.expectedItemMismatch' }) });
  }

  const connectionRepository = dependencies.connectionRepository || (await createModelRepository());
  reportProgress('Checking for an existing Plaid connection in the application database');
  const existing = await connectionRepository.findByItemId(itemId);
  if (existing && existing.userId !== userId) {
    throw new ValidationError({ message: t({ key: 'bankDataProviders.plaid.itemOwnedByAnotherUser' }) });
  }
  if (existing && !allowExisting) {
    throw new ValidationError({ message: t({ key: 'bankDataProviders.plaid.itemAlreadyConnected' }) });
  }
  reportProgress(`Connection ownership check complete (${existing ? 'existing connection found' : 'new connection'})`);

  const products = new Set<string>([...(item.products || []), ...item.billed_products]);
  if (requireTransactions && !products.has('transactions')) {
    throw new ValidationError({ message: t({ key: 'bankDataProviders.plaid.transactionsNotEnabled' }) });
  }

  if (requireTransactions) reportProgress('Plaid Transactions product confirmed');

  if (validateAccounts) reportProgress('Calling Plaid accounts/get to verify account access');

  const accountsResponse = validateAccounts ? (await client.accountsGet({ access_token: token })).data : undefined;

  if (accountsResponse)
    reportProgress(`Plaid account access verified (${accountsResponse.accounts.length} account(s))`);

  let webhookUrl = item.webhook || undefined;

  if (updateWebhook) {
    if (!config.webhookUrl) {
      throw new ValidationError({ message: t({ key: 'bankDataProviders.plaid.webhookNotConfigured' }) });
    }
    reportProgress('Calling Plaid item/webhook/update');
    const webhookResponse = (await client.itemWebhookUpdate({ access_token: token, webhook: config.webhookUrl })).data;
    webhookUrl = webhookResponse.item.webhook || undefined;
    reportProgress('Plaid Item webhook updated');
  }

  const institutionId = institutionIdOverride || item.institution_id || undefined;
  const institutionName = institutionNameOverride || item.institution_name || undefined;

  if (existing) {
    reportProgress('Reusing the existing application connection; no database insert required');
    return {
      connectionId: existing.id,
      created: false,
      accountCount: accountsResponse?.accounts.length || 0,
      institutionName,
    };
  }

  reportProgress('Encrypting credentials and creating the application connection');

  const connection = await connectionRepository.create({
    userId,
    providerType: BANK_PROVIDER_TYPE.PLAID,
    providerName: connectionName?.trim() || institutionName || 'Plaid',
    isActive: true,
    credentials: encryptCredentials({ accessToken: token, itemId }),
    metadata: {
      itemId,
      institutionId,
      institutionName,
      environment: config.environment,
      provisioningSource,
      webhookUrl,
      products: [...products],
      status: 'active',
      consecutiveAuthFailures: 0,
      deactivationReason: null,
    } satisfies PlaidMetadata,
  });

  reportProgress('Application connection created');

  return {
    connectionId: connection.id,
    created: true,
    accountCount: accountsResponse?.accounts.length || 0,
    institutionName,
  };
}
