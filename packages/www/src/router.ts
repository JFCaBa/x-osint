import { createRouter, createWebHistory } from 'vue-router';
import { useAuth } from './stores/auth';
import LoginView from './views/LoginView.vue';
import FeedView from './views/FeedView.vue';
import AccountsView from './views/AccountsView.vue';
import ReportsView from './views/ReportsView.vue';
import SettingsView from './views/SettingsView.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: LoginView },
    { path: '/', component: FeedView },
    { path: '/accounts', component: AccountsView },
    { path: '/reports', component: ReportsView },
    { path: '/settings', component: SettingsView },
  ],
});

router.beforeEach((to) => {
  const auth = useAuth();
  if (to.path !== '/login' && !auth.token) return '/login';
  if (to.path === '/login' && auth.token) return '/';
  return true;
});

export default router;
