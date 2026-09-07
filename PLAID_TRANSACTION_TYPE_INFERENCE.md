# Inferring Bank UI Transaction Types from Plaid Transactions

Plaid does not expose one universal field equivalent to a bank's UI transaction type. A practical implementation should use a confidence-based classifier that combines structured Plaid fields with transaction-description parsing.

This guide covers rules for inferring the following labels:

- Card
- Check
- Bill payment
- Account transfer
- Zelle credit
- ACH credit
- Loan payment

## Important Plaid conventions

For Plaid Transactions:

- `amount > 0` means money is leaving the account.
- `amount < 0` means money is entering the account.
- `transaction_code` is nullable and institution-dependent. Plaid documents it as being populated for European institutions and certain US institutions.
- `payment_channel` describes where a payment occurred (`online`, `in store`, or `other`); it does not identify the payment rail.
- `personal_finance_category` describes transaction intent, not necessarily how the money moved.
- `transaction_type` is deprecated and should not be used for new classification logic.

When possible, request `original_description` and retain it for institution-specific fallback rules.

## Suggested rules

| Desired type         | Suggested rule                                                                                                                                                                                                                          | Confidence                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Check**            | `check_number` is populated, or `transaction_code == "cheque"`. As a fallback, look for a check indicator and check number in the description.                                                                                          | High when a structured signal exists                                        |
| **Zelle credit**     | `amount < 0` and a `counterparties[]` entry has `type == "payment_app"` and identifies Zelle by normalized name or a known `entity_id`. As a fallback, require the standalone word `ZELLE` in `name` or `original_description`.         | Medium-high                                                                 |
| **ACH credit**       | `amount < 0` and `payment_meta.payment_method`, compared case-insensitively, equals `ACH`. As a fallback, require an explicit phrase such as `ACH CREDIT` in the raw description. A populated `ppd_id` can provide supporting evidence. | High with payment metadata; otherwise medium                                |
| **Loan payment**     | Normally `amount > 0` and a high-confidence `personal_finance_category.detailed` value identifies a loan payment. A recognized lender counterparty or loan-related description should strengthen the match.                             | Medium-high for transaction purpose                                         |
| **Bill payment**     | `transaction_code == "bill payment"`. As a fallback, require an explicit description such as `BILL PAY` or `BILLPAY`, preferably with `payment_meta.payee` populated and no merchant-like counterparty.                                 | High with the explicit code; otherwise medium or low                        |
| **Account transfer** | `transaction_code == "transfer"`, or PFC is `TRANSFER_IN_ACCOUNT_TRANSFER` or `TRANSFER_OUT_ACCOUNT_TRANSFER`, after excluding recognizable Zelle and loan transactions.                                                                | Medium-high for identifying a transfer; lower for proving account ownership |
| **Card**             | `transaction_code == "purchase"`, or `payment_channel` is `online` or `in store` and the transaction has a merchant counterparty or `merchant_name`. Card, POS, or debit-card wording strengthens the match.                            | Medium-high                                                                 |

## Relevant Personal Finance Categories

The following detailed PFC values indicate loan-payment intent:

```text
LOAN_PAYMENTS_CAR_PAYMENT
LOAN_PAYMENTS_MORTGAGE_PAYMENT
LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT
LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT
```

If the target bank UI treats credit-card payments as bill payments, also consider:

```text
LOAN_PAYMENTS_CREDIT_CARD_PAYMENT
```

Account-transfer intent is represented by:

```text
TRANSFER_IN_ACCOUNT_TRANSFER
TRANSFER_OUT_ACCOUNT_TRANSFER
```

PFC confidence should be considered alongside the category. Prefer `HIGH` or `VERY_HIGH` matches when a category drives the final classification.

## Suggested precedence

Because the labels mix payment rails, initiation methods, and transaction purposes, a transaction can satisfy more than one rule. One starting precedence is:

```text
Check
-> Zelle credit
-> ACH credit
-> Loan payment
-> explicit Bill payment
-> Account transfer
-> Card
-> Unknown
```

This ordering is a policy choice, not a Plaid guarantee. For example:

- A loan payment can travel over ACH.
- A utility bill can be paid by card.
- A Zelle transfer may be described by the institution as a generic transfer.
- A credit-card payment may appear as a bill payment, account transfer, or loan payment.

Tune precedence using transactions whose labels are already known from the target bank UI.

## Reliability limitations

### Zelle credit

Plaid has no dedicated Zelle transaction enum. Identification depends on counterparty enrichment or institution-provided text. A generic incoming transfer cannot safely be assumed to be Zelle.

### ACH credit

`payment_meta.payment_method` is optional and is not documented as a closed enum. When it is absent, a generic incoming transfer may be indistinguishable from an ACH credit.

Income-related PFC values, such as `INCOME_WAGES`, describe the purpose of the credit and do not prove that ACH was the rail.

### Bill payment

Without the explicit `transaction_code` or recognizable bank description, a bill payment can resemble an ACH debit, card purchase, or account transfer. A utility or insurance PFC alone is insufficient because those bills can be paid by several methods.

### Account transfer

A single transaction generally cannot prove that the source and destination accounts belong to the same user. Correlating an equal and opposite transaction across the user's linked accounts would improve confidence, but that is no longer inference from an individual transaction.

### Loan payment

PFC can identify likely loan-payment intent, but the institution may label the same movement as an account transfer, ACH payment, or bill payment. A recognized lender and explicit loan-related text improve confidence.

### Card

Card transactions are usually inferable when purchase, merchant, and channel signals align. However, `payment_channel` alone does not prove that a card was used; it describes the channel rather than the payment instrument.

### Check

This type has the strongest positive structured signal because `check_number` is only populated for check transactions. However, a missing check number does not prove that a transaction was not a check.

## Implementation recommendations

1. Normalize `transaction_code`, counterparty names, `payment_meta.payment_method`, and description text before matching.
2. Treat `amount` only as a direction signal, not as a type signal.
3. Give structured fields more weight than description parsing.
4. Use `personal_finance_category.confidence_level` and `counterparties[].confidence_level` when assigning confidence.
5. Maintain exact-word and known-entity allowlists for branded payment apps such as Zelle.
6. Preserve an `Unknown` result rather than forcing every transaction into one of the target labels.
7. Record the matched signals and classifier version with every decision so results can be explained and rules can be tuned.
8. Validate the classifier separately for each financial institution, since description formats and field availability differ.

## Plaid references

- [Transactions API](https://plaid.com/docs/api/products/transactions/)
- [Personal Finance Category migration guide](https://plaid.com/docs/transactions/pfc-migration/)
- [Personal Finance Category taxonomy](https://plaid.com/documents/pfc-taxonomy-all.csv)
