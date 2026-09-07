/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  ACCOUNT_TYPES,
  BANK_PROVIDER_TYPE,
  PAYMENT_TYPES,
  TRANSACTION_TRANSFER_NATURE,
  type RecordId,
} from '@bt/shared/types';
import { Money } from '@common/types/money';
import { t } from '@i18n/index';
import { BadRequestError, ForbiddenError, NotFoundError, ValidationError } from '@js/errors';
import { logger } from '@js/utils/logger';
import Accounts from '@models/accounts.model';
import BankDataProviderConnections from '@models/bank-data-provider-connections.model';
import { findOneTransaction } from '@models/transactions-query';
import { createTransaction } from '@services/transactions';
import {
  AccountBase,
  ItemPublicTokenExchangeResponse,
  PlaidApi,
  Transaction,
  TransactionsGetRequest,
  TransactionsSyncRequest,
} from 'plaid';
import { Sequelize } from 'sequelize';

import { BaseBankDataProvider } from '../base-provider';
import { DateRange, ProviderAccount, ProviderBalance, ProviderMetadata } from '../types';
import { writeBankBalanceWithHistory } from '../utils/write-bank-balance-with-history';
import { createPlaidClient, getPlaidConfig, PlaidConfig } from './config';
import { importPlaidItem } from './import-existing-item';
import { isPlaidPaymentTypeSyncManaged, mapPlaidTransaction } from './transaction-mapping';
import { PlaidCredentials, PlaidExistingItemImportInput, PlaidExistingItemImportResult, PlaidMetadata } from './types';

const INITIAL_DAYS = 180;

/** Plaid adapter. Link orchestration is intentionally provider-specific; all
 * persisted account/transaction work still enters through IBankDataProvider. */
export class PlaidProvider extends BaseBankDataProvider {
  readonly metadata: ProviderMetadata = {
    type: BANK_PROVIDER_TYPE.PLAID,
    name: 'Plaid',
    description: 'Connect US and Canadian bank accounts through Plaid',
    documentationUrl: 'https://plaid.com/docs/',
    features: {
      supportsWebhooks: true,
      supportsRealtime: false,
      requiresReauth: true,
      supportsManualSync: true,
      supportsAutoSync: true,
      defaultSyncInterval: 6 * 60 * 60 * 1000,
      minSyncInterval: 60 * 1000,
    },
  };

  private config(): PlaidConfig {
    const config = getPlaidConfig();
    if (!config) throw new ValidationError({ message: t({ key: 'bankDataProviders.plaid.notConfigured' }) });
    return config;
  }

  private client(): PlaidApi {
    return createPlaidClient(this.config());
  }

  private async plaidCall<T>(connectionId: string | undefined, call: () => Promise<{ data: T }>): Promise<T> {
    try {
      const result = await call();
      if (connectionId) await this.resetAuthFailures(connectionId);
      return result.data;
    } catch (error: any) {
      const code = error?.response?.data?.error_code || error?.response?.data?.error_type;
      if (connectionId && ['ITEM_LOGIN_REQUIRED', 'INVALID_ACCESS_TOKEN', 'USER_PERMISSION_REVOKED'].includes(code)) {
        await this.handleAuthError({ connectionId, error: new ForbiddenError({ message: String(code) }) });
      }
      if (['ITEM_LOGIN_REQUIRED', 'INVALID_ACCESS_TOKEN', 'USER_PERMISSION_REVOKED'].includes(code)) {
        throw new ForbiddenError({ message: String(code) });
      }
      throw error;
    }
  }

  async createLinkToken({ userId, connectionId }: { userId: number; connectionId?: string }) {
    const config = this.config();
    const request: any = {
      client_name: config.clientName,
      language: 'en',
      country_codes: config.countryCodes,
      user: { client_user_id: String(userId) },
      redirect_uri: config.redirectUri,
      webhook: config.webhookUrl,
    };
    if (connectionId) {
      const connection = await this.getConnection(connectionId);
      if (connection.userId !== userId) throw new NotFoundError({ message: t({ key: 'errors.connectionNotFound' }) });
      request.access_token = (connection.getDecryptedCredentials() as unknown as PlaidCredentials).accessToken;
    } else {
      request.products = ['transactions'];
      request.transactions = { days_requested: INITIAL_DAYS };
    }
    return this.plaidCall(undefined, () => this.client().linkTokenCreate(request));
  }

  async connect(userId: number, credentials: unknown): Promise<string> {
    const input = credentials as Record<string, unknown>;
    if (typeof input?.publicToken !== 'string' || !input.publicToken) {
      throw new ValidationError({ message: t({ key: 'bankDataProviders.plaid.invalidCredentialsFormat' }) });
    }
    const exchanged = await this.plaidCall<ItemPublicTokenExchangeResponse>(undefined, () =>
      this.client().itemPublicTokenExchange({ public_token: input.publicToken as string }),
    );
    const institution = (input.institution as Record<string, unknown> | undefined) || {};
    const result = await importPlaidItem({
      userId,
      accessToken: exchanged.access_token,
      expectedItemId: exchanged.item_id,
      connectionName: typeof institution.name === 'string' ? institution.name : undefined,
      institutionId: typeof institution.institution_id === 'string' ? institution.institution_id : undefined,
      institutionName: typeof institution.name === 'string' ? institution.name : undefined,
      provisioningSource: 'link',
      allowExisting: false,
      validateAccounts: false,
      requireTransactions: false,
    });
    return result.connectionId;
  }

  /**
   * Imports an Item that was linked outside this application. This method is
   * intentionally server-only and is not exposed by the generic connect API.
   */
  async importExistingItem(input: PlaidExistingItemImportInput): Promise<PlaidExistingItemImportResult> {
    return importPlaidItem({
      ...input,
      provisioningSource: 'external',
      allowExisting: true,
      validateAccounts: true,
      requireTransactions: true,
    });
  }

  async disconnect(connectionId: string): Promise<void> {
    const connection = await this.getConnection(connectionId);
    this.validateProviderType(connection);
    try {
      const { accessToken } = connection.getDecryptedCredentials() as unknown as PlaidCredentials;
      await this.client().itemRemove({ access_token: accessToken });
    } catch (error) {
      // Local disconnect must remain usable if the Item is already revoked.
      logger.warn(`[Plaid] item/remove failed during disconnect ${connectionId}: ${String(error)}`);
    }
    await connection.destroy();
  }

  async validateCredentials(credentials: unknown): Promise<boolean> {
    const input = credentials as Partial<PlaidCredentials>;
    if (!input?.accessToken) return false;
    try {
      await this.client().itemGet({ access_token: input.accessToken });
      return true;
    } catch (error: any) {
      const code = error?.response?.data?.error_code;
      if (['ITEM_LOGIN_REQUIRED', 'INVALID_ACCESS_TOKEN', 'USER_PERMISSION_REVOKED'].includes(code)) return false;
      throw error;
    }
  }

  async refreshCredentials(connectionId: string, newCredentials: unknown): Promise<void> {
    const input = newCredentials as Record<string, unknown>;
    if (typeof input?.publicToken !== 'string') {
      throw new ValidationError({ message: t({ key: 'bankDataProviders.plaid.invalidCredentialsFormat' }) });
    }
    const exchanged = await this.client().itemPublicTokenExchange({ public_token: input.publicToken });
    const connection = await this.getConnection(connectionId);
    this.validateProviderType(connection);
    connection.setEncryptedCredentials({ accessToken: exchanged.data.access_token, itemId: exchanged.data.item_id });
    connection.isActive = true;
    connection.metadata = {
      ...(connection.metadata as PlaidMetadata),
      itemId: exchanged.data.item_id,
      status: 'active',
      consecutiveAuthFailures: 0,
      deactivationReason: null,
    };
    await connection.save();
  }

  async completeReauthorization(connectionId: string): Promise<void> {
    const connection = await this.getConnection(connectionId);
    this.validateProviderType(connection);
    const { accessToken } = connection.getDecryptedCredentials() as unknown as PlaidCredentials;
    await this.client().itemGet({ access_token: accessToken });
    connection.isActive = true;
    connection.metadata = {
      ...(connection.metadata as PlaidMetadata),
      status: 'active',
      consecutiveAuthFailures: 0,
      deactivationReason: null,
    };
    await connection.save();
  }

  async fetchAccounts(connectionId: string): Promise<ProviderAccount[]> {
    const { accessToken } = await this.credentials(connectionId);
    const response = await this.plaidCall(connectionId, () => this.client().accountsGet({ access_token: accessToken }));
    return (response as any).accounts.map((account: AccountBase) => this.mapAccount(account));
  }

  async fetchTransactions(connectionId: string, accountExternalId: string, dateRange?: DateRange) {
    const { accessToken } = await this.credentials(connectionId);
    const to = dateRange?.to || new Date();
    const from = dateRange?.from || new Date(to.getTime() - INITIAL_DAYS * 86400000);
    const request: TransactionsGetRequest = {
      access_token: accessToken,
      start_date: from.toISOString().slice(0, 10),
      end_date: to.toISOString().slice(0, 10),
      options: { account_ids: [accountExternalId], include_original_description: true },
    };
    const response = await this.plaidCall(connectionId, () => this.client().transactionsGet(request));
    return (response as any).transactions.map((tx: Transaction) => mapPlaidTransaction(tx));
  }

  async fetchBalance(connectionId: string, accountExternalId: string): Promise<ProviderBalance> {
    const { accessToken } = await this.credentials(connectionId);
    const response = await this.plaidCall(connectionId, () =>
      this.client().accountsBalanceGet({ access_token: accessToken, options: { account_ids: [accountExternalId] } }),
    );
    const account = (response as any).accounts?.[0] as AccountBase | undefined;
    if (!account) throw new NotFoundError({ message: t({ key: 'bankDataProviders.plaid.accountNotFound' }) });
    const balance = this.balanceForAccount(account);
    return { amount: Money.fromDecimal(balance).toCents(), currency: this.currency(account)!, asOf: new Date() };
  }

  async refreshBalance(connectionId: string, systemAccountId: string): Promise<void> {
    const account = await this.getSystemAccount(systemAccountId);
    if (!account.externalId)
      throw new BadRequestError({ message: t({ key: 'bankDataProviders.plaid.accountNoExternalId' }) });
    const balance = await this.fetchBalance(connectionId, account.externalId);
    await writeBankBalanceWithHistory({ account, balance: Money.fromCents(balance.amount) });
  }

  async syncTransactions(args: { connectionId: string; systemAccountId: RecordId; userId: number }): Promise<void> {
    await this.syncOneAccount(args.connectionId, args.systemAccountId, args.userId);
  }

  async syncConnectionAccounts({
    connectionId,
    userId,
    systemAccountIds,
  }: {
    connectionId: string;
    userId: number;
    systemAccountIds: string[];
  }): Promise<void> {
    for (const accountId of systemAccountIds) await this.syncOneAccount(connectionId, accountId, userId);
  }

  async createUpdateLinkToken(userId: number, connectionId: string) {
    return this.createLinkToken({ userId, connectionId });
  }

  /** Called by the webhook adapter after signature verification. The actual
   * transaction payload is never trusted; the cursor sync is authoritative. */
  async handleWebhook(payload: unknown): Promise<void> {
    const body = payload as {
      item_id?: string;
      webhook_type?: string;
      webhook_code?: string;
      error?: { error_code?: string };
    };
    if (!body.item_id) return;
    const connection = await BankDataProviderConnections.findOne({
      where: { providerType: this.metadata.type, metadata: { itemId: body.item_id } } as any,
    });
    if (!connection) return;
    const metadata = { ...(connection.metadata as PlaidMetadata), lastWebhookAt: new Date().toISOString() };
    const itemError = body.error?.error_code;
    if (itemError === 'ITEM_LOGIN_REQUIRED' || itemError === 'INVALID_ACCESS_TOKEN') {
      connection.isActive = false;
      metadata.status = 'login_required';
      metadata.deactivationReason = 'auth_failure';
      connection.metadata = metadata;
      await connection.save({ transaction: null });
      return;
    }
    if (body.webhook_code === 'PENDING_DISCONNECT') metadata.status = 'pending_disconnect';
    if (body.webhook_code === 'USER_PERMISSION_REVOKED') {
      connection.isActive = false;
      metadata.status = 'revoked';
      metadata.deactivationReason = 'auth_failure';
    }
    connection.metadata = metadata;
    await connection.save({ transaction: null });
    if (body.webhook_type === 'TRANSACTIONS' && body.webhook_code === 'SYNC_UPDATES_AVAILABLE') {
      const accounts = await Accounts.findAll({
        where: { bankDataProviderConnectionId: connection.id, userId: connection.userId, isEnabled: true },
      });
      for (const account of accounts) {
        this.syncOneAccount(connection.id, account.id, connection.userId).catch((error) =>
          logger.error({ message: '[Plaid] webhook sync failed', error }),
        );
      }
    }
  }

  private async syncOneAccount(connectionId: string, systemAccountId: string, userId: number): Promise<void> {
    await this.runSyncWithStatus({
      systemAccountId: systemAccountId as RecordId,
      userId,
      connectionId,
      errorLogMessage: '[Plaid] transaction sync failed',
      work: async () => {
        const account = await this.getSystemAccount(systemAccountId);
        const { accessToken } = await this.credentials(connectionId);
        const cursor = ((account.externalData || {}) as any).plaidTransactionsCursor as string | undefined;
        let nextCursor = cursor;
        let hasMore = true;
        const added: Transaction[] = [];
        const modified: Transaction[] = [];
        const removed: string[] = [];
        while (hasMore) {
          const request: TransactionsSyncRequest = {
            access_token: accessToken,
            cursor: nextCursor,
            count: 500,
            options: { account_id: account.externalId!, include_original_description: true },
          };
          const page = await this.plaidCall(connectionId, () => this.client().transactionsSync(request));
          added.push(...((page as any).added || []));
          modified.push(...((page as any).modified || []));
          removed.push(...((page as any).removed || []).map((row: any) => row.transaction_id));
          nextCursor = (page as any).next_cursor;
          hasMore = Boolean((page as any).has_more);
        }
        const transactionIds: string[] = [];
        for (const tx of modified) await this.upsertTransaction(account, connectionId, tx, false, transactionIds);
        for (const tx of added) await this.upsertTransaction(account, connectionId, tx, true, transactionIds);
        for (const id of removed) {
          const row = await findOneTransaction({
            planned: 'exclude',
            access: 'unscoped-internal',
            balanceAdjustments: 'include',
            where: { accountId: account.id, originalId: id },
          });
          if (row && !row.transferId && !row.refundLinked) await row.destroy();
        }
        account.externalData = { ...account.externalData, plaidTransactionsCursor: nextCursor } as any;
        await account.save();
        const current = await this.fetchBalance(connectionId, account.externalId!);
        await writeBankBalanceWithHistory({ account, balance: Money.fromCents(current.amount) });
        return { transactionIds };
      },
    });
  }

  private async upsertTransaction(
    account: Accounts,
    connectionId: string,
    tx: Transaction,
    create: boolean,
    ids: string[],
  ) {
    const mapped = mapPlaidTransaction(tx);
    const existing = await findOneTransaction({
      planned: 'exclude',
      access: 'unscoped-internal',
      balanceAdjustments: 'include',
      where: { accountId: account.id, originalId: mapped.externalId },
    });
    const pending =
      !existing && tx.pending_transaction_id
        ? await findOneTransaction({
            planned: 'exclude',
            access: 'unscoped-internal',
            balanceAdjustments: 'include',
            where: Sequelize.and(
              { accountId: account.id },
              Sequelize.where(Sequelize.literal(`"externalData"->>'plaidTransactionId'`), tx.pending_transaction_id),
            ),
          })
        : null;
    if (pending) {
      const refreshPaymentType = isPlaidPaymentTypeSyncManaged({
        currentPaymentType: pending.paymentType as PAYMENT_TYPES,
        externalData: pending.externalData,
      });
      await pending.update({
        originalId: mapped.externalId,
        amount: Money.fromCents(Math.abs(mapped.amount)),
        time: mapped.date,
        transactionType: mapped.transactionType,
        ...(refreshPaymentType && { paymentType: mapped.paymentType }),
        externalData: { ...pending.externalData, ...mapped.metadata, plaidPending: false },
      });
      ids.push(pending.id);
      return;
    }
    if (existing) {
      if (!create) {
        const refreshPaymentType = isPlaidPaymentTypeSyncManaged({
          currentPaymentType: existing.paymentType as PAYMENT_TYPES,
          externalData: existing.externalData,
        });
        await existing.update({
          amount: Money.fromCents(Math.abs(mapped.amount)),
          time: mapped.date,
          transactionType: mapped.transactionType,
          ...(refreshPaymentType && { paymentType: mapped.paymentType }),
          externalData: { ...existing.externalData, ...mapped.metadata, plaidPending: tx.pending },
          note: existing.note,
        });
        ids.push(existing.id);
      }
      return;
    }
    const result = await createTransaction({
      originalId: mapped.externalId,
      note: mapped.description,
      amount: Money.fromCents(Math.abs(mapped.amount)),
      time: mapped.date,
      externalData: { ...mapped.metadata, plaidPending: tx.pending },
      commissionRate: Money.zero(),
      cashbackAmount: Money.zero(),
      accountId: account.id,
      userId: account.userId,
      transactionType: mapped.transactionType,
      paymentType: mapped.paymentType,
      categoryId: await this.defaultCategory(account.userId),
      transferNature: TRANSACTION_TRANSFER_NATURE.not_transfer,
      accountType: ACCOUNT_TYPES.plaid,
      rawMerchantName: mapped.payeeName || null,
    });
    if (!(result as any).mergedIntoPlanned) ids.push(result[0].id);
  }

  private async defaultCategory(userId: number): Promise<string> {
    const { getUserDefaultCategory } = await import('@models/users.model');
    return await getUserDefaultCategory({ id: userId });
  }

  private mapAccount(account: AccountBase): ProviderAccount {
    const currency = this.currency(account.balances) || 'XXX';
    return {
      externalId: account.account_id,
      name: account.name || account.official_name || account.account_id,
      type: account.subtype || account.type,
      balance: Money.fromDecimal(this.balanceForAccount(account)).toCents(),
      currency,
      metadata: {
        plaidType: account.type,
        plaidSubtype: account.subtype,
        mask: account.mask,
        officialName: account.official_name,
        creditLimit: account.balances.limit,
        availableBalance: account.balances.available,
        currentBalance: account.balances.current,
      },
    };
  }

  private currency(value: any): string | null {
    return value.iso_currency_code || value.unofficial_currency_code || null;
  }
  private balanceForAccount(account: AccountBase): number {
    const current = account.balances.current ?? 0;
    const available = account.balances.available;
    if (account.type === 'credit') return available ?? (account.balances.limit ?? 0) - current;
    return available ?? current;
  }
  private async credentials(connectionId: string): Promise<PlaidCredentials> {
    const connection = await this.getConnection(connectionId);
    this.validateProviderType(connection);
    const credentials = connection.getDecryptedCredentials() as unknown as PlaidCredentials;
    if (!credentials.accessToken || !credentials.itemId)
      throw new ValidationError({ message: t({ key: 'bankDataProviders.plaid.invalidStoredCredentials' }) });
    return credentials;
  }
}
