import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { api } from '../services/api';

export const useAi = defineStore('ai', () => {
  const configured = ref(false);
  const ready = ref(false);
  let timer: ReturnType<typeof setInterval> | null = null;

  const downloading = computed(() => configured.value && !ready.value);

  async function refresh(): Promise<void> {
    try {
      const s = await api.aiStatus();
      configured.value = s.configured;
      ready.value = s.ready;
      if (!s.configured || s.ready) stop();
    } catch {
      /* transient error — keep polling, treat as not-ready */
    }
  }

  function start(): void {
    if (timer) return;
    void refresh();
    timer = setInterval(() => { void refresh(); }, 5000);
  }

  function stop(): void {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { configured, ready, downloading, start, stop };
});
