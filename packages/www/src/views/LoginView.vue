<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuth } from '../stores/auth';

const password = ref('');
const error = ref('');
const auth = useAuth();
const router = useRouter();

async function submit(): Promise<void> {
  error.value = '';
  try {
    await auth.login(password.value);
    await router.push('/');
  } catch {
    error.value = 'Invalid password';
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center">
    <form class="bg-gray-800 p-6 rounded-lg w-72 flex flex-col gap-3" @submit.prevent="submit">
      <h1 class="text-lg font-semibold text-cyan-400">x-osint</h1>
      <input v-model="password" type="password" placeholder="Password"
        class="bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm" />
      <p v-if="error" class="text-red-400 text-xs">{{ error }}</p>
      <button class="bg-cyan-600 hover:bg-cyan-500 rounded px-3 py-2 text-sm font-medium">Sign in</button>
    </form>
  </div>
</template>
