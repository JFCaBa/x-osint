import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../services/api';

export const useAuth = defineStore('auth', () => {
  const token = ref<string | null>(localStorage.getItem('x-osint-token'));
  if (token.value) api.setToken(token.value);

  async function login(password: string): Promise<void> {
    const t = await api.login(password);
    token.value = t;
    api.setToken(t);
    localStorage.setItem('x-osint-token', t);
  }
  function logout(): void {
    token.value = null;
    api.setToken(null);
    localStorage.removeItem('x-osint-token');
  }
  return { token, login, logout };
});
