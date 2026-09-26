<template>
  <div class="notify">
    <!-- 概览条 -->
    <div class="stat-bar">
      <div class="st pending"><b>{{ summary.pending||0 }}</b><em>待发送</em></div>
      <div class="st sent"><b>{{ summary.sent||0 }}</b><em>已送达</em></div>
      <div class="st ack"><b>{{ summary.acked||0 }}</b><em>已回执</em></div>
      <div class="st wait" :class="{hot: summary.overdueAck}"><b>{{ summary.awaitingAck||0 }}</b><em>待回执<template v-if="summary.overdueAck"> · {{ summary.overdueAck }} 超时</template></em></div>
      <div class="st esc"><b>{{ summary.escalated||0 }}</b><em>已升级</em></div>
      <div class="st fail" :class="{hot: summary.failed}"><b>{{ summary.failed||0 }}</b><em>发送失败</em></div>
      <div class="st cancel"><b>{{ summary.canceled||0 }}</b><em>已取消</em></div>
      <div class="st pause"><b>{{ summary.paused||0 }}</b><em>已暂停</em></div>
      <div class="st day"><b>{{ summary.sent24||0 }}</b><em>24h 投递</em></div>
      <div class="spacer"></div>
      <button class="ghost sm" @click="loadAll">🔄 刷新</button>
      <button v-if="may('purge')" class="ghost sm danger" @click="purge">清理 30 天前历史</button>
    </div>

    <div class="cols">
      <!-- 左：配置 -->
      <div class="col-config">
        <!-- 渠道 -->
        <div class="card">
          <div class="card-h">
            <h4>📡 通知渠道</h4>
            <button v-if="may('config')" class="mini primary" @click="chForm=emptyCh(); showCh=true">{{ showCh ? '收起' : '＋ 渠道' }}</button>
          </div>
          <form v-if="showCh" class="mini-form" @submit.prevent="saveCh">
            <input v-model="chForm.name" placeholder="渠道名称" required />
            <div class="r">
              <select v-model="chForm.type">
                <option v-for="(label,key) in meta.channelTypes" :key="key" :value="key">{{ label }}</option>
              </select>
              <input v-model.number="chForm.max_per_hour" type="number" min="0" placeholder="限速/时(0不限)" />
            </div>
            <input v-model="chForm.target" placeholder="收件地址：邮箱 / 手机号 / 机器人 URL" />
            <div class="r">
              <label class="sim">演练失败率
                <input v-model.number="chForm.sim_fail_rate" type="range" min="0" max="100" />
                <i>{{ chForm.sim_fail_rate }}%</i>
              </label>
            </div>
            <div class="r">
              <button class="mini primary" type="submit">{{ chForm.id ? '保存修改' : '添加' }}</button>
              <button type="button" class="mini" @click="showCh=false">取消</button>
            </div>
          </form>
          <div class="ch-list">
            <div v-for="c in meta.channels" :key="c.id" class="ch" :class="{off:!c.enabled}">
              <div class="ch-top">
                <b>{{ typeIcon(c.type) }} {{ c.name }}</b>
                <span class="tag">{{ meta.channelTypes[c.type] }}</span>
                <label v-if="may('operate')" class="switch sm">
                  <input type="checkbox" :checked="!!c.enabled" @change="toggleCh(c)" /><span></span>
                </label>
              </div>
              <small class="addr">{{ c.target || '（未配置地址）' }}</small>
              <div class="ch-meta">
                <em class="ok">✔ {{ c.sent_ok }}</em><em class="no">✘ {{ c.sent_fail }}</em>
                <em v-if="c.max_per_hour">限速 {{ c.max_per_hour }}/时</em>
                <em v-if="c.sim_fail_rate" class="sim-on">故障注入 {{ c.sim_fail_rate }}%</em>
              </div>
              <div class="ch-btns">
                <button v-if="may('channelTest')" class="mini" @click="testCh(c)">连通测试</button>
                <template v-if="may('operate')">
                  <button class="mini" @click="setSim(c, c.sim_fail_rate ? 0 : 100)">{{ c.sim_fail_rate ? '清除故障注入' : '注入 100% 失败' }}</button>
                </template>
                <template v-if="may('config')">
                  <button class="mini" @click="chForm={...c}; showCh=true">编辑</button>
                  <button class="mini danger" @click="removeCh(c)">删除</button>
                </template>
              </div>
            </div>
          </div>
        </div>

        <!-- 订阅 -->
        <div class="card">
          <div class="card-h">
            <h4>📝 舆情订阅规则</h4>
            <button v-if="may('config')" class="mini primary" @click="subForm=emptySub(); showSub=true">{{ showSub ? '收起' : '＋ 订阅' }}</button>
          </div>
          <form v-if="showSub" class="mini-form" @submit.prevent="saveSub">
            <input v-model="subForm.name" placeholder="订阅名称，如 红色危机领导通报" required />
            <div class="r">
              <select v-model.number="subForm.owner_id">
                <option :value="null">订阅人（不指定）</option>
                <option v-for="u in meta.users" :key="u.id" :value="u.id">{{ u.name }} · {{ roleText(u.role) }}</option>
              </select>
              <select v-model="subForm.min_level">
                <option value="red">红色起</option><option value="orange">橙色起</option><option value="yellow">黄色起（全部）</option>
              </select>
            </div>
            <div class="chk-group">
              <label v-for="(label,key) in meta.eventTypes" :key="key" class="chk">
                <input type="checkbox" :value="key" v-model="subForm.event_types" />{{ label }}
              </label>
            </div>
            <input v-model="subForm.topics" placeholder="话题过滤（逗号分隔，空=不限）" />
            <div class="r">
              <select v-model.number="subForm.ack_timeout_min">
                <option :value="0">无需回执</option><option :value="15">15 分钟回执</option>
                <option :value="30">30 分钟回执</option><option :value="60">60 分钟回执</option>
                <option :value="120">120 分钟回执</option>
              </select>
              <select v-model="subForm.crisis_status">
                <option value="">危机状态不限</option><option value="monitoring">仅监测中</option>
                <option value="disposal">仅处置中</option><option value="closed">仅已结案</option>
              </select>
            </div>
            <div class="pick">
              <span>通知渠道（按序编排）</span>
              <label v-for="c in meta.channels" :key="'c'+c.id" class="chk"><input type="checkbox" :value="c.id" v-model="subForm.channel_ids" />{{ c.name }}</label>
            </div>
            <div class="pick">
              <span>超时/失败升级链（逐级）</span>
              <label v-for="c in meta.channels" :key="'e'+c.id" class="chk"><input type="checkbox" :value="c.id" v-model="subForm.escalate_to" />{{ c.name }}</label>
            </div>
            <div class="r">
              <input v-model="subForm.quiet_start" placeholder="静默开始 HH:MM" />
              <input v-model="subForm.quiet_end" placeholder="静默结束 HH:MM（可跨夜）" />
            </div>
            <div class="r">
              <button class="mini primary" type="submit">{{ subForm.id ? '保存修改' : '创建订阅' }}</button>
              <button type="button" class="mini" @click="showSub=false">取消</button>
            </div>
          </form>
          <div class="sub-list">
            <div v-for="s in meta.subscriptions" :key="s.id" class="sub" :class="{off:!s.active}">
              <div class="sub-top">
                <b>#{{ s.id }} {{ s.name }}</b>
                <span class="lv" :class="s.min_level">{{ lvShort(s.min_level) }}级起</span>
                <label v-if="may('operate')" class="switch sm">
                  <input type="checkbox" :checked="!!s.active" @change="toggleS(s)" /><span></span>
                </label>
                <em v-else class="paused-text">{{ s.active ? '生效中' : '已暂停' }}</em>
              </div>
              <small class="evs">{{ s.event_types.map(k=>meta.eventTypes[k]).join(' · ') || '（未选事件）' }}</small>
              <small>渠道：<i>{{ s.channel_ids.map(chName).join(' → ') || '—' }}</i></small>
              <small>升级：<i>{{ s.escalate_to.length ? s.escalate_to.map(chName).join(' → ') : '无' }}</i> · 回执 {{ s.ack_timeout_min ? s.ack_timeout_min+' 分钟' : '不需要' }}</small>
              <small v-if="s.topics">话题：<i>{{ s.topics }}</i></small>
              <small v-if="s.quiet_start" class="quiet">🌙 静默 {{ s.quiet_start }}–{{ s.quiet_end }}（期间暂存，窗口结束自动补发）</small>
              <div v-if="may('config')" class="ch-btns">
                <button class="mini" @click="editSub(s)">编辑</button>
                <button class="mini danger" @click="removeSub(s)">删除</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 中：任务队列/历史 -->
      <div class="col-tasks">
        <div class="card">
          <div class="card-h">
            <h4>🗂️ 通知任务（{{ tasks.length }}）</h4>
            <div class="filters">
              <select v-model="filter.status" @change="loadTasks">
                <option value="all">全部状态</option>
                <option value="pending">待发送</option><option value="sending">发送中</option>
                <option value="sent">已送达</option><option value="acked">已回执</option>
                <option value="failed">发送失败</option><option value="escalated">已升级</option>
                <option value="canceled">已取消</option><option value="paused">已暂停</option>
              </select>
              <select v-model="filter.event_type" @change="loadTasks">
                <option value="">全部事件</option>
                <option v-for="(label,key) in meta.eventTypes" :key="key" :value="key">{{ label }}</option>
              </select>
            </div>
          </div>
          <div class="task-list">
            <div v-for="t in tasks" :key="t.id" class="task" :class="[t.status, {sel: detail && detail.task.id===t.id}]" @click="openTask(t.id)">
              <span class="st-dot" :class="t.status"></span>
              <div class="t-body">
                <b>{{ t.title }}</b>
                <small>{{ typeIcon(t.channel_type) }} {{ t.channel_name }} · {{ t.sub_name }}<template v-if="t.escalate_level"> · 第{{ t.escalate_level }}级升级</template></small>
              </div>
              <div class="t-side">
                <span class="t-status" :class="t.status">{{ t.statusText }}</span>
                <em>#{{ t.id }} · {{ t.updated }}</em>
              </div>
            </div>
            <div v-if="!tasks.length" class="none">暂无任务</div>
          </div>
        </div>
      </div>

      <!-- 右：详情 -->
      <div class="col-detail" v-if="detail">
        <div class="card detail-card">
          <div class="card-h">
            <h4>任务 #{{ detail.task.id }}</h4>
            <button class="mini" @click="detail=null">✕</button>
          </div>
          <span class="t-status big" :class="detail.task.status">{{ detail.task.statusText }}</span>
          <h5>{{ detail.task.title }}</h5>
          <p class="t-msg">{{ detail.task.body }}</p>
          <div class="kv">
            <span>订阅</span><i>{{ detail.task.sub_name }}</i>
            <span>渠道</span><i>{{ typeIcon(detail.task.channel_type) }} {{ detail.task.channel_name }} → {{ detail.task.target || '—' }}</i>
            <span>事件</span><i>{{ meta.eventTypes[detail.task.event_type] }}</i>
            <span>尝试</span><i>{{ detail.task.attempts }} / {{ detail.task.max_attempts }} 次</i>
            <span v-if="detail.task.sent_at">送达</span><i v-if="detail.task.sent_at">{{ detail.task.sent_at }}</i>
            <span v-if="detail.task.last_error">错误</span><i v-if="detail.task.last_error" class="err">{{ detail.task.last_error }}</i>
            <span v-if="detail.task.acked_at">回执</span><i v-if="detail.task.acked_at">{{ detail.task.acked_at }} · {{ detail.task.acked_by }}<template v-if="detail.task.ack_note">：{{ detail.task.ack_note }}</template></i>
          </div>

          <!-- 操作（按状态 + 权限） -->
          <div class="t-actions">
            <template v-if="['sent','escalated','sending','paused','failed'].includes(detail.task.status)">
              <button class="mini primary" @click="ack(false)">✔ 确认回执</button>
              <button v-if="detail.task.alert_event_id" class="mini ok" @click="ack(true)">✔ 回执并解除预警</button>
            </template>
            <template v-if="may('operate')">
              <button v-if="detail.task.status==='pending'" class="mini" @click="act('pause')">暂停</button>
              <button v-if="detail.task.status==='paused'" class="mini primary" @click="act('resume')">恢复</button>
              <button v-if="['failed','canceled'].includes(detail.task.status)" class="mini primary" @click="act('retry')">手动重试</button>
              <button v-if="['pending','sending','paused','sent','failed'].includes(detail.task.status)" class="mini warn" @click="act('escalate')">⚡ 立即升级</button>
              <button v-if="!['acked','canceled'].includes(detail.task.status)" class="mini danger" @click="act('cancel')">取消</button>
            </template>
            <button v-if="may('purge') && !['pending','sending'].includes(detail.task.status)" class="mini danger" @click="act('delete')">删除留痕</button>
          </div>

          <!-- 同批次编排 -->
          <div v-if="detail.siblings.length" class="siblings">
            <h6>同批次多渠道编排 / 升级链</h6>
            <div v-for="s in detail.siblings" :key="s.id" class="sib" :class="s.status">
              <span class="st-dot" :class="s.status"></span>
              <i>{{ s.escalate_level ? `第${s.escalate_level}级` : '原始' }} · {{ typeIcon(s.channel_type) }} {{ s.channel_name }}</i>
              <em>#{{ s.id }} {{ s.status }}</em>
            </div>
          </div>

          <!-- 投递日志（历史追踪） -->
          <h6>🕓 投递与处置日志</h6>
          <div class="logs">
            <div v-for="l in detail.logs" :key="l.id" class="log" :class="l.action">
              <span class="l-dot"></span>
              <div><b>{{ logText(l.action) }}<em v-if="l.by"> · {{ l.by }}</em></b><small>{{ l.note }}</small><time>{{ l.time }}</time></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onUnmounted } from 'vue'
import { usePubStore } from '@/store/pub'
const store = usePubStore()
const meta = reactive({ channelTypes: {}, eventTypes: {}, channels: [], subscriptions: [], users: [], levels: {} })
const summary = ref({})
const tasks = ref([])
const detail = ref(null)
const showCh = ref(false); const chForm = ref({})
const showSub = ref(false); const subForm = ref({})
const filter = reactive({ status: 'all', event_type: '' })
let timer = null

const may = (p) => {
  const r = store.user?.role
  if (p === 'config' || p === 'purge') return r === 'admin'
  if (p === 'operate' || p === 'channelTest') return r === 'admin' || r === 'operator'
  return true
}
const roleText = (r) => ({ admin: '管理员', operator: '值班员', viewer: '观察员' })[r] || r
const lvShort = (l) => ({ red: '红', orange: '橙', yellow: '黄' })[l] || l
const typeIcon = (t) => ({ email: '📧', sms: '📱', wecom: '💬', dingtalk: '🔔', webhook: '🔗' })[t] || '📨'
const chName = (id) => meta.channels.find((c) => c.id === id)?.name || `#${id}`
const logText = (a) => ({
  created: '编排创建', send_ok: '投递成功', send_fail: '投递失败', retry: '（自动/手动）重试',
  escalate: '触发升级', ack: '确认回执', pause: '暂停', resume: '恢复', cancel: '取消'
})[a] || a

const emptyCh = () => ({ name: '', type: 'email', target: '', max_per_hour: 0, sim_fail_rate: 0 })
const emptySub = () => ({
  name: '', owner_id: null, event_types: ['alert_fired'], min_level: 'orange', topics: '',
  crisis_status: '', channel_ids: [], escalate_to: [], ack_timeout_min: 30, quiet_start: '', quiet_end: ''
})

async function loadMeta() {
  const m = await store.loadNotifyMeta()
  Object.assign(meta, m)
  summary.value = m.summary
}
async function loadTasks() {
  const d = await store.fetchTasks({ status: filter.status, event_type: filter.event_type })
  tasks.value = d.tasks
  summary.value = d.summary
}
async function loadAll() {
  await loadMeta()
  await loadTasks()
  if (detail.value) await openTask(detail.value.task.id)
}

async function saveCh() {
  await store.saveChannel({ ...chForm.value })
  showCh.value = false
  store.msg('渠道已保存', 'success')
  await loadMeta()
}
async function toggleCh(c) { await store.toggleChannel(c.id); await loadMeta() }
async function testCh(c) {
  try { await store.testChannel(c.id); store.msg(`「${c.name}」连通测试成功`, 'success') }
  catch (e) { store.msg(`测试失败：${e.message}`, 'warn') }
}
async function setSim(c, rate) {
  await store.setChannelSimRate(c.id, rate)
  store.msg(rate ? `已对「${c.name}」注入 ${rate}% 失败（演练重试/升级）` : '已清除故障注入', rate ? 'warn' : 'success')
  await loadMeta()
}
async function removeCh(c) {
  if (!confirm(`删除渠道「${c.name}」？`)) return
  try { await store.delChannel(c.id); store.msg('渠道已删除', 'success') } catch (e) { store.msg(e.message, 'error') }
  await loadMeta()
}
function editSub(s) { subForm.value = JSON.parse(JSON.stringify(s)); showSub.value = true }
async function saveSub() {
  if (!subForm.value.channel_ids.length) return store.msg('至少选择一个通知渠道', 'warn')
  await store.saveSub(JSON.parse(JSON.stringify(subForm.value)))
  showSub.value = false
  store.msg('订阅已保存', 'success')
  await loadMeta()
}
async function toggleS(s) { await store.toggleSub(s.id); await loadMeta() }
async function removeSub(s) {
  if (!confirm(`删除订阅「${s.name}」？在途任务需先处理。`)) return
  try { await store.delSub(s.id); store.msg('订阅已删除', 'success') } catch (e) { store.msg(e.message, 'error') }
  await loadMeta(); await loadTasks()
}
async function openTask(id) {
  detail.value = await store.fetchTask(id)
}
async function ack(resolveAlert) {
  const note = prompt(resolveAlert ? '确认回执并联动解除关联预警，备注：' : '确认回执，备注：', '已知悉，正在跟进处置')
  if (note == null) return
  try {
    const r = await store.ackTask(detail.value.task.id, { note, resolve_alert: resolveAlert })
    if (r.resolvedAlert) store.msg('已回执，关联预警同步解除并写入危机时间线', 'success')
    else if (r.crisisTimelineWritten) store.msg('已回执，已同步危机时间线', 'success')
    else store.msg('已确认回执', 'success')
  } catch (e) { return store.msg(e.message, 'error') }
  await loadAll()
}
async function act(kind) {
  const id = detail.value.task.id
  if ((kind === 'cancel' || kind === 'delete') && !confirm(kind === 'delete' ? '删除该任务及全部投递日志？' : '取消该通知任务？')) return
  try {
    if (kind === 'pause') await store.pauseTask(id)
    if (kind === 'resume') await store.resumeTask(id)
    if (kind === 'retry') await store.retryTask(id)
    if (kind === 'escalate') await store.escalateTask(id)
    if (kind === 'cancel') await store.cancelTask(id)
    if (kind === 'delete') { await store.delTask(id); detail.value = null }
    store.msg('操作成功', 'success')
  } catch (e) { store.msg(e.message, 'error') }
  await loadAll()
}
async function purge() {
  if (!confirm('清理 30 天前已完结（已回执/失败/取消/升级）的任务与日志？')) return
  const r = await store.purgeHistory(30)
  store.msg(`已清理 ${r.purged} 条历史任务`, 'success')
  await loadAll()
}

onMounted(async () => {
  await loadAll()
  timer = setInterval(async () => {
    if (document.hidden) return
    await loadTasks()
    if (detail.value && ['pending', 'sending', 'sent', 'paused'].includes(detail.value.task.status)) {
      await openTask(detail.value.task.id)
    }
  }, 4000)
})
onUnmounted(() => clearInterval(timer))
</script>

<style scoped>
.notify{display:flex;flex-direction:column;gap:12px;}
.stat-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:10px 14px;}
.st{display:flex;flex-direction:column;align-items:center;min-width:62px;padding:4px 10px;border-radius:8px;background:#13233f;}
.st b{font-size:18px;color:#fff;line-height:1.2;}
.st em{font-size:10px;color:#8ba2c8;font-style:normal;text-align:center;}
.st.pending b{color:#90caf9;}.st.sent b{color:#81d4fa;}.st.ack b{color:#81c784;}
.st.wait b{color:#ffd54f;}.st.wait.hot b{color:#ff6e40;}.st.esc b{color:#ce93d8;}
.st.fail b{color:#ef5350;}.st.cancel b{color:#78909c;}.st.pause b{color:#ffb74d;}.st.day b{color:#a5d6a7;}
.spacer{flex:1;}
.cols{display:grid;grid-template-columns:340px 380px 1fr;gap:12px;align-items:start;}
@media(max-width:1180px){.cols{grid-template-columns:1fr 1fr;}.col-detail{grid-column:1/-1;}}
@media(max-width:760px){.cols{grid-template-columns:1fr;}}
.card{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px;}
.card-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:8px;}
h4{margin:0;color:#fff;font-size:14px;}
.col-config{display:flex;flex-direction:column;gap:12px;}
.col-tasks,.col-detail{position:sticky;top:64px;max-height:calc(100vh - 80px);overflow-y:auto;}
.mini-form{background:#13233f;border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:6px;margin-bottom:10px;}
.mini-form .r{display:flex;gap:6px;}.mini-form .r>*{flex:1;}
input,select,button{font-family:inherit;background:#0f1b38;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:7px;padding:7px 9px;font-size:12px;}
.mini{background:#16263f;border:1px solid rgba(120,160,220,0.25);color:#aebadd;border-radius:6px;padding:4px 9px;font-size:11px;cursor:pointer;}
.mini.primary{background:#2962ff;border-color:#2962ff;color:#fff;}
.mini.danger{color:#ef9a9a;border-color:rgba(239,83,80,.4);}
.mini.warn{color:#ffcc80;border-color:rgba(255,152,0,.4);}
.mini.ok{color:#a5d6a7;border-color:rgba(102,187,106,.4);}
button.sm{padding:5px 10px;font-size:11px;}
.ghost{background:#16263f;color:#8ba2c8;cursor:pointer;border:1px solid rgba(120,160,220,0.2);border-radius:7px;}
.ghost.danger{color:#ef9a9a;border-color:rgba(239,83,80,.35);}
.sim{display:flex;align-items:center;gap:6px;font-size:11px;color:#8ba2c8;flex:1;}
.sim input[type=range]{flex:1;padding:0;}
.sim i{color:#ffab91;font-style:normal;}
.chk-group,.pick{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:11px;color:#aebadd;background:#0f1b38;border-radius:7px;padding:6px 8px;}
.chk{display:inline-flex;align-items:center;gap:3px;cursor:pointer;}
.chk input{width:auto;}
.pick{flex-direction:column;align-items:flex-start;gap:3px;}
.ch-list,.sub-list{display:flex;flex-direction:column;gap:8px;max-height:300px;overflow-y:auto;}
.ch,.sub{background:#16263f;border-radius:8px;padding:9px 11px;border-left:3px solid #2962ff;}
.ch.off,.sub.off{opacity:.55;border-left-color:#546e7a;}
.ch-top,.sub-top{display:flex;align-items:center;gap:8px;}
.ch-top b,.sub-top b{color:#dbe4f3;font-size:12px;flex:1;min-width:0;}
.tag{font-size:9px;padding:1px 6px;border-radius:4px;background:#0d47a1;color:#bbdefb;}
.addr{display:block;color:#6f84ab;font-size:10px;margin:3px 0;word-break:break-all;}
.ch-meta{display:flex;gap:10px;font-size:10px;}
.ch-meta em{font-style:normal;color:#8ba2c8;}
.ch-meta .ok{color:#81c784;}.ch-meta .no{color:#ef9a9a;}
.ch-meta .sim-on{color:#ffab91;}
.ch-btns{display:flex;gap:5px;margin-top:7px;flex-wrap:wrap;}
.sub small{display:block;color:#8ba2c8;font-size:10px;margin-top:2px;}
.sub small i{color:#90caf9;font-style:normal;}
.sub small.evs{color:#aebadd;}
.sub small.quiet{color:#ffcc80;}
.lv{font-size:9px;padding:1px 6px;border-radius:4px;background:#37474f;color:#b0bec5;}
.lv.red{background:#b71c1c;color:#ffcdd2;}.lv.orange{background:#e65100;color:#ffe0b2;}.lv.yellow{background:#f57f17;color:#fff8e1;}
.paused-text{font-size:10px;color:#ffb74d;font-style:normal;}
.switch{position:relative;width:32px;height:18px;display:inline-block;}
.switch input{opacity:0;width:0;height:0;}
.switch span{position:absolute;inset:0;background:#243357;border-radius:18px;transition:.2s;cursor:pointer;}
.switch span:before{content:'';position:absolute;width:14px;height:14px;left:2px;top:2px;background:#7b8db3;border-radius:50%;transition:.2s;}
.switch input:checked+span{background:#2962ff;}
.switch input:checked+span:before{transform:translateX(14px);background:#fff;}
.filters{display:flex;gap:6px;}
.filters select{padding:5px 8px;font-size:11px;}
.task-list{display:flex;flex-direction:column;max-height:calc(100vh - 150px);overflow-y:auto;}
.task{display:flex;gap:9px;padding:9px 8px;border-radius:8px;cursor:pointer;border-bottom:1px dashed rgba(120,160,220,0.08);}
.task:hover{background:#13233f;}
.task.sel{background:#13233f;outline:1px solid rgba(41,98,255,.4);}
.st-dot{width:9px;height:9px;border-radius:50%;margin-top:4px;flex:none;background:#546e7a;}
.st-dot.pending{background:#90caf9;animation:pulse 1.2s infinite;}
.st-dot.sending{background:#ffd54f;animation:pulse .8s infinite;}
.st-dot.sent{background:#4fc3f7;}.st-dot.acked{background:#66bb6a;}
.st-dot.failed{background:#ef5350;}.st-dot.escalated{background:#ce93d8;}
.st-dot.canceled{background:#546e7a;}.st-dot.paused{background:#ffb74d;}
@keyframes pulse{0%,100%{opacity:1;}50%{opacity:.35;}}
.t-body{flex:1;min-width:0;}
.t-body b{font-size:12px;color:#dbe4f3;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.t-body small{font-size:10px;color:#6f84ab;display:block;margin-top:2px;}
.t-side{display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex:none;}
.t-side em{font-size:9px;color:#5b6f94;font-style:normal;white-space:nowrap;}
.t-status{font-size:9px;padding:1px 7px;border-radius:4px;white-space:nowrap;}
.t-status.pending{background:#0d2b4d;color:#90caf9;}.t-status.sending{background:#3e3410;color:#ffd54f;}
.t-status.sent{background:#0d3a4d;color:#4fc3f7;}.t-status.acked{background:#1b3a1f;color:#81c784;}
.t-status.failed{background:#3e1515;color:#ef9a9a;}.t-status.escalated{background:#2e1a3e;color:#ce93d8;}
.t-status.canceled{background:#263238;color:#90a4ae;}.t-status.paused{background:#3e2f10;color:#ffb74d;}
.t-status.big{font-size:12px;padding:3px 12px;}
.detail-card h5{color:#fff;font-size:14px;margin:12px 0 6px;}
.detail-card h6{color:#ffd54f;font-size:11px;margin:14px 0 7px;}
.t-msg{color:#aebadd;font-size:12px;background:#13233f;border-radius:8px;padding:9px;margin:0 0 10px;line-height:1.6;}
.kv{display:grid;grid-template-columns:48px 1fr;gap:4px 10px;font-size:11px;}
.kv span{color:#5b6f94;}.kv i{color:#aebadd;font-style:normal;word-break:break-all;}
.kv i.err{color:#ef9a9a;}
.t-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:14px;}
.siblings{display:flex;flex-direction:column;gap:4px;margin-bottom:6px;}
.sib{display:flex;align-items:center;gap:7px;background:#13233f;border-radius:7px;padding:5px 9px;font-size:11px;}
.sib i{color:#90caf9;font-style:normal;flex:1;}
.sib em{color:#5b6f94;font-style:normal;font-size:10px;}
.logs{border-left:2px solid #243357;padding-left:14px;display:flex;flex-direction:column;gap:9px;}
.log{position:relative;}
.l-dot{position:absolute;left:-19px;top:4px;width:9px;height:9px;border-radius:50%;background:#546e7a;}
.log.send_ok .l-dot{background:#66bb6a;}.log.send_fail .l-dot{background:#ef5350;}
.log.ack .l-dot{background:#81c784;}.log.escalate .l-dot{background:#ce93d8;}
.log.retry .l-dot{background:#ffd54f;}.log.pause .l-dot,.log.cancel .l-dot{background:#78909c;}
.log b{color:#dbe4f3;font-size:11px;display:block;}
.log b em{color:#6f84ab;font-weight:400;font-style:normal;}
.log small{color:#8ba2c8;font-size:10px;display:block;line-height:1.5;}
.log time{color:#5b6f94;font-size:9px;}
.none{color:#5b6f94;text-align:center;padding:30px;font-size:12px;}
</style>
