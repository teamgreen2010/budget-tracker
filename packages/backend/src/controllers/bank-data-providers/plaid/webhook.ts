import { BANK_PROVIDER_TYPE } from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import { PlaidProvider } from '@services/bank-data-providers/plaid';
import { createPlaidClient } from '@services/bank-data-providers/plaid/config';
import { bankProviderRegistry } from '@services/bank-data-providers/registry';
import { createHash, timingSafeEqual } from 'crypto';
import { Request, Response } from 'express';
import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose';

export async function plaidWebhook(req: Request, res: Response): Promise<void> {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const token = req.header('Plaid-Verification');
  if (!rawBody || !token) {
    res.sendStatus(400);
    return;
  }
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== 'ES256' || typeof header.kid !== 'string') throw new Error('invalid Plaid JWT header');
    const keyResponse = await createPlaidClient().webhookVerificationKeyGet({ key_id: header.kid });
    const key = await importJWK(keyResponse.data.key as any, 'ES256');
    const verified = await jwtVerify(token, key, { algorithms: ['ES256'] });
    const iat = verified.payload.iat;
    if (typeof iat !== 'number' || Math.abs(Date.now() / 1000 - iat) > 300) throw new Error('stale Plaid webhook');
    const expected = String(verified.payload.request_body_sha256 || '');
    const actual = createHash('sha256').update(rawBody).digest('hex');
    if (expected.length !== actual.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(actual)))
      throw new Error('Plaid webhook body mismatch');
    const provider = bankProviderRegistry.get(BANK_PROVIDER_TYPE.PLAID) as unknown as PlaidProvider;
    await provider.handleWebhook(JSON.parse(rawBody.toString('utf8')));
    res.sendStatus(200);
  } catch (error) {
    logger.warn(`[Plaid] rejected webhook: ${error instanceof Error ? error.message : String(error)}`);
    res.sendStatus(400);
  }
}
