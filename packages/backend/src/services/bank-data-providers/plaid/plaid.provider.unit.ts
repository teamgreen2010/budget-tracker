import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AccountsGetResponse, ItemGetResponse, ItemWebhookUpdateResponse } from 'plaid';

import { decryptCredentials } from '../utils/credential-encryption';

const mockItemGet = jest.fn<(request: { access_token: string }) => Promise<{ data: ItemGetResponse }>>();
const mockAccountsGet = jest.fn<(request: { access_token: string }) => Promise<{ data: AccountsGetResponse }>>();
const mockItemWebhookUpdate =
  jest.fn<
    (request: { access_token: string; webhook?: string | null }) => Promise<{ data: ItemWebhookUpdateResponse }>
  >();
const mockFindOne = jest.fn<(...args: unknown[]) => Promise<{ id: string; userId: number } | null>>();
const mockCreate = jest.fn<(...args: unknown[]) => Promise<{ id: string }>>();

jest.mock('./config', () => ({
  createPlaidClient: () => ({
    itemGet: mockItemGet,
    accountsGet: mockAccountsGet,
    itemWebhookUpdate: mockItemWebhookUpdate,
  }),
  getPlaidConfig: () => ({
    clientId: 'client-id',
    secret: 'secret',
    environment: 'sandbox',
    countryCodes: ['US'],
    webhookUrl: 'https://example.test/api/v1/webhooks/plaid',
    clientName: 'MoneyMatter',
  }),
}));

jest.mock('@models/bank-data-provider-connections.model', () => ({
  __esModule: true,
  default: {
    findOne: mockFindOne,
    create: mockCreate,
  },
}));

import { importPlaidItem } from './import-existing-item';

const itemResponse = {
  item: {
    item_id: 'item-1',
    institution_id: 'ins-1',
    institution_name: 'Example Bank',
    webhook: 'https://old.example.test/plaid',
    error: null,
    available_products: [],
    billed_products: ['transactions'],
    products: ['transactions'],
    consent_expiration_time: null,
    update_type: 'background',
  },
  request_id: 'request-1',
} as unknown as ItemGetResponse;

const accountsResponse = {
  accounts: [{ account_id: 'account-1' }, { account_id: 'account-2' }],
  item: itemResponse.item,
  request_id: 'request-2',
} as unknown as AccountsGetResponse;

const importExternalItem = (input: {
  userId: number;
  accessToken: string;
  expectedItemId?: string;
  updateWebhook?: boolean;
}) =>
  importPlaidItem({
    ...input,
    provisioningSource: 'external',
    allowExisting: true,
    validateAccounts: true,
    requireTransactions: true,
  });

describe('PlaidProvider.importExistingItem', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockItemGet.mockResolvedValue({ data: itemResponse });
    mockAccountsGet.mockResolvedValue({ data: accountsResponse });
    mockFindOne.mockResolvedValue(null);
    mockCreate.mockResolvedValue({ id: 'connection-1' });
  });

  it('validates and stores an externally provisioned Item with encrypted credentials', async () => {
    const result = await importExternalItem({
      userId: 7,
      accessToken: 'access-token',
      expectedItemId: 'item-1',
    });

    expect(result).toEqual({
      connectionId: 'connection-1',
      created: true,
      accountCount: 2,
      institutionName: 'Example Bank',
    });
    expect(mockItemGet).toHaveBeenCalledWith({ access_token: 'access-token' });
    expect(mockAccountsGet).toHaveBeenCalledWith({ access_token: 'access-token' });

    const payload = mockCreate.mock.calls[0]![0] as {
      credentials: string;
      metadata: Record<string, unknown>;
      providerName: string;
      userId: number;
    };
    expect(decryptCredentials(payload.credentials)).toEqual({ accessToken: 'access-token', itemId: 'item-1' });
    expect(payload).toMatchObject({
      userId: 7,
      providerName: 'Example Bank',
      metadata: {
        itemId: 'item-1',
        institutionId: 'ins-1',
        provisioningSource: 'external',
        environment: 'sandbox',
      },
    });
  });

  it('is idempotent for an Item already imported by the same user', async () => {
    mockFindOne.mockResolvedValue({ id: 'existing-connection', userId: 7 });

    const result = await importExternalItem({ userId: 7, accessToken: 'access-token' });

    expect(result).toMatchObject({ connectionId: 'existing-connection', created: false, accountCount: 2 });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('refuses to associate an Item with a second application user', async () => {
    mockFindOne.mockResolvedValue({ id: 'other-connection', userId: 99 });

    await expect(importExternalItem({ userId: 7, accessToken: 'access-token' })).rejects.toThrow(
      'bankDataProviders.plaid.itemOwnedByAnotherUser',
    );
    expect(mockAccountsGet).not.toHaveBeenCalled();
  });

  it('requires the Transactions product for an external import', async () => {
    mockItemGet.mockResolvedValue({
      data: {
        ...itemResponse,
        item: { ...itemResponse.item, products: [], billed_products: [] },
      } as ItemGetResponse,
    });

    await expect(importExternalItem({ userId: 7, accessToken: 'access-token' })).rejects.toThrow(
      'bankDataProviders.plaid.transactionsNotEnabled',
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('can update the imported Item webhook explicitly', async () => {
    mockItemWebhookUpdate.mockResolvedValue({
      data: {
        item: {
          ...itemResponse.item,
          webhook: 'https://example.test/api/v1/webhooks/plaid',
        },
        request_id: 'request-3',
      } as unknown as ItemWebhookUpdateResponse,
    });

    await importExternalItem({
      userId: 7,
      accessToken: 'access-token',
      updateWebhook: true,
    });

    expect(mockItemWebhookUpdate).toHaveBeenCalledWith({
      access_token: 'access-token',
      webhook: 'https://example.test/api/v1/webhooks/plaid',
    });
  });
});
