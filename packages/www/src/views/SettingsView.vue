<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useData } from '../stores/data';
import type { Filter } from '../services/api';

const data = useData();
const rows = ref<Filter[]>([]);
const error = ref('');
const saved = ref(false);
const busy = ref(false);
const reclassMsg = ref('');

onMounted(async () => {
  await data.loadFilters();
  rows.value = data.filters.map(f => ({ ...f }));
});

function addRow(): void { rows.value.push({ label: '', color: '#888888', emoji: '' }); }
function removeRow(i: number): void { rows.value.splice(i, 1); }

function validate(): string | null {
  if (rows.value.length < 1 || rows.value.length > 20) return '1 to 20 filters required';
  const seen = new Set<string>();
  for (const r of rows.value) {
    const label = r.label.trim();
    if (!label || label.length > 40) return 'each filter needs a label (max 40 chars)';
    if (seen.has(label.toLowerCase())) return `duplicate label: ${label}`;
    seen.add(label.toLowerCase());
    if (!/^#[0-9a-fA-F]{6}$/.test(r.color)) return `invalid color for "${label}"`;
    if (r.emoji.length > 8) return `emoji too long for "${label}"`;
  }
  return null;
}

async function save(): Promise<void> {
  error.value = ''; saved.value = false;
  const v = validate();
  if (v) { error.value = v; return; }
  busy.value = true;
  try {
    await data.saveFilters(rows.value.map(r => ({ label: r.label.trim(), color: r.color, emoji: r.emoji })));
    rows.value = data.filters.map(f => ({ ...f }));
    saved.value = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'save failed';
  } finally {
    busy.value = false;
  }
}

async function reclassify(): Promise<void> {
  reclassMsg.value = '';
  if (!confirm('Re-classify ALL stored posts with the current filters? This runs in the background.')) return;
  busy.value = true;
  try {
    const queued = await data.reclassifyAll();
    reclassMsg.value = `Queued ${queued} posts for re-classification.`;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'reclassify failed';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <h2 class="text-base font-semibold">Settings — AI filters</h2>
    <p class="text-xs text-gray-400">
      The AI keeps posts related to at least one filter below. New posts use these immediately;
      use "Re-classify all" to re-run posts already collected.
    </p>

    <div class="flex flex-col gap-2">
      <div v-for="(r, i) in rows" :key="i" class="flex items-center gap-2">
        <input v-model="r.emoji" maxlength="8" aria-label="Emoji" placeholder="🙂"
          class="w-12 text-center bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm" />
        <input v-model="r.label" maxlength="40" aria-label="Filter label" placeholder="label"
          class="flex-1 bg-gray-900 border border-gray-700 rounded px-3 py-1 text-sm" />
        <input v-model="r.color" type="color" aria-label="Color"
          class="w-10 h-8 bg-gray-900 border border-gray-700 rounded" />
        <button class="text-gray-400 hover:text-red-400 text-sm px-2" @click="removeRow(i)">✕</button>
      </div>
      <button class="self-start text-cyan-400 hover:text-cyan-300 text-sm" @click="addRow">+ add filter</button>
    </div>

    <p v-if="error" class="text-red-400 text-xs">{{ error }}</p>
    <p v-if="saved" class="text-green-400 text-xs">Saved.</p>

    <div class="flex gap-2">
      <button :disabled="busy" class="bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 rounded px-4 py-2 text-sm" @click="save">Save</button>
      <button :disabled="busy" class="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 rounded px-4 py-2 text-sm" @click="reclassify">Re-classify all posts</button>
    </div>
    <p v-if="reclassMsg" class="text-gray-300 text-xs">{{ reclassMsg }}</p>
  </div>
</template>
