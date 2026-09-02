import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { connection } from '@models/connection';
import type Transactions from '@models/transactions.model';

import { attachRunningBalances } from './attach-running-balances';

jest.mock('@models/connection', () => ({
  connection: { sequelize: { query: jest.fn() } },
}));

const query = connection.sequelize.query as jest.MockedFunction<
  (sql: string, options: unknown) => Promise<Array<{ transactionId: string; runningBalance: string }>>
>;
const tx = (id: string) => ({ id }) as Transactions;

describe('attachRunningBalances', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it('attaches returned cents and leaves inaccessible account rows null', async () => {
    query.mockResolvedValue([{ transactionId: 'visible', runningBalance: '0' }]);

    const result = await attachRunningBalances({
      transactions: [tx('visible'), tx('budget-only')],
      accessibleAccountIds: ['account-1'],
      userId: 42,
    });

    expect(result.map(({ runningBalance }) => runningBalance)).toEqual([0, null]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![1]).toMatchObject({
      replacements: {
        transactionIds: ['visible', 'budget-only'],
        accessibleAccountIds: ['account-1'],
        userId: 42,
      },
    });
  });

  it('does not query ledger data when none of the accounts are accessible', async () => {
    const result = await attachRunningBalances({
      transactions: [tx('budget-only')],
      accessibleAccountIds: [],
      userId: 42,
    });

    expect(result[0]!.runningBalance).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});
