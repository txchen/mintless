import { createRouter, createWebHistory } from 'vue-router';
import { resetAccounts } from './composables/useAccounts.ts';
import { setForbiddenHandler, setUnauthenticatedHandler } from './lib/api.ts';
import { useSession } from './lib/session.ts';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: () => import('./pages/LoginPage.vue'), meta: { public: true } },
    { path: '/', redirect: '/transactions' },
    {
      path: '/transactions',
      component: () => import('./pages/TransactionsPage.vue'),
      children: [{ path: ':id', component: () => import('./pages/TransactionEditor.vue'), props: true }],
    },
    { path: '/overview', component: () => import('./pages/OverviewPage.vue') },
    { path: '/review', component: () => import('./pages/ReviewPage.vue') },
    { path: '/accounts', component: () => import('./pages/AccountsPage.vue') },
    { path: '/settings', component: () => import('./pages/SettingsPage.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/transactions' },
  ],
  scrollBehavior: (_to, _from, saved) => saved ?? undefined,
});

const session = useSession();

router.beforeEach(async (to) => {
  if (!session.loaded.value) await session.load();
  if (!to.meta.public && !session.user.value)
    return { path: '/login', query: to.fullPath === '/' ? {} : { next: to.fullPath } };
  if (to.path === '/login' && session.user.value) return '/transactions';
});

setUnauthenticatedHandler(() => {
  session.clear();
  const current = router.currentRoute.value;
  if (!current.meta.public) void router.replace({ path: '/login', query: { next: current.fullPath } });
});

setForbiddenHandler(() => {
  resetAccounts();
  void session.load();
});
