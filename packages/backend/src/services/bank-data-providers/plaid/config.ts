import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';

export type PlaidEnvironment = 'sandbox' | 'development' | 'production';

const environmentNames: Record<PlaidEnvironment, string> = {
  sandbox: PlaidEnvironments.sandbox as string,
  development: PlaidEnvironments.development as string,
  production: PlaidEnvironments.production as string,
};

export interface PlaidConfig {
  clientId: string;
  secret: string;
  environment: PlaidEnvironment;
  countryCodes: string[];
  redirectUri?: string;
  webhookUrl?: string;
  clientName: string;
}

export function getPlaidConfig(): PlaidConfig | null {
  const clientId = process.env.PLAID_CLIENT_ID?.trim();
  const secret = process.env.PLAID_SECRET?.trim();
  if (!clientId && !secret) return null;
  if (!clientId || !secret) throw new Error('PLAID_CLIENT_ID and PLAID_SECRET must be configured together');

  const environment = (process.env.PLAID_ENV?.trim() || 'sandbox') as PlaidEnvironment;
  if (!environmentNames[environment]) throw new Error(`Unsupported PLAID_ENV: ${environment}`);

  const countryCodes = (process.env.PLAID_COUNTRY_CODES || 'US,CA')
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean);
  if (countryCodes.length === 0) throw new Error('PLAID_COUNTRY_CODES must contain at least one country code');

  return {
    clientId,
    secret,
    environment,
    countryCodes,
    redirectUri: process.env.PLAID_REDIRECT_URI?.trim() || undefined,
    webhookUrl: process.env.PLAID_WEBHOOK_URL?.trim() || undefined,
    clientName: (process.env.PLAID_CLIENT_NAME?.trim() || 'MoneyMatter').slice(0, 30),
  };
}

export function createPlaidClient(config = getPlaidConfig()): PlaidApi {
  if (!config) throw new Error('Plaid is not configured');
  return new PlaidApi(
    new Configuration({
      basePath: environmentNames[config.environment],
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': config.clientId,
          'PLAID-SECRET': config.secret,
        },
        timeout: 30_000,
      },
    }),
  );
}
