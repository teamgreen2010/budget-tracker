import { TRANSACTION_TYPES } from '@bt/shared/types';
import { connection } from '@models/connection';
import type Transactions from '@models/transactions.model';
import { QueryTypes } from 'sequelize';

interface RunningBalanceRow {
  transactionId: string;
  runningBalance: string;
}

/**
 * Adds the account balance immediately after each requested transaction.
 *
 * The ledger side intentionally ignores the list's filters and pagination: a
 * category/date filter changes which rows are displayed, not the balance those
 * rows had. Real transactions from every account participant contribute, while
 * planned rows retain their established owner-only visibility.
 *
 * Balances remain null when the caller can see a transaction through a shared
 * budget but cannot access its account. Calculating those rows would disclose
 * the account's opening balance and transactions outside the shared budget.
 */
export const attachRunningBalances = async <T extends Transactions>({
  transactions,
  accessibleAccountIds,
  userId,
}: {
  transactions: T[];
  accessibleAccountIds: string[];
  userId: number;
}): Promise<Array<T & { runningBalance: number | null }>> => {
  if (!transactions.length) return [];

  const balanceByTransactionId = new Map<string, number>();

  if (accessibleAccountIds.length) {
    const rows = (await connection.sequelize.query(
      `
      -- planned-ok: projected balances intentionally combine real rows with the caller's own plans
      SELECT target.id AS "transactionId",
             account."initialBalance" + COALESCE(
               SUM(
                 CASE
                   WHEN ledger."transactionType" = :incomeType THEN ledger.amount
                   ELSE -ledger.amount
                 END
               ),
               0
             ) AS "runningBalance"
        FROM "Transactions" target
        JOIN "Accounts" account ON account.id = target."accountId"
        LEFT JOIN "Transactions" ledger
          ON ledger."accountId" = target."accountId"
         AND (
           ledger.time < target.time
           OR (ledger.time = target.time AND ledger.id <= target.id)
         )
         AND (ledger."isPlanned" = false OR ledger."userId" = :userId)
       WHERE target.id IN (:transactionIds)
         AND target."accountId" IN (:accessibleAccountIds)
       GROUP BY target.id, account."initialBalance"
      `,
      {
        type: QueryTypes.SELECT,
        replacements: {
          transactionIds: transactions.map((tx) => tx.id),
          accessibleAccountIds,
          incomeType: TRANSACTION_TYPES.income,
          userId,
        },
      },
    )) as RunningBalanceRow[];

    for (const row of rows) {
      balanceByTransactionId.set(row.transactionId, Number(row.runningBalance));
    }
  }

  return transactions.map((tx) =>
    Object.assign(tx, {
      runningBalance: balanceByTransactionId.get(tx.id) ?? null,
    }),
  );
};
