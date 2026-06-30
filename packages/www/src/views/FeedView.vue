<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useData } from '../stores/data';
import { badgeStyle } from '../services/badges';
import type { Post, Filter } from '../services/api';

const data = useData();
const search = ref('');
const handleFilter = ref('');

const filterByLabel = computed(() => {
  const m = new Map<string, Filter>();
  for (const f of data.filters) m.set(f.label.toLowerCase(), f);
  return m;
});
function angleLabels(p: Post): string[] {
  return p.angles ? p.angles.split(',').filter(Boolean) : [];
}
function filterFor(label: string): Filter | undefined {
  return filterByLabel.value.get(label.toLowerCase());
}

onMounted(() => { data.loadAccounts(); data.loadPosts(); data.loadFilters(); });

function applyFilters(): void {
  data.loadPosts({ q: search.value || undefined, handle: handleFilter.value || undefined });
}
async function refresh(): Promise<void> {
  await data.refresh();
  setTimeout(applyFilters, 1500); // give the poll a moment, then reload
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex gap-2 items-center">
      <input v-model="search" placeholder="Search text" @keyup.enter="applyFilters"
        class="flex-1 bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm" />
      <select v-model="handleFilter" @change="applyFilters"
        class="bg-gray-900 border border-gray-700 rounded px-2 py-2 text-sm">
        <option value="">All accounts</option>
        <option v-for="a in data.accounts" :key="a.handle" :value="a.handle">@{{ a.handle }}</option>
      </select>
      <label class="flex items-center gap-1 text-xs text-gray-400 whitespace-nowrap">
        <input type="checkbox" v-model="data.angleOnly" @change="applyFilters" />
        Money/business only
      </label>
      <button class="bg-cyan-600 hover:bg-cyan-500 rounded px-3 py-2 text-sm" @click="refresh">Refresh</button>
    </div>

    <p v-if="data.loading" class="text-gray-500 text-sm">Loading…</p>
    <p v-else-if="!data.posts.length" class="text-gray-500 text-sm">No posts.</p>

    <article v-for="p in data.posts" :key="p.id" class="bg-gray-800 rounded-lg p-3 flex gap-3">
      <img v-if="p.media_url" :src="p.media_url" class="w-20 h-20 object-cover rounded" referrerpolicy="no-referrer" />
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 text-xs text-gray-400">
          <span class="text-cyan-400">@{{ p.handle }}</span>
          <span>{{ new Date(p.posted_at).toLocaleString() }}</span>
          <a v-if="p.url" :href="p.url" target="_blank" rel="noreferrer" class="ml-auto hover:text-gray-200">open ↗</a>
        </div>
        <p class="text-sm mt-1 whitespace-pre-wrap break-words">{{ p.text }}</p>
        <div v-if="angleLabels(p).length" class="flex flex-wrap gap-1 mt-2">
          <span v-for="lbl in angleLabels(p)" :key="lbl"
            class="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border"
            :style="badgeStyle(filterFor(lbl))">
            <span v-if="filterFor(lbl)?.emoji">{{ filterFor(lbl)!.emoji }}</span>{{ lbl }}
          </span>
        </div>
      </div>
    </article>
  </div>
</template>
