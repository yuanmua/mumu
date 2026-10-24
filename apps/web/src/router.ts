import { createRouter, createWebHistory } from 'vue-router'
import ChatView from './views/ChatView.vue'
import DebugView from './views/DebugView.vue'
import StatusView from './views/StatusView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: ChatView },
    { path: '/debug', component: DebugView },
    { path: '/status', component: StatusView },
  ],
})
