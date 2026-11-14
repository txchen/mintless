<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { toast } from 'vue-sonner';
import PageHeader from '@/components/PageHeader.vue';
import ThemePicker from '@/components/ThemePicker.vue';
import UsersSection from '@/components/UsersSection.vue';
import { onRevalidate } from '@/composables/useRevalidate.ts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAccounts } from '@/composables/useAccounts.ts';
import { api, errorMessage } from '@/lib/api.ts';
import { formatRelative, formatStamp } from '@/lib/format.ts';
import { useSession } from '@/lib/session.ts';
import type {
  GroupSummary,
  ItemSummary,
  ProfileSummary,
  SyncRunSummary,
  UserSummary,
} from '../../shared/contracts.ts';

const session = useSession();
const { refresh: refreshShared } = useAccounts();
const users = ref<UserSummary[]>([]);
const groups = ref<GroupSummary[]>([]);
const items = ref<ItemSummary[]>([]);
const profiles = ref<ProfileSummary[]>([]);
const busy = ref<string | null>(null);

const pw = ref({ currentPassword: '', newPassword: '' });
const profileForm = ref({ name: '', clientId: '', secretRef: 'env:PLAID_SANDBOX_SECRET' });

async function load() {
  if (!session.isAdmin.value) return;
  try {
    [users.value, items.value, profiles.value, groups.value] = await Promise.all([
      api<UserSummary[]>('/admin/users'),
      api<ItemSummary[]>('/admin/items'),
      api<ProfileSummary[]>('/admin/profiles'),
      api<GroupSummary[]>('/groups'),
    ]);
  } catch (e) {
    toast.error(errorMessage(e));
  }
}
onMounted(load);
onRevalidate(load);

async function run(key: string, fn: () => Promise<unknown>, success: string) {
  busy.value = key;
  try {
    await fn();
    toast.success(success);
    await load();
    void refreshShared();
  } catch (e) {
    toast.error(errorMessage(e));
  } finally {
    busy.value = null;
  }
}

const changePassword = () =>
  run(
    'pw',
    () =>
      api('/session/password', { method: 'POST', body: pw.value }).then(
        () => (pw.value = { currentPassword: '', newPassword: '' }),
      ),
    'Password changed. Other sessions were signed out.',
  );
const syncNow = (item: ItemSummary) =>
  run(
    `s${item.id}`,
    async () => {
      const outcome = await api<{ status: string; errorCode?: string }>(`/admin/items/${item.id}/sync`, {
        method: 'POST',
      });
      if (outcome.status === 'failed') throw new Error(outcome.errorCode);
    },
    'Sync finished',
  );
const addDemo = (dataset: string) =>
  run(
    `d${dataset}`,
    () => api('/admin/demo-items', { method: 'POST', body: { dataset } }),
    'Demo connection added',
  );
const addProfile = () =>
  run(
    'profile',
    () => api('/admin/profiles', { method: 'POST', body: { ...profileForm.value, environment: 'sandbox' } }),
    'Sandbox profile saved',
  );
const addSandboxItem = (p: ProfileSummary) =>
  run(
    `p${p.id}`,
    () => api(`/admin/profiles/${p.id}/sandbox-items`, { method: 'POST' }),
    'Sandbox item created',
  );

async function logout() {
  await session.logout();
  window.location.assign('/login');
}
const runText = (r: SyncRunSummary) =>
  r.status === 'succeeded' && r.counts
    ? `+${r.counts.added ?? 0} new, ${r.counts.modified ?? 0} changed, ${r.counts.removed ?? 0} removed${r.balanceErrorCode ? `; balances failed (${r.balanceErrorCode})` : ''}`
    : `${r.status}${r.errorCode ? ` (${r.errorCode})` : ''}`;
</script>

<template>
  <div class="mx-auto w-full max-w-[var(--content-max)]">
    <PageHeader title="Settings">
      <Button variant="ghost" size="sm" @click="logout">Sign out</Button>
    </PageHeader>
    <div class="grid max-w-3xl gap-10 px-3 py-5 md:px-6">
      <ThemePicker />

      <section aria-labelledby="me">
        <h2 id="me" class="mb-1 border-b pb-1.5 text-[14px] font-semibold tracking-[-0.01em]">
          Your account
        </h2>
        <p class="text-[13px] text-muted-foreground">
          Signed in as {{ session.user.value?.username }} ({{ session.user.value?.role }}).
        </p>
        <template v-if="session.isAdmin.value">
          <p class="mt-1 text-[13px] text-muted-foreground">
            Your password is managed on the server with the <code>user:password</code> command, so a forgotten
            password never locks you out of the browser.
          </p>
        </template>
        <form v-else class="mt-2 flex flex-wrap gap-2" @submit.prevent="changePassword">
          <Input
            v-model="pw.currentPassword"
            type="password"
            autocomplete="current-password"
            placeholder="Current password"
            aria-label="Current password"
            class="h-9 w-48"
            required
          />
          <Input
            v-model="pw.newPassword"
            type="password"
            autocomplete="new-password"
            placeholder="New password"
            aria-label="New password"
            class="h-9 w-48"
            minlength="10"
            required
          />
          <Button type="submit" size="sm" class="h-9" :disabled="busy === 'pw'">Change password</Button>
        </form>
      </section>

      <template v-if="session.isAdmin.value">
        <section aria-labelledby="connections">
          <h2 id="connections" class="mb-1 border-b pb-1.5 text-[14px] font-semibold tracking-[-0.01em]">
            Bank connections
          </h2>
          <p class="text-[13px] text-muted-foreground">
            Syncs run automatically on the configured interval. Sync now fetches the latest changes the bank
            has published.
          </p>
          <ul class="mt-2 divide-y rounded-md border">
            <li v-for="item in items" :key="item.id" class="px-3 py-2.5">
              <div class="flex flex-wrap items-center gap-2">
                <div class="min-w-0 flex-1">
                  <div class="text-[14px] font-medium">
                    {{ item.institutionName ?? 'Pending connection' }}
                  </div>
                  <div class="text-[12px] text-muted-foreground">
                    {{ item.profileName }} · {{ item.environment }} ·
                    {{ item.accountNames.join(', ') || 'no accounts yet' }}
                  </div>
                </div>
                <span v-if="item.status !== 'active'" class="rounded bg-warning-surface px-1.5 text-[12px]">{{
                  item.status === 'login_required' ? 'Needs reauthorization' : 'Error'
                }}</span>
                <Button
                  size="sm"
                  variant="outline"
                  :disabled="busy === `s${item.id}` || item.syncing"
                  @click="syncNow(item)"
                >
                  {{ busy === `s${item.id}` || item.syncing ? 'Syncing…' : 'Sync now' }}
                </Button>
              </div>
              <div class="mt-1 text-[12px] text-muted-foreground">
                Last sync {{ formatRelative(item.lastSyncAt) }} · balances
                {{ formatRelative(item.lastBalanceAt) }}
                <template v-if="item.lastErrorCode"> · last error {{ item.lastErrorCode }}</template>
              </div>
              <details v-if="item.recentRuns.length" class="mt-1 text-[12px]">
                <summary class="cursor-pointer text-muted-foreground">Recent runs</summary>
                <ul class="mt-1 space-y-0.5">
                  <li v-for="r in item.recentRuns" :key="r.id">
                    {{ formatStamp(r.startedAt) }} · {{ r.trigger }} · {{ runText(r)
                    }}<template v-if="r.attempts > 1"> · {{ r.attempts }} attempts</template>
                  </li>
                </ul>
              </details>
            </li>
            <li v-if="!items.length" class="px-3 py-3 text-[13px] text-muted-foreground">
              No connections yet.
            </li>
          </ul>
          <div class="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" :disabled="busy !== null" @click="addDemo('household-bank')"
              >Add demo bank</Button
            >
            <Button size="sm" variant="outline" :disabled="busy !== null" @click="addDemo('household-card')"
              >Add demo card</Button
            >
          </div>
          <p class="mt-1 text-[12px] text-muted-foreground">
            Demo connections use synthetic data. Each sync advances a scripted story: pending charges post,
            one is canceled, a refund arrives, and an amount is corrected.
          </p>
        </section>

        <section aria-labelledby="sandbox">
          <h2 id="sandbox" class="mb-1 border-b pb-1.5 text-[14px] font-semibold tracking-[-0.01em]">
            Plaid Sandbox profiles
          </h2>
          <p class="text-[13px] text-muted-foreground">
            Sandbox only. The secret stays outside the database; enter a reference such as env:NAME or
            file:/run/secrets/name.
          </p>
          <ul
            v-if="profiles.filter((p) => p.environment === 'sandbox').length"
            class="mt-2 divide-y rounded-md border"
          >
            <li
              v-for="p in profiles.filter((x) => x.environment === 'sandbox')"
              :key="p.id"
              class="flex items-center gap-2 px-3 py-2 text-[13px]"
            >
              <span class="flex-1">{{ p.name }}</span>
              <Button size="sm" variant="outline" :disabled="busy !== null" @click="addSandboxItem(p)"
                >Create Sandbox item</Button
              >
            </li>
          </ul>
          <form class="mt-2 flex flex-wrap gap-2" @submit.prevent="addProfile">
            <Input
              v-model="profileForm.name"
              placeholder="Profile name"
              aria-label="Profile name"
              class="h-9 w-40"
              required
            />
            <Input
              v-model="profileForm.clientId"
              placeholder="client_id"
              aria-label="Plaid client id"
              class="h-9 w-48"
              required
            />
            <Input
              v-model="profileForm.secretRef"
              placeholder="env:PLAID_SANDBOX_SECRET"
              aria-label="Secret reference"
              class="h-9 w-56"
              required
            />
            <Button type="submit" size="sm" class="h-9" :disabled="busy === 'profile'">Add profile</Button>
          </form>
        </section>

        <UsersSection :users="users" :groups="groups" @changed="load" />
      </template>
    </div>
  </div>
</template>
