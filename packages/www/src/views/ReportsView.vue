<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useData } from '../stores/data';
import type { ReportParams } from '../services/api';

const data = useData();
const mode = ref<'since-last' | 'range'>('since-last');
const from = ref('');
const to = ref('');
const error = ref('');
const busy = ref(false);

function params(): ReportParams {
  return mode.value === 'range'
    ? { mode: 'range', from: from.value || undefined, to: to.value || undefined }
    : { mode: 'since-last' };
}

async function refreshSummary(): Promise<void> {
  error.value = '';
  try { await data.loadReportSummary(params()); }
  catch (e) { error.value = e instanceof Error ? e.message : 'failed'; }
}

async function doExport(): Promise<void> {
  error.value = '';
  busy.value = true;
  try {
    await data.exportReport(params());
    await refreshSummary();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'export failed';
  } finally {
    busy.value = false;
  }
}

onMounted(refreshSummary);
</script>

<template>
  <div class="flex flex-col gap-4">
    <h2 class="text-base font-semibold">Reports</h2>

    <p v-if="data.reportSummary && !data.reportSummary.aiAvailable" class="text-amber-400 text-xs">
      AI is disabled or unavailable — posts are not yet classified, so exports may be empty.
    </p>

    <div class="flex flex-col gap-3 bg-gray-800 rounded-lg p-4">
      <div class="flex gap-4 text-sm">
        <label class="flex items-center gap-1">
          <input type="radio" value="since-last" v-model="mode" @change="refreshSummary" /> Since last export
        </label>
        <label class="flex items-center gap-1">
          <input type="radio" value="range" v-model="mode" @change="refreshSummary" /> Date range
        </label>
      </div>

      <div v-if="mode === 'range'" class="flex gap-2 items-center text-sm">
        <input type="date" v-model="from" @change="refreshSummary"
          class="bg-gray-900 border border-gray-700 rounded px-2 py-1" />
        <span class="text-gray-500">to</span>
        <input type="date" v-model="to" @change="refreshSummary"
          class="bg-gray-900 border border-gray-700 rounded px-2 py-1" />
      </div>

      <p class="text-sm text-gray-300">
        Matching posts to export:
        <span class="text-cyan-400 font-semibold">{{ data.reportSummary?.count ?? '—' }}</span>
      </p>
      <p class="text-xs text-gray-500">
        Last export:
        {{ data.reportSummary?.lastExportAt ? new Date(data.reportSummary.lastExportAt).toLocaleString() : 'never' }}
      </p>

      <p v-if="error" class="text-red-400 text-xs">{{ error }}</p>

      <button :disabled="busy || (data.reportSummary?.count ?? 0) === 0"
        class="self-start bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 rounded px-4 py-2 text-sm"
        @click="doExport">
        {{ busy ? 'Exporting…' : 'Export to Excel' }}
      </button>
    </div>
  </div>
</template>
