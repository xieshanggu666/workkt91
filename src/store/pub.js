import { defineStore } from 'pinia'

// 当前操作身份（演示权限模型：请求头携带，服务端强制校验）
let actor = { name: '张岚', role: 'admin' }

async function api(path, method = 'GET', body, qs, extraHeaders) {
  const url = '/api' + path + (qs ? '?' + new URLSearchParams(qs).toString() : '')
  const opt = { method, headers: { 'Content-Type': 'application/json', 'x-user': encodeURIComponent(actor.name), 'x-role': actor.role, ...(extraHeaders || {}) } }
  if (body) opt.body = JSON.stringify(body)
  const r = await fetch(url, opt)
  const data = await r.json()
  if (!r.ok) throw Object.assign(new Error(data.error || '请求失败'), { details: data.details })
  return data
}

export const usePubStore = defineStore('pub', {
  state: () => ({
    loaded: false,
    sources: [], hotWords: [], activeAlerts: [], crises: [], stats: {}, trend: [],
    user: { name: '张岚', role: 'admin' }, // 当前身份（admin 管理员 / ops 值班员 / viewer 观察员）
    toast: null
  }),
  actions: {
    setUser(u) {
      this.user = u
      actor = u
    },
    async load() {
      const d = await api('/state')
      this.sources = d.sources; this.hotWords = d.hotWords; this.activeAlerts = d.activeAlerts
      this.crises = d.crises; this.stats = d.stats; this.trend = d.trend
      this.loaded = true
    },
    msg(msg, type = 'info') { this.toast = { msg, type, id: Date.now() } },
    clearToast() { this.toast = null },
    async fetchPosts(filter) { return (await api('/posts', 'GET', null, filter)) },
    async addPost(p) {
      const r = await api('/posts', 'POST', p)
      await this.load() // 统计刷新（与批量导入统一）
      if (r.triggered && r.triggered.length) {
        const parts = r.triggered.map((t) =>
          t.deduped ? `${t.alert}（并入危机 #${t.crisisId}）`
            : t.crisisId ? `${t.alert}（已自动建档 #${t.crisisId}）` : t.alert)
        this.msg(`⚠️ 触发预警：${parts.join('、')}`, 'warn')
      } else this.msg('舆情已收录' + (r.sentiment === 'negative' ? '（负面）' : ''), 'success')
      return r
    },
    // 批量导入（可恢复任务）：创建任务，返回 jobId 供轮询进度/结果
    async createImport(items, idemKey, headers) {
      return await api('/imports', 'POST', { items, idem_key: idemKey || undefined }, null, headers)
    },
    async fetchImport(id) { return await api(`/imports/${id}`) },
    async fetchImports() { return (await api('/imports')).jobs },
    async pauseImport(id) { return await api(`/imports/${id}/pause`, 'POST') },
    async resumeImport(id) { return await api(`/imports/${id}/resume`, 'POST') },
    async fetchAlerts() { return await api('/alerts') },
    async saveAlert(a) { await api('/alerts', 'POST', a); await this.load(); this.msg('预警规则已保存', 'success') },
    async updateAlert(id, a) { await api(`/alerts/${id}`, 'PUT', a); await this.load(); this.msg('预警规则已更新，归并参数即时生效', 'success') },
    async toggleAlert(id) { await api(`/alerts/${id}/toggle`, 'POST'); await this.load() },
    async deleteAlert(id) { await api('/alerts/' + id, 'DELETE'); await this.load() },
    async resolveAlertEvent(id, note) {
      const r = await api(`/alert-events/${id}/resolve`, 'POST', { note })
      await this.load()
      if (r.already) this.msg('该预警已是解除状态，重复解除已忽略', 'info')
      else this.msg(r.crisisId ? `预警已解除，已同步危机 #${r.crisisId} 时间线` : '预警已解除', 'success')
      return r
    },
    async resolveAlert(id, note) {
      const r = await api(`/alerts/${id}/resolve`, 'POST', { note })
      await this.load()
      this.msg(r.resolved ? `已解除 ${r.resolved} 条未解除预警` : '该规则暂无未解除预警', r.resolved ? 'success' : 'info')
      return r
    },
    async addHotword(w) { await api('/hotwords', 'POST', w); await this.load() },
    async delHotword(id) { await api('/hotwords/' + id, 'DELETE'); await this.load() },
    async addCrisis(c) {
      const r = await api('/crisis', 'POST', c); await this.load(); this.msg('危机事件已建档', 'success'); return r.id
    },
    async setCrisisStatus(id, st) { await api(`/crisis/${id}/status`, 'POST', st); await this.load() },
    async addCrisisTimeline(id, t) { await api(`/crisis/${id}/timeline`, 'POST', t); await this.load() },
    async fetchCrisisReview(id) { return await api(`/crisis/${id}/review`) },
    async closeCrisis(id, summary) {
      const r = await api(`/crisis/${id}/close`, 'POST', { summary })
      await this.load()
      if (r.already) this.msg('事件已处于结案状态', 'info')
      else this.msg(r.resolved ? `事件已结案，同步解除 ${r.resolved} 条预警` : '事件已结案', 'success')
      return r
    },
    async reopenCrisis(id, note) {
      const r = await api(`/crisis/${id}/reopen`, 'POST', { note })
      await this.load()
      if (r.already) this.msg('事件未在结案状态，无需回滚', 'info')
      else this.msg(r.restored ? `已回滚结案，恢复 ${r.restored} 条未解除预警` : '已回滚结案，事件重新打开', 'success')
      return r
    },
    async delCrisis(id) { await api('/crisis/' + id, 'DELETE'); await this.load() },
    // ===== 通知中心：多渠道订阅与通知编排 =====
    async fetchTopics() { return await api('/topics') },
    async fetchNotifyOverview() { return await api('/notify/overview') },
    async saveChannel(c) { await api('/notify/channels', 'POST', c); this.msg('通知渠道已保存', 'success') },
    async toggleChannel(id) { await api(`/notify/channels/${id}/toggle`, 'POST') },
    async delChannel(id) { await api(`/notify/channels/${id}`, 'DELETE'); this.msg('渠道已删除', 'success') },
    async saveSub(s) { await api('/notify/subs', 'POST', s); this.msg('订阅已保存', 'success') },
    async toggleSub(id) { await api(`/notify/subs/${id}/toggle`, 'POST') },
    async delSub(id) { await api(`/notify/subs/${id}`, 'DELETE'); this.msg('订阅已删除', 'success') },
    async fetchNotifyTasks(status) { return await api('/notify/tasks', 'GET', null, status ? { status } : null) },
    async fetchNotifyTask(id) { return await api(`/notify/tasks/${id}`) },
    // 任务操作（暂停/恢复/重试/取消）：统一入口，错误 toast 由调用方处理
    async notifyTaskOp(id, op) {
      const r = await api(`/notify/tasks/${id}/${op}`, 'POST')
      await this.load() // 刷新全局角标（待处理通知计数）
      return r
    },
    // 确认回执：同步解除关联预警并写危机时间线
    async ackNotifyTask(id, note) {
      const r = await api(`/notify/tasks/${id}/ack`, 'POST', { note })
      await this.load()
      if (r.already) this.msg('该任务已确认过回执，重复确认已忽略', 'info')
      else if (r.resolved) this.msg(`回执已确认，同步解除 ${r.resolved} 条预警${r.crisisId ? `，已写入危机 #${r.crisisId} 时间线` : ''}`, 'success')
      else this.msg(`回执已确认${r.crisisId ? `，已写入危机 #${r.crisisId} 时间线` : ''}`, 'success')
      return r
    },
    async fetchNotifyLogs(taskId) { return (await api('/notify/logs', 'GET', null, taskId ? { task_id: taskId } : null)).logs }
  }
})