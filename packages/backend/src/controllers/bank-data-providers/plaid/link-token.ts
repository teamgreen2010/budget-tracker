import { BANK_PROVIDER_TYPE } from '@bt/shared/types';
import { recordId } from '@common/lib/zod/custom-types';
import { createController } from '@controllers/helpers/controller-factory';
import { PlaidProvider } from '@services/bank-data-providers/plaid';
import { bankProviderRegistry } from '@services/bank-data-providers/registry';
import { z } from 'zod';

export default createController(
  z.object({ body: z.object({ connectionId: recordId().optional() }) }),
  async ({ user, body }) => {
    const provider = bankProviderRegistry.get(BANK_PROVIDER_TYPE.PLAID) as unknown as PlaidProvider;
    const token = (await provider.createLinkToken({ userId: user.id, connectionId: body.connectionId })) as any;
    return { data: { linkToken: token.link_token, expiration: token.expiration } };
  },
);
