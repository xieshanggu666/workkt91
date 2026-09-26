<template>
  <div class="layout">
    <header class="top">
      <div class="brand"><span class="logo">📡</span><div><b>舆舟</b><em>舆情监测 · 危机管理</em></div></div>
      <nav class="tabs">
        <button v-for="t in tabs" :key="t.key" :class="{active:tab===t.key}" @click="tab=t.key">
          {{ t.icon }} {{ t.label }}
          <span v-if="t.badge" class="bd">{{ t.badge() }}</span>
        </button>
      </nav>
      <button class="reload" @click="store.load()">🔄</button>
    </header>

    <main>
      <DashboardView v-if="tab==='dash'" />
      <PostsView v-else-if="tab==='posts'" />
      <AlertCenterView v-else-if="tab==='alerts'" />
      <CrisisView v-else-if="tab==='crisis'" />
    </main>

    <transition name="tg">
      <div v-if="store.toast" class="toast" :class="store.toast.type" @click="store.clearToast()">{{ store.toast.msg }}</div>
    </transition>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { usePubStore } from '@/store/pub'
import DashboardView from '@/components/DashboardView.vue'
import PostsView from '@/components/PostsView.vue'
import AlertCenterView from '@/components/AlertCenterView.vue'
import CrisisView from '@/components/CrisisView.vue'

const store = usePubStore()
const tab = ref('dash')
const tabs = [
  { key: 'dash', icon: '📊', label: '舆情总览', badge: () => store.activeAlerts.length || 0 },
  { key: 'posts', icon: '📰', label: '舆情列表' },
  { key: 'alerts', icon: '🚨', label: '预警中心' },
  { key: 'crisis', icon: '🛟', label: '危机处置' }
]
onMounted(async () => {
  try { await store.load() }
  catch (e) { store.msg('后端未启动，请运行 node server/index.js', 'warn') }
})
</script>

<style scoped>
.layout{min-height:100vh;background:#0a1224;color:#dbe4f3;padding-bottom:40px;}
.top{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:16px;padding:10px 20px;background:#0c1730;border-bottom:1px solid rgba(120,160,220,0.18);flex-wrap:wrap;}
.brand{display:flex;align-items:center;gap:8px;}
.logo{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;font-size:20px;background:linear-gradient(135deg,#ef5350,#e65100);}
.brand b{color:#fff;font-size:15px;display:block;}
.brand em{font-size:10px;color:#6f84ab;font-style:normal;letter-spacing:1px;}
.tabs{display:flex;gap:6px;flex-wrap:wrap;}
.tabs button{background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#aebadd;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:13px;position:relative;}
.tabs button.active{background:linear-gradient(135deg,#8e24aa,#e65100);color:#fff;border-color:transparent;}
.bd{position:absolute;top:-4px;right:-4px;background:#ef5350;color:#fff;font-size:9px;border-radius:8px;padding:1px 5px;font-weight:700;}
.reload{margin-left:auto;background:#13233f;border:1px solid rgba(120,160,220,0.3);border-radius:8px;color:#8ba2c8;font-size:16px;cursor:pointer;padding:4px 10px;}
main{max-width:1280px;margin:0 auto;padding:18px 20px;}
.toast{position:fixed;right:20px;top:70px;z-index:50;padding:12px 20px;border-radius:10px;font-size:13px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,0.4);cursor:pointer;max-width:320px;}
.toast.success{background:#1b5e20;color:#c8e6c9;border:1px solid #388e3c;}
.toast.warn{background:#e65100;color:#ffe0b2;border:1px solid #f57c00;}
.toast.info{background:#0d47a1;color:#bbdefb;border:1px solid #1976d2;}
.tg-enter-active,.tg-leave-active{transition:all .3s;}
.tg-enter-from,.tg-leave-to{opacity:0;transform:translateY(-10px);}
</style>