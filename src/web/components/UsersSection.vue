<script setup lang="ts">
import { computed, ref } from 'vue';
import { toast } from 'vue-sonner';
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
import { api, errorMessage } from '@/lib/api.ts';
import { useSession } from '@/lib/session.ts';
import type { GroupSummary, Role, UserSummary } from '../../shared/contracts.ts';

const props = defineProps<{ users: UserSummary[]; groups: GroupSummary[] }>();
const emit = defineEmits<{ changed: [] }>();
const { user: me } = useSession();

const editing = ref<UserSummary | null>(null);
const form = ref({ role: 'member' as Role, enabled: true, groupIds: [] as string[], password: '' });
const saving = ref(false);
const formError = ref('');

const newUser = ref({ username: '', password: '' });
const creating = ref(false);

const shareable = computed(() => props.groups.filter((g) => !g.protected));
const isSelf = computed(() => editing.value?.id === me.value?.id);
const promotionBlocked = computed(() => editing.value?.role === 'member' && !editing.value.passwordFromCli);

function access(u: UserSummary) {
  if (u.role === 'admin') return 'All groups';
  const names = props.groups.filter((g) => u.groupIds.includes(g.id)).map((g) => g.name);
  return names.length ? names.join(', ') : 'No groups yet';
}

function open(u: UserSummary) {
  editing.value = u;
  form.value = { role: u.role, enabled: !u.disabled, groupIds: [...u.groupIds], password: '' };
  formError.value = '';
}

function toggleGroup(id: string, on: boolean) {
  const set = new Set(form.value.groupIds);
  if (on) set.add(id);
  else set.delete(id);
  form.value.groupIds = [...set];
}

async function save() {
  const u = editing.value;
  if (!u) return;
  const body: Record<string, unknown> = {};
  if (form.value.role !== u.role) body.role = form.value.role;
  if (form.value.enabled === u.disabled) body.disabled = !form.value.enabled;
  if (form.value.role === 'member') {
    const before = [...u.groupIds].sort().join();
    if ([...form.value.groupIds].sort().join() !== before) body.groupIds = form.value.groupIds;
    if (form.value.password) body.password = form.value.password;
  }
  if (!Object.keys(body).length) {
    editing.value = null;
    return;
  }
  saving.value = true;
  formError.value = '';
  try {
    await api(`/admin/users/${u.id}`, { method: 'PATCH', body });
    toast.success(`Saved ${u.username}`);
    editing.value = null;
    emit('changed');
  } catch (e) {
    formError.value = errorMessage(e);
  } finally {
    saving.value = false;
  }
}

async function create() {
  creating.value = true;
  try {
    await api('/admin/users', { method: 'POST', body: { ...newUser.value, role: 'member' } });
    toast.success(`Created ${newUser.value.username}`);
    newUser.value = { username: '', password: '' };
    emit('changed');
  } catch (e) {
    toast.error(errorMessage(e));
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <section aria-labelledby="users">
    <h2 id="users" class="mb-1 border-b pb-1.5 text-[14px] font-semibold tracking-[-0.01em]">Users</h2>
    <p class="text-[13px] text-muted-foreground">
      Admins see every account. Members view and bookkeep every account in their groups.
    </p>
    <ul class="mt-2 divide-y rounded-md border">
      <li
        v-for="u in props.users"
        :key="u.id"
        class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px]"
      >
        <div class="min-w-0 flex-1 basis-40">
          <span class="font-medium [overflow-wrap:anywhere]">{{ u.username }}</span>
          <span v-if="u.id === me?.id" class="text-muted-foreground"> (you)</span>
          <div class="text-[12px] text-muted-foreground">
            {{ u.role === 'admin' ? 'Admin' : 'Member' }} · {{ access(u) }}
          </div>
        </div>
        <span
          class="rounded px-1.5 text-[12px] leading-5"
          :class="
            u.disabled ? 'bg-warning-surface text-warning-foreground' : 'bg-secondary text-muted-foreground'
          "
          >{{ u.disabled ? 'Disabled' : 'Active' }}</span
        >
        <Button size="sm" variant="outline" :aria-label="`Manage ${u.username}`" @click="open(u)"
          >Manage</Button
        >
      </li>
    </ul>

    <form class="mt-2 flex flex-wrap gap-2" @submit.prevent="create">
      <Input
        v-model="newUser.username"
        placeholder="username"
        aria-label="New member username"
        autocapitalize="none"
        class="h-9 w-36"
        required
      />
      <Input
        v-model="newUser.password"
        type="password"
        autocomplete="new-password"
        placeholder="Initial password"
        aria-label="Initial password"
        class="h-9 w-44"
        minlength="10"
        required
      />
      <Button type="submit" size="sm" class="h-9" :disabled="creating">Add member</Button>
    </form>
    <p class="mt-1 text-[12px] text-muted-foreground">
      Admins are added and recovered on the server with the <code>user:create</code> and
      <code>user:password</code> commands. See “Recover an admin password” in the deployment guide.
    </p>

    <Dialog :open="editing !== null" @update:open="(o) => !o && (editing = null)">
      <DialogContent
        v-if="editing"
        class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md [&>*]:min-w-0"
      >
        <DialogHeader class="text-left">
          <DialogTitle>Manage {{ editing.username }}</DialogTitle>
          <DialogDescription
            >Changes apply when you save. Role or status changes sign the user out.</DialogDescription
          >
        </DialogHeader>
        <form id="manage-user" class="grid min-w-0 grid-cols-1 gap-4 text-[13px]" @submit.prevent="save">
          <fieldset class="grid min-w-0 grid-cols-1 gap-1.5">
            <legend class="mb-1 text-[12px] font-medium text-muted-foreground">Role</legend>
            <label
              class="flex gap-2.5 rounded-md border px-3 py-2 has-[:checked]:border-primary has-[:disabled]:opacity-60"
            >
              <input
                v-model="form.role"
                type="radio"
                value="member"
                class="mt-0.5 accent-[var(--primary)]"
                :disabled="isSelf"
              />
              <span
                ><span class="font-medium">Member</span><br /><span class="text-muted-foreground"
                  >Views and bookkeeps every account in the groups below.</span
                ></span
              >
            </label>
            <label
              class="flex gap-2.5 rounded-md border px-3 py-2 has-[:checked]:border-primary has-[:disabled]:opacity-60"
            >
              <input
                v-model="form.role"
                type="radio"
                value="admin"
                class="mt-0.5 accent-[var(--primary)]"
                :disabled="isSelf || promotionBlocked"
              />
              <span
                ><span class="font-medium">Admin</span><br /><span class="text-muted-foreground"
                  >Sees every account and manages connections, users, and settings.</span
                ></span
              >
            </label>
            <p v-if="isSelf" class="text-[12px] text-muted-foreground">
              You cannot change your own role or disable yourself.
            </p>
            <p v-else-if="promotionBlocked" class="text-[12px] text-muted-foreground">
              To make {{ editing.username }} an admin, first set their password on the server with
              <code>user:password</code>. Admin passwords never come from the browser.
            </p>
          </fieldset>

          <fieldset v-if="form.role === 'member'" class="grid min-w-0 grid-cols-1 gap-1">
            <legend class="mb-1 text-[12px] font-medium text-muted-foreground">
              Groups · {{ form.groupIds.length }}
            </legend>
            <p v-if="!shareable.length" class="text-muted-foreground">
              No groups yet. Create one on the Accounts page.
            </p>
            <label
              v-for="g in shareable"
              :key="g.id"
              class="flex min-h-9 items-center gap-2.5 rounded px-1 hover:bg-secondary"
            >
              <Checkbox
                :model-value="form.groupIds.includes(g.id)"
                @update:model-value="toggleGroup(g.id, $event === true)"
              />
              <span class="min-w-0 flex-1 [overflow-wrap:anywhere]">{{ g.name }}</span>
              <span class="text-[12px] text-muted-foreground"
                >{{ g.accountCount }} {{ g.accountCount === 1 ? 'account' : 'accounts' }}</span
              >
            </label>
          </fieldset>
          <p v-else class="rounded-md bg-secondary px-3 py-2 text-muted-foreground">
            Admins can see and bookkeep all accounts.
          </p>

          <label class="flex items-start gap-2.5">
            <Checkbox v-model="form.enabled" :disabled="isSelf" class="mt-0.5" />
            <span
              ><span class="font-medium">Can sign in</span><br /><span class="text-muted-foreground"
                >Disabled users are signed out and cannot sign in. Their notes stay.</span
              ></span
            >
          </label>

          <label v-if="form.role === 'member' && editing.role === 'member'" class="grid gap-1.5">
            <span class="text-[12px] font-medium text-muted-foreground">New password (optional)</span>
            <Input
              v-model="form.password"
              type="password"
              autocomplete="new-password"
              minlength="10"
              placeholder="Leave blank to keep it"
              class="h-9"
            />
            <span class="text-[12px] text-muted-foreground"
              >Setting a password signs {{ editing.username }} out.</span
            >
          </label>
          <p v-else class="text-[12px] text-muted-foreground">
            Admin passwords are changed on the server with <code>user:password</code>, not here.
          </p>

          <p v-if="formError" role="alert" class="text-destructive">{{ formError }}</p>
        </form>
        <DialogFooter class="gap-2">
          <Button variant="outline" @click="editing = null">Cancel</Button>
          <Button type="submit" form="manage-user" :disabled="saving">{{
            saving ? 'Saving…' : 'Save'
          }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
</template>
