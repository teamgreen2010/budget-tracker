<template>
  <div class="space-y-4">
    <template v-if="!connected">
      <p class="text-muted-foreground text-sm">{{ t('pages.integrations.plaid.description') }}</p>
      <Callout v-if="error" variant="destructive">{{ error }}</Callout>
      <div class="flex justify-between gap-2">
        <UiButton variant="outline" @click="$emit('cancel')" :disabled="loading">{{
          t('pages.integrations.plaid.backButton')
        }}</UiButton>
        <UiButton @click="openLink" :disabled="loading || !ready" :loading="loading">{{
          t('pages.integrations.plaid.connectButton')
        }}</UiButton>
      </div>
    </template>
    <template v-else>
      <AccountSelectionList
        v-model="selectedIds"
        v-model:currency-overrides="currencyOverrides"
        :accounts="accounts"
        :provider-type="BANK_PROVIDER_TYPE.PLAID"
      />
      <div class="flex justify-between gap-2">
        <UiButton variant="outline" @click="$emit('cancel')">{{ t('pages.integrations.plaid.backButton') }}</UiButton>
        <UiButton @click="importAccounts" :disabled="selectedIds.length === 0 || loading" :loading="loading">{{
          t('pages.integrations.plaid.importButton', selectedIds.length)
        }}</UiButton>
      </div>
    </template>
  </div>
</template>

<script lang="ts" setup>
import {
  createPlaidLinkToken,
  connectProvider,
  getAvailableAccounts,
  syncSelectedAccounts,
  completePlaidReauthorization,
} from '@/api/bank-data-providers';
import AccountSelectionList from './account-selection-list.vue';
import UiButton from '@/components/lib/ui/button/Button.vue';
import { Callout } from '@/components/lib/ui/callout';
import { BANK_PROVIDER_TYPE } from '@bt/shared/types';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

const props = withDefaults(defineProps<{ resume?: boolean; connectionId?: string }>(), {
  resume: false,
  connectionId: undefined,
});
defineEmits<{ connected: []; cancel: [] }>();
const { t } = useI18n();
const loading = ref(false);
const ready = ref(false);
const connected = ref(false);
const error = ref('');
const connectionId = ref<string | undefined>(props.connectionId);
const accounts = ref<any[]>([]);
const selectedIds = ref<string[]>([]);
const currencyOverrides = ref<Record<string, string>>({});
let handler: any;
let script: HTMLScriptElement | undefined;

const loadScript = () =>
  new Promise<void>((resolve, reject) => {
    if ((window as any).Plaid) return resolve();
    script = document.createElement('script');
    script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Unable to load Plaid Link'));
    document.head.appendChild(script);
  });

const start = async () => {
  loading.value = true;
  try {
    await loadScript();
    const savedToken = sessionStorage.getItem('plaidLinkToken');
    const token =
      savedToken && props.resume ? { linkToken: savedToken } : await createPlaidLinkToken(connectionId.value);
    sessionStorage.setItem('plaidLinkToken', token.linkToken);
    handler = (window as any).Plaid.create({
      token: token.linkToken,
      ...(props.resume && { receivedRedirectUri: window.location.href }),
      onSuccess: async (publicToken: string, metadata: any) => {
        try {
          loading.value = true;
          if (props.resume && connectionId.value) {
            await completePlaidReauthorization(connectionId.value);
          } else {
            const result = await connectProvider(BANK_PROVIDER_TYPE.PLAID, {
              publicToken,
              institution: metadata?.institution,
            });
            connectionId.value = result.connectionId;
          }
          sessionStorage.removeItem('plaidLinkToken');
          accounts.value = await getAvailableAccounts(connectionId.value!);
          connected.value = true;
        } catch (e) {
          error.value = e instanceof Error ? e.message : t('pages.integrations.plaid.connectFailed');
        } finally {
          loading.value = false;
        }
      },
      onExit: (err: any) => {
        if (err?.error_message) error.value = err.error_message;
        loading.value = false;
      },
      onEvent: () => {
        ready.value = true;
      },
    });
    ready.value = true;
    if (props.resume) handler.open();
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('pages.integrations.plaid.connectFailed');
  } finally {
    loading.value = false;
  }
};

const openLink = () => handler?.open();
const importAccounts = async () => {
  if (!connectionId.value) return;
  loading.value = true;
  try {
    await syncSelectedAccounts(connectionId.value, selectedIds.value, currencyOverrides.value);
    location.reload();
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('pages.integrations.plaid.syncFailed');
  } finally {
    loading.value = false;
  }
};
onMounted(start);
onBeforeUnmount(() => {
  handler?.destroy?.();
  script?.remove();
});
</script>
