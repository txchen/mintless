<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import ScopeTree from '@/components/ScopeTree.vue';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import type { ScopeState } from '@/composables/useScope.ts';

const props = defineProps<{ state: Extract<ScopeState, { kind: 'unavailable' }> }>();
const route = useRoute();
const picker = ref(false);
const page = computed(() => (route.path.startsWith('/overview') ? '/overview' : '/transactions'));

const message = computed(() => {
  switch (props.state.reason) {
    case 'account':
      return 'This account is not available to you. It may have been removed, moved to a group you are not in, or the link may be wrong.';
    case 'group':
      return 'This group is not available to you. It may have been deleted, your access may have changed, or the link may be wrong.';
    case 'mismatch':
      return `${props.state.account?.displayName ?? 'This account'} is not in the group named in this link${props.state.home ? `; it belongs to ${props.state.home.name}` : ''}.`;
  }
  return '';
});
// Only explicit choices: open the account in its own group, pick another scope, or All accounts.
const homeLink = computed(() =>
  props.state.reason === 'mismatch' && props.state.account
    ? { path: page.value, query: { group: props.state.account.groupId, account: props.state.account.id } }
    : null,
);
</script>

<template>
  <section aria-labelledby="scope-unavailable" class="px-3 py-8 md:px-7">
    <h2 id="scope-unavailable" class="text-[15px] font-semibold">Nothing to show for this scope</h2>
    <p class="mt-1 max-w-prose text-[13px] text-muted-foreground" role="status">{{ message }}</p>
    <p class="mt-1 text-[13px] text-muted-foreground">
      No transactions or totals are shown until you choose a scope.
    </p>
    <div class="mt-4 flex flex-wrap gap-2">
      <Button v-if="homeLink" as-child size="sm">
        <RouterLink :to="homeLink"
          >Open {{ state.account?.displayName }}{{ state.home ? ` in ${state.home.name}` : '' }}</RouterLink
        >
      </Button>
      <Button size="sm" :variant="homeLink ? 'outline' : 'default'" @click="picker = true">
        Choose another {{ state.reason === 'group' ? 'group' : 'account' }}
      </Button>
      <Button as-child size="sm" variant="outline">
        <RouterLink :to="{ path: page }">All accounts</RouterLink>
      </Button>
    </div>
    <Drawer v-model:open="picker">
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Choose a scope</DrawerTitle>
          <DrawerDescription>Pick a group or account you can see.</DrawerDescription>
        </DrawerHeader>
        <div class="max-h-[60vh] overflow-y-auto px-3 pb-4">
          <ScopeTree tone="sheet" @navigate="picker = false" />
        </div>
      </DrawerContent>
    </Drawer>
  </section>
</template>
