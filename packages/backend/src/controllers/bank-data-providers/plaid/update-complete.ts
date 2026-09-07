import { BANK_PROVIDER_TYPE } from '@bt/shared/types';
import { recordId } from '@common/lib/zod/custom-types';
import { createController } from '@controllers/helpers/controller-factory';
import { NotFoundError } from '@js/errors';
import BankDataProviderConnections from '@models/bank-data-provider-connections.model';
import { PlaidProvider } from '@services/bank-data-providers/plaid';
import { bankProviderRegistry } from '@services/bank-data-providers/registry';
import { z } from 'zod';

export default createController(z.object({ body: z.object({ connectionId: recordId() }) }), async ({ user, body }) => {
  const provider = bankProviderRegistry.get(BANK_PROVIDER_TYPE.PLAID) as unknown as PlaidProvider;
  const connection = await BankDataProviderConnections.findOne({
    where: { id: body.connectionId, userId: user.id, providerType: BANK_PROVIDER_TYPE.PLAID },
  });
  if (!connection) throw new NotFoundError({ message: 'Plaid connection not found' });
  await provider.completeReauthorization(connection.id);
  return { data: { message: 'Plaid connection repaired' } };
});
