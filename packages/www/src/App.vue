<script setup lang="ts">
import { RouterView, RouterLink, useRoute } from 'vue-router';
import { useAuth } from './stores/auth';
const auth = useAuth();
const route = useRoute();
</script>

<template>
  <div class="min-h-screen">
    <nav v-if="route.path !== '/login'" class="flex items-center gap-4 px-4 py-3 bg-gray-800 border-b border-gray-700">
      <span class="font-semibold text-cyan-400">x-osint</span>
      <RouterLink to="/" class="text-sm hover:text-cyan-300" active-class="text-cyan-400">Feed</RouterLink>
      <RouterLink to="/accounts" class="text-sm hover:text-cyan-300" active-class="text-cyan-400">Accounts</RouterLink>
      <RouterLink to="/reports" class="text-sm hover:text-cyan-300" active-class="text-cyan-400">Reports</RouterLink>
      <button class="ml-auto text-sm text-gray-400 hover:text-gray-200" @click="auth.logout(); $router.push('/login')">Logout</button>
    </nav>
    <main class="p-4 max-w-3xl mx-auto">
      <RouterView />
    </main>
  </div>
</template>
