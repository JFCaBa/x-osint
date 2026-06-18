<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useData } from '../stores/data';

const data = useData();
const newHandle = ref('');
const error = ref('');

onMounted(() => data.loadAccounts());

async function add(): Promise<void> {
  error.value = '';
  if (!newHandle.value.trim()) return;
  try {
    await data.addAccount(newHandle.value.trim());
    newHandle.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'failed';
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <h2 class="text-base font-semibold">Watched accounts</h2>
    <form class="flex gap-2" @submit.prevent="add">
      <input v-model="newHandle" placeholder="@handle"
        class="flex-1 bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm" />
      <button class="bg-cyan-600 hover:bg-cyan-500 rounded px-4 text-sm">Add</button>
    </form>
    <p v-if="error" class="text-red-400 text-xs">{{ error }}</p>
    <table class="w-full text-sm">
      <thead class="text-gray-400 text-left text-xs">
        <tr><th class="py-1">Handle</th><th>Status</th><th>Last fetch</th><th>Enabled</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="a in data.accounts" :key="a.handle" class="border-t border-gray-800">
          <td class="py-2">@{{ a.handle }}</td>
          <td><span :class="a.last_status ? (a.last_status === 'error' ? 'text-red-400' : 'text-green-400') : 'text-gray-400'">{{ a.last_status ?? '—' }}</span></td>
          <td class="text-gray-400 text-xs">{{ a.last_fetched_at ? new Date(a.last_fetched_at).toLocaleString() : '—' }}</td>
          <td><input type="checkbox" :checked="a.enabled" @change="data.toggle(a.handle, !a.enabled)" /></td>
          <td><button class="text-red-400 text-xs hover:text-red-300" @click="data.remove(a.handle)">Remove</button></td>
        </tr>
        <tr v-if="!data.accounts.length"><td colspan="5" class="py-4 text-center text-gray-500 text-sm">No accounts yet</td></tr>
      </tbody>
    </table>
  </div>
</template>
