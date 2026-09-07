import { PAYMENT_TYPES, TRANSACTION_TYPES } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';
import { CounterpartyType, TransactionCode, TransactionPaymentChannelEnum, type Transaction } from 'plaid';

import {
  inferPlaidPayeeName,
  inferPlaidPaymentType,
  isPlaidPaymentTypeSyncManaged,
  mapPlaidTransaction,
} from './transaction-mapping';

const emptyPaymentMeta = {
  reference_number: null,
  ppd_id: null,
  payee: null,
  by_order_of: null,
  payer: null,
  payment_method: null,
  payment_processor: null,
  reason: null,
};

const transaction = (overrides: Partial<Transaction> = {}): Transaction =>
  ({
    account_id: 'account-1',
    account_owner: null,
    amount: 10,
    authorized_date: '2026-08-31',
    authorized_datetime: null,
    counterparties: [],
    date: '2026-09-01',
    datetime: null,
    iso_currency_code: 'USD',
    location: {},
    merchant_name: null,
    name: 'UNCLASSIFIED TRANSACTION',
    original_description: null,
    payment_channel: TransactionPaymentChannelEnum.Other,
    payment_meta: emptyPaymentMeta,
    pending: false,
    pending_transaction_id: null,
    personal_finance_category: null,
    transaction_code: null,
    transaction_id: 'transaction-1',
    unofficial_currency_code: null,
    ...overrides,
  }) as Transaction;

describe('mapPlaidTransaction', () => {
  it('maps Plaid outflows to expenses with a negative provider-contract amount', () => {
    const mapped = mapPlaidTransaction(transaction({ amount: 12.34 }));

    expect(mapped.amount).toBe(-1234);
    expect(mapped.transactionType).toBe(TRANSACTION_TYPES.expense);
  });

  it('maps Plaid inflows to income with a positive provider-contract amount', () => {
    const mapped = mapPlaidTransaction(transaction({ amount: -56.78 }));

    expect(mapped.amount).toBe(5678);
    expect(mapped.transactionType).toBe(TRANSACTION_TYPES.income);
  });

  it('retains the classifier decision and evidence in metadata', () => {
    const mapped = mapPlaidTransaction(
      transaction({ amount: -25, payment_meta: { ...emptyPaymentMeta, payment_method: 'ACH' } }),
    );

    expect(mapped.paymentType).toBe(PAYMENT_TYPES.achCredit);
    expect(mapped.metadata?.plaidPaymentTypeInference).toEqual({
      classifierVersion: 1,
      confidence: 'high',
      matchedSignals: ['payment_meta.payment_method:ach'],
      paymentType: PAYMENT_TYPES.achCredit,
    });
  });
});

describe('isPlaidPaymentTypeSyncManaged', () => {
  it('refreshes legacy bank-transfer defaults and unchanged classifier decisions', () => {
    expect(isPlaidPaymentTypeSyncManaged({ currentPaymentType: PAYMENT_TYPES.bankTransfer, externalData: {} })).toBe(
      true,
    );
    expect(
      isPlaidPaymentTypeSyncManaged({
        currentPaymentType: PAYMENT_TYPES.unknown,
        externalData: { plaidPaymentTypeInference: { paymentType: PAYMENT_TYPES.unknown } },
      }),
    ).toBe(true);
  });

  it('preserves a payment type the user changed after Plaid classified the transaction', () => {
    expect(
      isPlaidPaymentTypeSyncManaged({
        currentPaymentType: PAYMENT_TYPES.cash,
        externalData: { plaidPaymentTypeInference: { paymentType: PAYMENT_TYPES.unknown } },
      }),
    ).toBe(false);
  });
});

describe('inferPlaidPayeeName', () => {
  it('uses the payer rather than an outgoing payee or merchant for incoming transfers', () => {
    expect(
      inferPlaidPayeeName(
        transaction({
          amount: -100,
          merchant_name: 'Fallback merchant',
          payment_meta: { ...emptyPaymentMeta, payee: 'Account owner', payer: 'Acme Payroll' },
        }),
      ),
    ).toBe('Acme Payroll');
  });

  it('uses an enriched income-source counterparty when no payer is available', () => {
    expect(
      inferPlaidPayeeName(
        transaction({
          amount: -100,
          counterparties: [
            {
              name: 'Example Bank',
              type: CounterpartyType.FinancialInstitution,
              confidence_level: 'VERY_HIGH',
              entity_id: null,
              logo_url: null,
              website: null,
            },
            {
              name: 'Acme Incorporated',
              type: CounterpartyType.IncomeSource,
              confidence_level: 'HIGH',
              entity_id: null,
              logo_url: null,
              website: null,
            },
          ],
        }),
      ),
    ).toBe('Acme Incorporated');
  });

  it('keeps merchant and transfer payee precedence for outgoing transactions', () => {
    expect(
      inferPlaidPayeeName(
        transaction({
          merchant_name: 'Enriched Merchant',
          payment_meta: { ...emptyPaymentMeta, payee: 'Raw Payee' },
        }),
      ),
    ).toBe('Enriched Merchant');

    expect(inferPlaidPayeeName(transaction({ payment_meta: { ...emptyPaymentMeta, payee: 'Utility Company' } }))).toBe(
      'Utility Company',
    );
  });
});

describe('inferPlaidPaymentType', () => {
  it.each([
    ['check number', transaction({ check_number: '1042' }), PAYMENT_TYPES.check, 'high'],
    ['cheque code', transaction({ transaction_code: TransactionCode.Cheque }), PAYMENT_TYPES.check, 'high'],
    ['check description fallback', transaction({ name: 'CHECK #1042' }), PAYMENT_TYPES.check, 'medium'],
    [
      'Zelle payment-app counterparty',
      transaction({
        amount: -25,
        counterparties: [
          {
            name: 'Zelle',
            type: CounterpartyType.PaymentApp,
            confidence_level: 'HIGH',
            entity_id: 'zelle-entity',
            logo_url: null,
            website: null,
          },
        ],
      }),
      PAYMENT_TYPES.zelleCredit,
      'medium-high',
    ],
    [
      'Zelle description fallback',
      transaction({ amount: -25, name: 'ZELLE FROM JANE' }),
      PAYMENT_TYPES.zelleCredit,
      'medium',
    ],
    [
      'ACH metadata',
      transaction({ amount: -25, payment_meta: { ...emptyPaymentMeta, payment_method: ' ach ' } }),
      PAYMENT_TYPES.achCredit,
      'high',
    ],
    [
      'ACH description fallback',
      transaction({ amount: -25, name: 'ACH CREDIT PAYROLL' }),
      PAYMENT_TYPES.achCredit,
      'medium',
    ],
    [
      'loan PFC',
      transaction({
        amount: 500,
        personal_finance_category: {
          primary: 'LOAN_PAYMENTS',
          detailed: 'LOAN_PAYMENTS_MORTGAGE_PAYMENT',
          confidence_level: 'HIGH',
        },
      }),
      PAYMENT_TYPES.loanPayment,
      'medium-high',
    ],
    [
      'bill-payment code',
      transaction({ transaction_code: TransactionCode.BillPayment }),
      PAYMENT_TYPES.billPayment,
      'high',
    ],
    ['bill-payment description', transaction({ name: 'ONLINE BILLPAY ELECTRIC' }), PAYMENT_TYPES.billPayment, 'medium'],
    [
      'transfer code',
      transaction({ transaction_code: TransactionCode.Transfer }),
      PAYMENT_TYPES.accountTransfer,
      'medium-high',
    ],
    [
      'transfer PFC',
      transaction({
        personal_finance_category: {
          primary: 'TRANSFER_OUT',
          detailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER',
          confidence_level: 'HIGH',
        },
      }),
      PAYMENT_TYPES.accountTransfer,
      'medium-high',
    ],
    ['purchase code', transaction({ transaction_code: TransactionCode.Purchase }), PAYMENT_TYPES.card, 'medium-high'],
    [
      'payment channel plus merchant',
      transaction({ payment_channel: TransactionPaymentChannelEnum.InStore, merchant_name: 'Corner Shop' }),
      PAYMENT_TYPES.card,
      'medium-high',
    ],
    ['unknown', transaction(), PAYMENT_TYPES.unknown, 'none'],
  ])('infers %s', (_label, tx, expectedType, expectedConfidence) => {
    const inference = inferPlaidPaymentType(tx as Transaction);

    expect(inference.paymentType).toBe(expectedType);
    expect(inference.confidence).toBe(expectedConfidence);
  });

  it('does not classify outgoing Zelle or ACH wording as an incoming credit', () => {
    expect(inferPlaidPaymentType(transaction({ amount: 25, name: 'ZELLE PAYMENT' })).paymentType).toBe(
      PAYMENT_TYPES.unknown,
    );
    expect(inferPlaidPaymentType(transaction({ amount: 25, name: 'ACH CREDIT' })).paymentType).toBe(
      PAYMENT_TYPES.unknown,
    );
  });

  it('uses the documented precedence when several signals overlap', () => {
    const inference = inferPlaidPaymentType(
      transaction({
        amount: -25,
        check_number: '1042',
        name: 'ZELLE ACH CREDIT',
        payment_meta: { ...emptyPaymentMeta, payment_method: 'ACH' },
      }),
    );

    expect(inference.paymentType).toBe(PAYMENT_TYPES.check);
  });
});
