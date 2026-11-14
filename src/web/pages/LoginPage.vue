<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { errorMessage } from '@/lib/api.ts';
import { useSession } from '@/lib/session.ts';

const session = useSession();
const route = useRoute();
const router = useRouter();
const username = ref('');
const password = ref('');
const error = ref('');
const busy = ref(false);

async function submit() {
  busy.value = true;
  error.value = '';
  try {
    await session.login(username.value, password.value);
    const next =
      typeof route.query.next === 'string' && route.query.next.startsWith('/')
        ? route.query.next
        : '/transactions';
    await router.replace(next);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-dvh flex-col items-center px-5 pt-[14vh]">
    <div class="mb-6 flex items-center gap-2.5 text-[16px] font-semibold tracking-[-0.01em]">
      <img src="/favicon.svg" alt="" width="28" height="28" class="size-7" />
      Mintless
    </div>
    <form
      class="w-full max-w-[22rem] space-y-4 rounded-lg border bg-card px-6 pt-5 pb-6 shadow-[0_1px_2px_rgb(0_0_0/0.04)]"
      @submit.prevent="submit"
    >
      <div class="border-b pb-3">
        <h1 class="text-[17px] font-semibold tracking-[-0.015em]">Sign in</h1>
        <p class="text-[13px] text-muted-foreground">to your household ledger.</p>
      </div>
      <div class="space-y-1.5">
        <Label for="username">Username</Label>
        <Input
          id="username"
          v-model="username"
          autocomplete="username"
          autocapitalize="none"
          required
          class="h-10"
        />
      </div>
      <div class="space-y-1.5">
        <Label for="password">Password</Label>
        <Input
          id="password"
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
          class="h-10"
        />
      </div>
      <p v-if="error" role="alert" class="text-[13px] text-destructive">{{ error }}</p>
      <Button type="submit" class="h-10 w-full" :disabled="busy">{{
        busy ? 'Signing in…' : 'Sign in'
      }}</Button>
    </form>
  </div>
</template>
