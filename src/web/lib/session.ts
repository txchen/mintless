import { computed, ref } from 'vue';
import type { SessionUser } from '../../shared/contracts.ts';
import { resetAccounts } from '../composables/useAccounts.ts';
import { api, fetchSession, setCsrfToken } from './api.ts';

const user = ref<SessionUser | null>(null);
const loaded = ref(false);

export function useSession() {
  return {
    user,
    loaded,
    isAdmin: computed(() => user.value?.role === 'admin'),
    async load() {
      try {
        const info = await fetchSession();
        user.value = info.user;
        setCsrfToken(info.csrfToken);
      } catch {
        user.value = null;
        setCsrfToken(null);
      } finally {
        loaded.value = true;
      }
    },
    async login(username: string, password: string) {
      const info = await api<{ user: SessionUser; csrfToken: string }>('/session', {
        method: 'POST',
        body: { username, password },
      });
      user.value = info.user;
      resetAccounts();
      setCsrfToken(info.csrfToken);
    },
    async logout() {
      await api('/session', { method: 'DELETE' }).catch(() => {});
      user.value = null;
      setCsrfToken(null);
      resetAccounts();
    },
    clear() {
      user.value = null;
      setCsrfToken(null);
      resetAccounts();
    },
  };
}
