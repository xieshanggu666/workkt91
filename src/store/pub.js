import { defineStore } from 'pinia'

async function api(path, method = 'GET', body, qs, extraHeaders) {
  const url = '/api' + path + (qs ? '?' + new URLSearchParams(qs).toString() : '')
  const opt = { method, headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) } }
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
    toast: null
  }),
  actions: {
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
    async delCrisis(id) { await api('/crisis/' + id, 'DELETE'); await this.load() }
  }
})