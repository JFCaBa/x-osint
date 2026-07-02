<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useData } from '../stores/data';
import { api, type ReportParams, type ExportStatus } from '../services/api';

const data = useData();
const mode = ref<'since-last' | 'range'>('since-last');
const from = ref('');
const to = ref('');
const include = ref<'both' | 'excel' | 'report'>('both');
const error = ref('');
const busy = ref(false);
const progress = ref<ExportStatus | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;

function params(): ReportParams {
  const base: ReportParams = mode.value === 'range'
    ? { mode: 'range', from: from.value || undefined, to: to.value || undefined }
    : { mode: 'since-last' };
  return { ...base, include: include.value };
}

async function refreshSummary(): Promise<void> {
  error.value = '';
  try { await data.loadReportSummary(params()); }
  catch (e) { error.value = e instanceof Error ? e.message : 'failed'; }
}

function stopPolling(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

function progressLabel(p: ExportStatus): string {
  switch (p.phase) {
    case 'spreadsheet': return 'Building spreadsheet…';
    case 'summarize': return `Summarising ${p.tag} (${p.index}/${p.total})`;
    case 'translate': return `Translating ${p.tag} (${p.index}/${p.total})`;
    case 'bundling': return 'Bundling…';
    case 'done': return 'Done';
    default: return 'Working…';
  }
}

async function doExport(): Promise<void> {
  error.value = '';
  busy.value = true;
  progress.value = { status: 'running', phase: 'spreadsheet', tag: null, index: 0, total: 0, error: null };
  try {
    const { jobId } = await api.startExport(params());
    timer = setInterval(() => { void poll(jobId); }, 1000);
  } catch (e) {
    stopPolling();
    error.value = e instanceof Error ? e.message : 'export failed';
    progress.value = null;
    busy.value = false;
  }
}

async function poll(jobId: string): Promise<void> {
  try {
    const s = await api.exportStatus(jobId);
    progress.value = s;
    if (s.status === 'done') {
      stopPolling();
      await api.downloadExport(jobId);
      progress.value = null;
      busy.value = false;
      await refreshSummary();
    } else if (s.status === 'error') {
      stopPolling();
      error.value = s.error || 'export failed';
      progress.value = null;
      busy.value = false;
    }
  } catch (e) {
    stopPolling();
    error.value = e instanceof Error ? e.message : 'export failed';
    progress.value = null;
    busy.value = false;
  }
}

onMounted(refreshSummary);
onUnmounted(stopPolling);
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
          <input type="radio" value="since-last" v-model="mode" @change="refreshSummary" name="report-mode" /> Since last export
        </label>
        <label class="flex items-center gap-1">
          <input type="radio" value="range" v-model="mode" @change="refreshSummary" name="report-mode" /> Date range
        </label>
      </div>

      <div class="flex gap-4 text-sm">
        <span class="text-gray-400">Include:</span>
        <label class="flex items-center gap-1">
          <input type="radio" value="both" v-model="include" name="report-include" /> Both
        </label>
        <label class="flex items-center gap-1">
          <input type="radio" value="excel" v-model="include" name="report-include" /> Excel only
        </label>
        <label class="flex items-center gap-1">
          <input type="radio" value="report" v-model="include" name="report-include" /> Report only
        </label>
      </div>

      <div v-if="mode === 'range'" class="flex gap-2 items-center text-sm">
        <input type="date" v-model="from" @change="refreshSummary"
          aria-label="From date"
          class="bg-gray-900 border border-gray-700 rounded px-2 py-1" />
        <span class="text-gray-500">to</span>
        <input type="date" v-model="to" @change="refreshSummary"
          aria-label="To date"
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
        {{ busy ? 'Generating…' : 'Export report' }}
      </button>

      <div v-if="progress" class="flex flex-col gap-1">
        <p class="text-xs text-gray-300 flex items-center gap-2">
          <span class="inline-block w-3 h-3 border-2 border-gray-600 border-t-cyan-400 rounded-full animate-spin"></span>
          {{ progressLabel(progress) }}
        </p>
        <div v-if="progress.total" class="h-1.5 bg-gray-700 rounded overflow-hidden">
          <div class="h-full bg-cyan-500 transition-all"
            :style="{ width: `${Math.round((progress.index / progress.total) * 100)}%` }"></div>
        </div>
      </div>
    </div>
  </div>
</template>
