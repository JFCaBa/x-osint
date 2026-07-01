<script setup lang="ts">
import { onMounted, watch } from 'vue';
import { RouterView, RouterLink, useRoute } from 'vue-router';
import { useAuth } from './stores/auth';
import { useAi } from './stores/ai';
const auth = useAuth();
const ai = useAi();
const route = useRoute();

onMounted(() => { if (auth.token) ai.start(); });
watch(() => auth.token, (t) => { if (t) ai.start(); else ai.stop(); });
</script>

<template>
  <div class="min-h-screen">
    <nav v-if="route.path !== '/login'" class="flex items-center gap-4 px-4 py-3 bg-gray-800 border-b border-gray-700">
      <span class="font-semibold text-cyan-400">x-osint</span>
      <RouterLink to="/" class="text-sm hover:text-cyan-300" active-class="text-cyan-400">Feed</RouterLink>
      <RouterLink to="/accounts" class="text-sm hover:text-cyan-300" active-class="text-cyan-400">Accounts</RouterLink>
      <RouterLink to="/reports" class="text-sm hover:text-cyan-300" active-class="text-cyan-400">Reports</RouterLink>
      <RouterLink to="/settings" class="text-sm hover:text-cyan-300" active-class="text-cyan-400">Settings</RouterLink>
      <button class="ml-auto text-sm text-gray-400 hover:text-gray-200" @click="auth.logout(); $router.push('/login')">Logout</button>
    </nav>
    <div v-if="ai.downloading && route.path !== '/login'"
      class="bg-amber-900/40 border-b border-amber-700/50 text-amber-200 text-sm px-4 py-2">
      ⏳ AI model still downloading — filtering &amp; translation start automatically once it's ready.
    </div>
    <main class="p-4 max-w-3xl mx-auto">
      <RouterView />
    </main>
  </div>
</template>
