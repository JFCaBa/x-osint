import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api, type Account, type Post, type ReportParams, type ReportSummary } from '../services/api';

export const useData = defineStore('data', () => {
  const accounts = ref<Account[]>([]);
  const posts = ref<Post[]>([]);
  const loading = ref(false);
  const angleOnly = ref(false);
  const reportSummary = ref<ReportSummary | null>(null);

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
    try { posts.value = await api.listPosts({ ...params, angleOnly: angleOnly.value, limit: 200 }); }
    finally { loading.value = false; }
  }
  async function refresh(): Promise<void> { await api.triggerFetch(); }
  async function loadReportSummary(params: ReportParams): Promise<void> {
    reportSummary.value = await api.reportsSummary(params);
  }
  async function exportReport(params: ReportParams): Promise<void> {
    await api.exportReport(params);
  }

  return {
    accounts, posts, loading, angleOnly, reportSummary,
    loadAccounts, addAccount, toggle, remove, loadPosts, refresh,
    loadReportSummary, exportReport,
  };
});
