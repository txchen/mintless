<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { toast } from 'vue-sonner';
import Amount from '@/components/Amount.vue';
import GroupSelect from '@/components/GroupSelect.vue';
import NativeSelect from '@/components/NativeSelect.vue';
import PageHeader from '@/components/PageHeader.vue';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAccounts } from '@/composables/useAccounts.ts';
import { onRevalidate } from '@/composables/useRevalidate.ts';
import { ApiError, api, errorMessage } from '@/lib/api.ts';
import { formatMinor, formatRelative } from '@/lib/format.ts';
import { useSession } from '@/lib/session.ts';
import type { AccountSummary, GroupSummary, MoveImpact, UserSummary } from '../../shared/contracts.ts';

const { isAdmin } = useSession();
const route = useRoute();
const router = useRouter();
const { refresh: refreshShared } = useAccounts();
const accounts = ref<AccountSummary[]>([]);
const groups = ref<GroupSummary[]>([]);
const members = ref<UserSummary[]>([]);
const error = ref('');
const groupFilter = computed(() => (typeof route.query.group === 'string' ? route.query.group : ''));
let seq = 0;
const loadedOnce = ref(false);
// A group from the link that the user cannot see stays in the URL and is reported.
const groupMissing = computed(
  () => loadedOnce.value && !!groupFilter.value && !groups.value.some((g) => g.id === groupFilter.value),
);

async function load() {
  const mine = ++seq;
  try {
    const q = groupFilter.value ? `?group=${encodeURIComponent(groupFilter.value)}` : '';
    const [a, g, u] = await Promise.all([
      api<AccountSummary[]>(`/accounts${q}`),
      api<GroupSummary[]>('/groups'),
      isAdmin.value ? api<UserSummary[]>('/admin/users') : Promise.resolve([] as UserSummary[]),
    ]);
    if (mine !== seq) return;
    accounts.value = a;
    groups.value = g;
    members.value = u.filter((x) => x.role === 'member');
    error.value = '';
    loadedOnce.value = true;
  } catch (e) {
    if (mine === seq) error.value = errorMessage(e);
  }
}
onMounted(load);
onRevalidate(load);
watch(groupFilter, load);

function setGroup(id: string) {
  void router.replace({ query: { ...route.query, group: id || undefined } });
}
async function changed() {
  await load();
  void refreshShared();
}

const sections = computed(() =>
  groups.value
    .filter((g) => !groupFilter.value || g.id === groupFilter.value)
    .map((g) => ({ group: g, accounts: accounts.value.filter((a) => a.groupId === g.id) }))
    .filter((s) => isAdmin.value || s.accounts.length),
);
const memberName = (id: string) => members.value.find((m) => m.id === id)?.username ?? 'unknown';
const audience = (g: GroupSummary) =>
  g.protected
    ? 'Admins only'
    : g.memberIds?.length
      ? g.memberIds.map(memberName).join(', ')
      : 'No members yet';
const balanceLabel = (a: AccountSummary) => (a.kind === 'credit' ? 'Owed' : 'Current');

const renaming = ref<string | null>(null);
const accountName = ref('');
async function renameAccount(a: AccountSummary) {
  try {
    await api(`/admin/accounts/${a.id}`, { method: 'PATCH', body: { displayName: accountName.value } });
    renaming.value = null;
    await changed();
  } catch (e) {
    toast.error(errorMessage(e));
  }
}

const newGroup = ref('');
async function createGroup() {
  try {
    await api('/admin/groups', { method: 'POST', body: { name: newGroup.value } });
    toast.success(`Created ${newGroup.value}`);
    newGroup.value = '';
    await changed();
  } catch (e) {
    toast.error(errorMessage(e));
  }
}

const managing = ref<GroupSummary | null>(null);
const groupForm = ref({ name: '', memberIds: [] as string[] });
const groupError = ref('');
function openGroup(g: GroupSummary) {
  managing.value = g;
  groupForm.value = { name: g.name, memberIds: [...(g.memberIds ?? [])] };
  groupError.value = '';
}
function toggleMember(id: string, on: boolean) {
  const set = new Set(groupForm.value.memberIds);
  if (on) set.add(id);
  else set.delete(id);
  groupForm.value.memberIds = [...set];
}
async function saveGroup() {
  const g = managing.value!;
  try {
    if (groupForm.value.name.trim() !== g.name)
      await api(`/admin/groups/${g.id}`, { method: 'PATCH', body: { name: groupForm.value.name } });
    if (
      !g.protected &&
      [...groupForm.value.memberIds].sort().join() !== [...(g.memberIds ?? [])].sort().join()
    ) {
      await api(`/admin/groups/${g.id}/members`, {
        method: 'PUT',
        body: { userIds: groupForm.value.memberIds },
      });
    }
    managing.value = null;
    toast.success('Group saved');
    await changed();
  } catch (e) {
    groupError.value = errorMessage(e);
  }
}
async function deleteGroup(g: GroupSummary) {
  if (!window.confirm(`Delete the group ${g.name}? Members lose nothing else; the group has no accounts.`))
    return;
  try {
    await api(`/admin/groups/${g.id}`, { method: 'DELETE' });
    toast.success(`Deleted ${g.name}`);
    await changed();
  } catch (e) {
    toast.error(errorMessage(e));
  }
}

const moving = ref<AccountSummary | null>(null);
const target = ref('');
const impact = ref<MoveImpact | null>(null);
const moveError = ref('');
const moveBusy = ref(false);
function openMove(a: AccountSummary) {
  moving.value = a;
  target.value = '';
  impact.value = null;
  moveError.value = '';
}
const targetOptions = computed(() => [
  { value: '', label: 'Choose a group' },
  ...groups.value.filter((g) => g.id !== moving.value?.groupId).map((g) => ({ value: g.id, label: g.name })),
]);
watch(target, async (to) => {
  impact.value = null;
  moveError.value = '';
  if (!to || !moving.value) return;
  const account = moving.value.id;
  try {
    const result = await api<MoveImpact>(
      `/admin/accounts/${account}/move-impact?to=${encodeURIComponent(to)}`,
    );
    if (target.value === to && moving.value?.id === account) impact.value = result;
  } catch (e) {
    moveError.value = errorMessage(e);
  }
});
async function confirmMove() {
  const a = moving.value;
  if (!a || !impact.value) return;
  moveBusy.value = true;
  try {
    await api(`/admin/accounts/${a.id}/move`, {
      method: 'POST',
      body: { groupId: impact.value.to.id, fromGroupId: impact.value.from.id },
    });
    toast.success(`Moved ${a.displayName} to ${impact.value.to.name}`);
    moving.value = null;
    await changed();
  } catch (e) {
    moveError.value =
      e instanceof ApiError && e.code === 'account_moved'
        ? 'Someone moved this account already. Reload and check again.'
        : errorMessage(e);
  } finally {
    moveBusy.value = false;
  }
}
</script>

<template>
  <div class="mx-auto w-full max-w-[var(--content-max)]">
    <PageHeader title="Accounts">
      <GroupSelect
        :model-value="groupFilter"
        :groups="groups"
        variant="chip"
        @update:model-value="setGroup"
      />
    </PageHeader>
    <p v-if="error" role="alert" class="m-4 text-[13px] text-destructive">{{ error }}</p>
    <section v-else-if="groupMissing" aria-labelledby="group-missing" class="px-3 py-6 md:px-6">
      <h2 id="group-missing" class="text-[15px] font-semibold">Group unavailable</h2>
      <p class="mt-1 text-[13px] text-muted-foreground" role="status">
        The group in this link is not available to you. It may have been deleted, or your access may have
        changed.
      </p>
      <Button size="sm" class="mt-3" @click="setGroup('')">Show all groups</Button>
    </section>

    <section v-if="isAdmin" aria-labelledby="groups" class="max-w-5xl px-3 pt-5 md:px-6">
      <h2 id="groups" class="label-caps">Groups</h2>
      <p class="text-[13px] text-muted-foreground">
        Each account belongs to one group. Members see and bookkeep every account in their groups. New
        accounts start in Unassigned, which only admins see.
      </p>
      <ul class="mt-2 divide-y rounded-md border">
        <li
          v-for="g in groups"
          :key="g.id"
          class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px]"
        >
          <div class="min-w-0 flex-1 basis-48">
            <span class="font-medium [overflow-wrap:anywhere]">{{ g.name }}</span>
            <span
              v-if="g.protected"
              class="ml-1.5 rounded bg-secondary px-1 text-[11px] text-muted-foreground"
              >Protected</span
            >
            <div class="text-[12px] text-muted-foreground [overflow-wrap:anywhere]">
              {{ g.accountCount }} {{ g.accountCount === 1 ? 'account' : 'accounts' }} · {{ audience(g) }}
            </div>
          </div>
          <Button size="sm" variant="outline" :aria-label="`Manage ${g.name}`" @click="openGroup(g)"
            >Manage</Button
          >
          <Button
            v-if="!g.protected"
            size="sm"
            variant="ghost"
            :disabled="g.accountCount > 0"
            :title="g.accountCount > 0 ? 'Move its accounts to another group first' : undefined"
            :aria-label="`Delete ${g.name}`"
            @click="deleteGroup(g)"
            >Delete</Button
          >
        </li>
      </ul>
      <form class="mt-2 flex flex-wrap gap-2" @submit.prevent="createGroup">
        <Input
          v-model="newGroup"
          placeholder="New group name"
          aria-label="New group name"
          maxlength="60"
          class="h-9 w-52"
          required
        />
        <Button type="submit" size="sm" class="h-9">Add group</Button>
      </form>
    </section>

    <p
      v-if="!error && !groupMissing && !accounts.length && !isAdmin"
      class="p-6 text-[13px] text-muted-foreground"
    >
      No accounts are in your groups yet. Ask an administrator to add you to a group.
    </p>

    <section
      v-for="s in sections"
      :key="s.group.id"
      :aria-label="s.group.name"
      class="max-w-5xl px-3 pt-7 md:px-6"
    >
      <h2
        class="flex flex-wrap items-baseline gap-x-2 border-b pb-1.5 text-[14px] font-semibold tracking-[-0.01em]"
      >
        {{ s.group.name }}
        <span v-if="isAdmin" class="text-[12px] font-normal text-muted-foreground">{{
          audience(s.group)
        }}</span>
      </h2>
      <p v-if="!s.accounts.length" class="mt-1 text-[13px] text-muted-foreground">
        No accounts in this group.
      </p>
      <ul v-else class="divide-y divide-border/60">
        <li v-for="a in s.accounts" :key="a.id" class="flex flex-wrap items-center gap-x-4 gap-y-1.5 py-3">
          <div class="flex min-w-0 flex-1 basis-72 flex-wrap items-baseline gap-x-3 gap-y-1">
            <form v-if="renaming === a.id" class="flex flex-1 gap-2" @submit.prevent="renameAccount(a)">
              <Input v-model="accountName" aria-label="Account name" class="h-9 max-w-64" maxlength="80" />
              <Button size="sm" type="submit">Save</Button>
              <Button size="sm" variant="ghost" type="button" @click="renaming = null">Cancel</Button>
            </form>
            <div v-else class="min-w-0 flex-1 basis-56">
              <span class="text-[14px] font-medium [overflow-wrap:anywhere]">{{ a.displayName }}</span>
              <span v-if="a.mask" class="num text-muted-foreground"> ··{{ a.mask }}</span>
              <div class="text-[12px] text-muted-foreground">
                {{ a.institutionName ?? 'Unknown institution' }} · {{ a.kind }} · balance fetched
                {{ formatRelative(a.balanceFetchedAt) }}
              </div>
            </div>
            <div class="num text-right">
              <div class="label-caps">{{ balanceLabel(a) }} · cached</div>
              <div class="text-[15px] font-semibold">
                <span v-if="a.balanceCurrentMinor === null">—</span>
                <Amount v-else :minor="a.balanceCurrentMinor" :currency="a.currency" unsigned />
              </div>
            </div>
          </div>
          <div
            v-if="isAdmin && renaming !== a.id"
            class="flex shrink-0 gap-1"
            role="group"
            :aria-label="`Actions for ${a.displayName}`"
          >
            <Button size="xs" variant="outline" @click="((renaming = a.id), (accountName = a.displayName))"
              >Rename</Button
            >
            <Button
              size="xs"
              variant="outline"
              :aria-label="`Move ${a.displayName} to another group`"
              @click="openMove(a)"
              >Move to group…</Button
            >
          </div>
        </li>
      </ul>
    </section>

    <Dialog :open="managing !== null" @update:open="(o) => !o && (managing = null)">
      <DialogContent
        v-if="managing"
        class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md [&>*]:min-w-0"
      >
        <DialogHeader class="text-left">
          <DialogTitle>Manage {{ managing.name }}</DialogTitle>
          <DialogDescription
            >Members see and bookkeep all {{ managing.accountCount }} accounts in this group, including their
            history and notes.</DialogDescription
          >
        </DialogHeader>
        <form
          id="manage-group"
          class="grid min-w-0 grid-cols-1 gap-4 text-[13px]"
          @submit.prevent="saveGroup"
        >
          <label class="grid gap-1.5">
            <span class="text-[12px] font-medium text-muted-foreground">Name</span>
            <Input v-model="groupForm.name" maxlength="60" class="h-9" required />
          </label>
          <p v-if="managing.protected" class="rounded-md bg-secondary px-3 py-2 text-muted-foreground">
            Unassigned is admin-only. Move accounts into another group to share them.
          </p>
          <fieldset v-else class="grid min-w-0 grid-cols-1 gap-1">
            <legend class="mb-1 text-[12px] font-medium text-muted-foreground">
              Members · {{ groupForm.memberIds.length }}
            </legend>
            <p v-if="!members.length" class="text-muted-foreground">No members yet. Add one in Settings.</p>
            <label
              v-for="m in members"
              :key="m.id"
              class="flex min-h-9 items-center gap-2.5 rounded px-1 hover:bg-secondary"
            >
              <Checkbox
                :model-value="groupForm.memberIds.includes(m.id)"
                @update:model-value="toggleMember(m.id, $event === true)"
              />
              <span class="min-w-0 [overflow-wrap:anywhere]">{{ m.username }}</span>
              <span v-if="m.disabled" class="text-[12px] text-muted-foreground">disabled</span>
            </label>
            <p class="text-[12px] text-muted-foreground">
              Admins always see every group, so they are not listed.
            </p>
          </fieldset>
          <p v-if="groupError" role="alert" class="text-destructive">{{ groupError }}</p>
        </form>
        <DialogFooter class="gap-2">
          <Button variant="outline" @click="managing = null">Cancel</Button>
          <Button type="submit" form="manage-group">Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="moving !== null" @update:open="(o) => !o && (moving = null)">
      <DialogContent
        v-if="moving"
        class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md [&>*]:min-w-0"
      >
        <DialogHeader class="text-left">
          <DialogTitle>Move {{ moving.displayName }}</DialogTitle>
          <DialogDescription
            >It is in {{ moving.groupName }}. Its whole history and every note move with
            it.</DialogDescription
          >
        </DialogHeader>
        <div class="grid min-w-0 grid-cols-1 gap-3 text-[13px]">
          <label class="grid gap-1.5">
            <span class="text-[12px] font-medium text-muted-foreground">Move to</span>
            <NativeSelect
              v-model="target"
              label="Destination group"
              :options="targetOptions"
              class="[&_select]:h-9"
            />
          </label>
          <div v-if="impact" class="grid gap-1.5 rounded-md border px-3 py-2.5" role="status">
            <p>
              {{ impact.transactionCount }} transactions and {{ impact.annotationCount }} annotated
              transactions move to {{ impact.to.name }}.
            </p>
            <p v-if="impact.losesAccess.length">
              <span class="font-medium">Loses access:</span> {{ impact.losesAccess.join(', ') }}
            </p>
            <p v-if="impact.gainsAccess.length">
              <span class="font-medium">Gains access to all of its history:</span>
              {{ impact.gainsAccess.join(', ') }}
            </p>
            <p v-if="!impact.losesAccess.length && !impact.gainsAccess.length" class="text-muted-foreground">
              No member gains or loses access.
            </p>
            <p v-if="impact.to.id === 'unassigned'" class="text-muted-foreground">
              Afterward only admins can see it.
            </p>
          </div>
          <p v-if="moveError" role="alert" class="text-destructive">{{ moveError }}</p>
        </div>
        <DialogFooter class="gap-2">
          <Button variant="outline" @click="moving = null">Cancel</Button>
          <Button :disabled="!impact || moveBusy" @click="confirmMove">{{
            moveBusy ? 'Moving…' : 'Move account'
          }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
