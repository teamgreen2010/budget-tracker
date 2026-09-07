export interface PlaidCredentials {
  accessToken: string;
  itemId: string;
}

export interface PlaidMetadata {
  itemId: string;
  institutionId?: string;
  institutionName?: string;
  environment?: 'sandbox' | 'development' | 'production';
  provisioningSource?: 'link' | 'external';
  webhookUrl?: string;
  products?: string[];
  status?: 'active' | 'pending_disconnect' | 'login_required' | 'revoked';
  lastWebhookAt?: string;
  consecutiveAuthFailures?: number;
  deactivationReason?: string | null;
}

export interface PlaidExistingItemImportInput {
  userId: number;
  accessToken: string;
  expectedItemId?: string;
  connectionName?: string;
  updateWebhook?: boolean;
}

export interface PlaidExistingItemImportResult {
  connectionId: string;
  created: boolean;
  accountCount: number;
  institutionName?: string;
}
