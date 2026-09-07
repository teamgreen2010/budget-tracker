<template>
  <PageWrapper
    ><PlaidConnector
      resume
      @connected="router.push({ name: ROUTES_NAMES.accounts })"
      @cancel="router.push({ name: ROUTES_NAMES.accounts })"
  /></PageWrapper>
</template>
<script lang="ts" setup>
import PageWrapper from '@/components/common/page-wrapper.vue';
import PlaidConnector from './components/plaid-connector.vue';
import { ROUTES_NAMES } from '@/routes/constants';
import { useRouter } from 'vue-router';
const router = useRouter();
</script>
