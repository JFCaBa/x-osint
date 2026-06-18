import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api, type Account, type Post } from '../services/api';

export const useData = defineStore('data', () => {
  const accounts = ref<Account[]>([]);
  const posts = ref<Post[]>([]);
  const loading = ref(false);

  async function loadAccounts(): Promise<void> { accounts.value = await api.listAccounts(); }
  async function addAccount(handle: string): Promise<void> {
    await api.addAccount(handle);
    await loadAccounts();
  }
  async function toggle(handle: string, enabled: boolean): Promise<void> {
    await api.setEnabled(handle, enabled);
    await loadAccounts();
  }
  async function remove(handle: string): Promise<void> {
    await api.removeAccount(handle);
    await loadAccounts();
  }
  async function loadPosts(params: { handle?: string; q?: string } = {}): Promise<void> {
    loading.value = true;
    try { posts.value = await api.listPosts({ ...params, limit: 200 }); }
    finally { loading.value = false; }
  }
  async function refresh(): Promise<void> { await api.triggerFetch(); }

  return { accounts, posts, loading, loadAccounts, addAccount, toggle, remove, loadPosts, refresh };
});
