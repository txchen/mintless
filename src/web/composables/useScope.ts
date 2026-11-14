import { computed } from 'vue';
import { useRoute } from 'vue-router';
import type { AccountSummary, GroupSummary } from '../../shared/contracts.ts';
import { useAccounts } from './useAccounts.ts';

/**
 * The scope requested by the URL (`group`, `account`), resolved against the
 * accounts and groups the user can see. A scope that cannot be resolved is
 * reported as `unavailable` and kept in the URL: it is never silently widened
 * to All accounts or swapped for another group. The server narrows the same
 * parameters, so requests for an unavailable scope return nothing.
 */
export type ScopeState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'all' }
  | { kind: 'group'; group: GroupSummary }
  | { kind: 'account'; account: AccountSummary; group: GroupSummary | null }
  | {
      kind: 'unavailable';
      reason: 'account' | 'group' | 'mismatch';
      /** For `mismatch`: the visible account and the group it actually belongs to. */
      account?: AccountSummary;
      home?: GroupSummary | null;
    };

const param = (v: unknown) => (typeof v === 'string' ? v : '');

export function useScope() {
  const route = useRoute();
  const { accounts, groups, loaded, failed } = useAccounts();
  const groupId = computed(() => param(route.query.group));
  const accountId = computed(() => param(route.query.account));

  const state = computed<ScopeState>(() => {
    if (!groupId.value && !accountId.value) return { kind: 'all' };
    if (!loaded.value) return failed.value ? { kind: 'error' } : { kind: 'loading' };
    const groupOf = (id: string) => groups.value.find((g) => g.id === id) ?? null;
    if (accountId.value) {
      const account = accounts.value.find((a) => a.id === accountId.value);
      if (!account) return { kind: 'unavailable', reason: 'account' };
      if (groupId.value && groupId.value !== account.groupId)
        return { kind: 'unavailable', reason: 'mismatch', account, home: groupOf(account.groupId) };
      return { kind: 'account', account, group: groupOf(account.groupId) };
    }
    const group = groupOf(groupId.value);
    return group ? { kind: 'group', group } : { kind: 'unavailable', reason: 'group' };
  });

  return { state, groupId, accountId };
}
