import { PAYMENT_TYPES, TRANSACTION_TYPES } from '@bt/shared/types';
import { Money } from '@common/types/money';
import type { Transaction } from 'plaid';

import type { ProviderTransaction } from '../types';

export const PLAID_PAYMENT_TYPE_CLASSIFIER_VERSION = 1;

export type PlaidPaymentTypeConfidence = 'high' | 'medium-high' | 'medium' | 'none';

export interface PlaidPaymentTypeInference {
  classifierVersion: typeof PLAID_PAYMENT_TYPE_CLASSIFIER_VERSION;
  confidence: PlaidPaymentTypeConfidence;
  matchedSignals: string[];
  paymentType: PAYMENT_TYPES;
}

export interface MappedPlaidTransaction extends ProviderTransaction {
  payeeName?: string;
  paymentType: PAYMENT_TYPES;
  transactionType: TRANSACTION_TYPES;
}

/**
 * A Plaid refresh may improve its evidence after a pending transaction posts.
 * Refresh sync-owned classifications while preserving any payment type the
 * user changed after the prior sync. bankTransfer identifies legacy Plaid
 * rows created before classifier metadata was recorded.
 */
export function isPlaidPaymentTypeSyncManaged({
  currentPaymentType,
  externalData,
}: {
  currentPaymentType: PAYMENT_TYPES;
  externalData: Record<string, unknown> | null | undefined;
}): boolean {
  const priorInference = externalData?.plaidPaymentTypeInference;
  if (priorInference && typeof priorInference === 'object') {
    const priorPaymentType = (priorInference as Record<string, unknown>).paymentType;
    if (typeof priorPaymentType === 'string') return currentPaymentType === priorPaymentType;
  }

  return currentPaymentType === PAYMENT_TYPES.bankTransfer;
}

const HIGH_CONFIDENCE = new Set(['HIGH', 'VERY_HIGH']);
const LOAN_PAYMENT_CATEGORIES = new Set([
  'LOAN_PAYMENTS_CAR_PAYMENT',
  'LOAN_PAYMENTS_MORTGAGE_PAYMENT',
  'LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT',
  'LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT',
  'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
]);
const ACCOUNT_TRANSFER_CATEGORIES = new Set(['TRANSFER_IN_ACCOUNT_TRANSFER', 'TRANSFER_OUT_ACCOUNT_TRANSFER']);

const clean = (value: string | null | undefined): string | undefined => value?.trim() || undefined;

const normalize = (value: string | null | undefined): string =>
  value
    ?.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim() ?? '';

const descriptionText = (tx: Transaction): string =>
  [tx.name, tx.original_description].filter((value): value is string => Boolean(value)).join(' ');

const result = (
  paymentType: PAYMENT_TYPES,
  confidence: PlaidPaymentTypeConfidence,
  ...matchedSignals: string[]
): PlaidPaymentTypeInference => ({
  classifierVersion: PLAID_PAYMENT_TYPE_CLASSIFIER_VERSION,
  confidence,
  matchedSignals,
  paymentType,
});

const hasMerchantCounterparty = (tx: Transaction): boolean =>
  Boolean(
    clean(tx.merchant_name) ||
    tx.counterparties?.some((counterparty) =>
      ['merchant', 'marketplace', 'payment_terminal'].includes(counterparty.type),
    ),
  );

const hasHighConfidencePfc = (tx: Transaction): boolean =>
  HIGH_CONFIDENCE.has(tx.personal_finance_category?.confidence_level?.toUpperCase() ?? '');

/**
 * Applies the confidence-based precedence documented in
 * PLAID_TRANSACTION_TYPE_INFERENCE.md. Plaid's deprecated transaction_type
 * field is intentionally not consulted.
 */
export function inferPlaidPaymentType(tx: Transaction): PlaidPaymentTypeInference {
  const transactionCode = normalize(tx.transaction_code);
  const rawDescription = descriptionText(tx);
  const incoming = tx.amount < 0;

  if (clean(tx.check_number)) {
    return result(PAYMENT_TYPES.check, 'high', 'check_number');
  }
  if (transactionCode === 'cheque') {
    return result(PAYMENT_TYPES.check, 'high', 'transaction_code:cheque');
  }
  if (/\b(?:check|cheque)\b\s*(?:(?:no|number)\.?\s*)?#?\s*\d+\b/i.test(rawDescription)) {
    return result(PAYMENT_TYPES.check, 'medium', 'description:check_number');
  }

  if (incoming) {
    const zelleCounterparty = tx.counterparties?.find(
      (counterparty) => counterparty.type === 'payment_app' && /\bzelle\b/i.test(normalize(counterparty.name)),
    );
    if (zelleCounterparty) {
      const counterpartyConfidence = zelleCounterparty.confidence_level?.toUpperCase() ?? '';
      return result(
        PAYMENT_TYPES.zelleCredit,
        HIGH_CONFIDENCE.has(counterpartyConfidence) ? 'medium-high' : 'medium',
        'counterparty:payment_app:zelle',
        ...(counterpartyConfidence ? [`counterparty.confidence:${counterpartyConfidence}`] : []),
      );
    }
    if (/\bZELLE\b/i.test(rawDescription)) {
      return result(PAYMENT_TYPES.zelleCredit, 'medium', 'description:zelle');
    }
  }

  if (incoming && normalize(tx.payment_meta?.payment_method) === 'ach') {
    return result(PAYMENT_TYPES.achCredit, 'high', 'payment_meta.payment_method:ach');
  }
  if (incoming && /\bACH[\s_-]+CREDIT\b/i.test(rawDescription)) {
    const signals = ['description:ach_credit'];
    if (clean(tx.payment_meta?.ppd_id)) signals.push('payment_meta.ppd_id');
    return result(PAYMENT_TYPES.achCredit, 'medium', ...signals);
  }

  const pfc = tx.personal_finance_category;
  const loanCategory = pfc && LOAN_PAYMENT_CATEGORIES.has(pfc.detailed);
  if (tx.amount > 0 && loanCategory) {
    const loanDescription = /\b(?:loan|mortgage|student loan|auto (?:loan|finance)|car payment)\b/i.test(
      rawDescription,
    );
    const lenderCounterparty = tx.counterparties?.some((counterparty) => counterparty.type === 'financial_institution');
    if (hasHighConfidencePfc(tx)) {
      return result(PAYMENT_TYPES.loanPayment, 'medium-high', `personal_finance_category:${pfc.detailed}`);
    }
    if (loanDescription || lenderCounterparty) {
      const supportingSignal = loanDescription ? 'description:loan' : 'counterparty:financial_institution';
      return result(PAYMENT_TYPES.loanPayment, 'medium', `personal_finance_category:${pfc.detailed}`, supportingSignal);
    }
  }

  if (transactionCode === 'bill payment') {
    return result(PAYMENT_TYPES.billPayment, 'high', 'transaction_code:bill_payment');
  }
  if (/\bBILL\s*PAY(?:MENT)?\b/i.test(rawDescription)) {
    const signals = ['description:bill_pay'];
    if (clean(tx.payment_meta?.payee) && !hasMerchantCounterparty(tx)) {
      signals.push('payment_meta.payee', 'counterparty:no_merchant');
      return result(PAYMENT_TYPES.billPayment, 'medium-high', ...signals);
    }
    return result(PAYMENT_TYPES.billPayment, 'medium', ...signals);
  }

  if (transactionCode === 'transfer') {
    return result(PAYMENT_TYPES.accountTransfer, 'medium-high', 'transaction_code:transfer');
  }
  if (pfc && ACCOUNT_TRANSFER_CATEGORIES.has(pfc.detailed)) {
    return result(
      PAYMENT_TYPES.accountTransfer,
      hasHighConfidencePfc(tx) ? 'medium-high' : 'medium',
      `personal_finance_category:${pfc.detailed}`,
    );
  }

  if (transactionCode === 'purchase') {
    return result(PAYMENT_TYPES.card, 'medium-high', 'transaction_code:purchase');
  }
  if (['online', 'in store'].includes(normalize(tx.payment_channel)) && hasMerchantCounterparty(tx)) {
    return result(
      PAYMENT_TYPES.card,
      'medium-high',
      `payment_channel:${normalize(tx.payment_channel)}`,
      'counterparty:merchant',
    );
  }
  if (/\b(?:(?:debit|credit)\s+card|card\s+(?:purchase|payment)|pos)\b/i.test(rawDescription)) {
    return result(PAYMENT_TYPES.card, 'medium', 'description:card');
  }

  return result(PAYMENT_TYPES.unknown, 'none');
}

const confidenceRank: Record<string, number> = {
  VERY_HIGH: 5,
  HIGH: 4,
  MEDIUM: 3,
  LOW: 2,
  UNKNOWN: 1,
};

const bestCounterpartyName = (tx: Transaction, preferredTypes: string[]): string | undefined =>
  tx.counterparties
    ?.filter((counterparty) => preferredTypes.includes(counterparty.type) && clean(counterparty.name))
    .toSorted(
      (left, right) =>
        (confidenceRank[right.confidence_level?.toUpperCase() ?? ''] ?? 0) -
        (confidenceRank[left.confidence_level?.toUpperCase() ?? ''] ?? 0),
    )
    .map((counterparty) => clean(counterparty.name))
    .find((name): name is string => Boolean(name));

/** Selects the counterparty from the user's perspective, not the transfer's payee perspective. */
export function inferPlaidPayeeName(tx: Transaction): string | undefined {
  if (tx.amount < 0) {
    return (
      clean(tx.payment_meta?.payer) ||
      bestCounterpartyName(tx, ['income_source']) ||
      clean(tx.merchant_name) ||
      bestCounterpartyName(tx, ['payment_app', 'merchant', 'marketplace', 'payment_terminal']) ||
      bestCounterpartyName(tx, ['financial_institution']) ||
      clean(tx.name)
    );
  }

  return (
    clean(tx.merchant_name) ||
    clean(tx.payment_meta?.payee) ||
    bestCounterpartyName(tx, ['merchant', 'marketplace', 'payment_terminal', 'payment_app']) ||
    bestCounterpartyName(tx, ['financial_institution', 'income_source']) ||
    clean(tx.name)
  );
}

/** Converts Plaid's outflow-positive convention to the provider contract's income-positive convention. */
export function mapPlaidTransaction(tx: Transaction): MappedPlaidTransaction {
  const amount = Money.fromDecimal(-tx.amount).toCents();
  const payeeName = inferPlaidPayeeName(tx);
  const paymentTypeInference = inferPlaidPaymentType(tx);

  return {
    externalId: tx.transaction_id,
    amount,
    currency: tx.iso_currency_code || tx.unofficial_currency_code || 'XXX',
    date: new Date(`${tx.authorized_date || tx.date}T12:00:00Z`),
    description: clean(tx.merchant_name) || clean(tx.name) || tx.transaction_id,
    merchantName: payeeName,
    payeeName,
    paymentType: paymentTypeInference.paymentType,
    transactionType: tx.amount < 0 ? TRANSACTION_TYPES.income : TRANSACTION_TYPES.expense,
    metadata: {
      plaidTransactionId: tx.transaction_id,
      pendingTransactionId: tx.pending_transaction_id,
      pending: tx.pending,
      authorizedDate: tx.authorized_date,
      postedDate: tx.date,
      category: tx.personal_finance_category,
      originalDescription: tx.original_description,
      payee: payeeName,
      paymentChannel: tx.payment_channel,
      paymentMeta: tx.payment_meta,
      transactionCode: tx.transaction_code,
      checkNumber: tx.check_number,
      counterparties: tx.counterparties,
      plaidPaymentTypeInference: paymentTypeInference,
    },
  };
}
