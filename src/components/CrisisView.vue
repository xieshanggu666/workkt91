<template>
  <div class="crisis">
    <div class="toolbar">
      <button class="add" @click="showForm=!showForm">＋ 新建危机事件</button>
      <span class="loop-hint">🔗 红/橙预警按「话题 + 时间窗口」归并：多规则并发触发可承接同一事件并上调级别；解除幂等、结案可回滚，全程统一时间线</span>
    </div>

    <form v-if="showForm" class="c-form" @submit.prevent="create">
      <div class="row">
        <input v-model="form.title" placeholder="事件标题" required />
        <select v-model="form.level"><option value="red">红色 · 紧急</option><option value="orange">橙色 · 较高</option><option value="yellow">黄色 · 一般</option></select>
      </div>
      <input v-model="form.topic" placeholder="归并话题（如 食品安全）" />
      <input v-model="form.keyword" placeholder="关联关键词" />
      <input v-model="form.linked_email" placeholder="联系邮箱（用于响应）" />
      <textarea v-model="form.plan" placeholder="处置方案（每行一项）"></textarea>
      <textarea v-model="form.analysis" placeholder="舆情研判分析"></textarea>
      <div class="row">
        <button class="save" type="submit">建档</button>
        <button type="button" class="ghost" @click="showForm=false">取消</button>
      </div>
    </form>

    <div v-if="!store.crises.length" class="none">暂无危机事件</div>
    <div class="list">
      <div v-for="c in store.crises" :key="c.id" class="crisis-card" :class="c.level">
        <div class="c-head">
          <span class="lv" :class="c.level">{{ lvText(c.level) }}</span>
          <b class="ct">{{ c.title }}</b>
          <span class="origin" :class="c.origin">{{ c.origin==='auto' ? '🤖 自动建档' : '✍️ 人工建档' }}</span>
          <span v-if="c.open_events" class="open-badge">🔔 未解除预警 {{ c.open_events }}</span>
          <span class="st" :class="c.status">{{ stText(c.status) }}</span>
          <button class="del" @click="del(c)">✕</button>
        </div>
        <div class="keywords">
          <span>话题 <i>#{{ c.topic||'—' }}</i></span>
          <span>关键词 <i>#{{ c.keyword||'—' }}</i></span>
          <span v-if="c.rules && c.rules.length" class="rules-chip">
            承接规则
            <i v-for="r in c.rules" :key="r.alert_id" class="rule-chip" :class="r.alert_level">{{ r.alert_title }}{{ r.is_origin ? '·源' : '' }}</i>
          </span>
          <span v-else-if="c.alert_title">来源规则 <i>{{ c.alert_title }}</i></span>
          <span>邮箱 <i>{{ c.linked_email||'—' }}</i></span>
          <span>更新 <i>{{ c.updated }}</i></span>
        </div>

        <div class="cols">
          <div class="col">
            <h5>🗺️ 处置方案</h5>
            <pre class="plan">{{ c.plan||'（未填写）' }}</pre>
          </div>
          <div class="col">
            <h5>🧠 舆情研判</h5>
            <p class="analysis">{{ c.analysis||'（未填写）' }}</p>
          </div>
        </div>

        <div class="timeline-block">
          <h5>🕒 处置时间线</h5>
          <div class="tl">
            <div v-for="(t,i) in c.timeline" :key="t.id" class="tl-item">
              <span class="tl-dot" :class="{latest:i===0}"></span>
              <div class="tl-body">
                <b>{{ t.action }}</b>
                <span>{{ t.note }}</span>
                <em>{{ t.time }}</em>
              </div>
            </div>
          </div>
        </div>

        <!-- 回溯面板 -->
        <div v-if="review && reviewId===c.id" class="review">
          <h5>🔍 事件回溯</h5>
          <div class="rv-stats">
            <div><b>{{ review.stats.triggers }}</b><em>预警触发</em></div>
            <div><b>{{ review.stats.resolved }}</b><em>已解除</em></div>
            <div><b class="warn-num">{{ review.stats.open }}</b><em>未解除</em></div>
            <div><b>{{ review.stats.rules }}</b><em>承接规则</em></div>
            <div><b>{{ review.stats.posts }}</b><em>关联舆情</em></div>
            <div><b class="t">{{ review.stats.firstAt || '—' }}</b><em>首次触发</em></div>
            <div><b class="t">{{ review.stats.lastAt || '—' }}</b><em>最近触发</em></div>
          </div>
          <div v-if="review.rules && review.rules.length" class="rv-rules">
            <span v-for="r in review.rules" :key="r.alert_id" class="rv-rule" :class="r.alert_level">
              <i class="rd"></i>{{ r.alert_title }}<em v-if="r.is_origin" class="origin-tag">来源</em>
              <b>{{ r.open ? r.open+' 待处置 · ' : '' }}{{ r.triggers }} 次</b>
            </span>
          </div>
          <div v-if="review.events.length" class="rv-events">
            <div v-for="e in review.events" :key="e.id" class="rv-ev" :class="{resolved:e.status==='resolved'}">
              <span class="rv-dot" :class="e.alert_level"></span>
              <div class="rv-body">
                <b>{{ e.detail }}</b>
                <span v-if="e.pt">关联舆情《{{ e.pt }}》 · 热度{{ e.heat }}</span>
              </div>
              <em v-if="e.status==='resolved' && e.resolve_kind" class="rv-kind">{{ kindText(e.resolve_kind) }}</em>
              <span class="rv-st" :class="e.status">{{ e.status==='resolved' ? '已解除' : '待处置' }}</span>
            </div>
          </div>
          <div v-else class="rv-none">无关联预警触发记录（人工建档）</div>

          <!-- 结案档案：结案/回滚历史（统一时间线口径） -->
          <div v-if="review.closures && review.closures.length" class="rv-closures">
            <div v-for="cl in review.closures" :key="cl.id" class="rv-closure" :class="{rolled: cl.rolled_back}">
              <b>{{ cl.rolled_back ? '↩︎ 结案已回滚' : '✔ 结案' }}</b>
              <span class="cl-sum">{{ cl.summary || '（无总结）' }}</span>
              <em>{{ cl.closed_at }}<template v-if="cl.rolled_back"> · 回滚于 {{ cl.rolled_back_at }}{{ cl.rollback_note ? '：' + cl.rollback_note : '' }}</template></em>
            </div>
          </div>

          <div v-if="c.status!=='closed'" class="close-box">
            <textarea v-model="closeSummary" placeholder="结案回溯总结：处置结果、舆情回落情况、经验沉淀…"></textarea>
            <div class="close-row">
              <span v-if="review.stats.open" class="cascade">结案将同步解除 {{ review.stats.open }} 条未解除预警</span>
              <button class="close" @click="confirmClose(c)">✔ 确认结案</button>
            </div>
          </div>
          <div v-else class="closed-tip">✅ 已结案 · 回溯只读</div>
        </div>

        <div class="actions">
          <button class="ghost" @click="addStep(c)">＋ 记录处置</button>
          <button v-if="c.status==='monitoring'||c.status==='disposal'" class="prog" @click="advance(c)">推进处置</button>
          <button class="ghost" @click="toggleReview(c)">{{ reviewId===c.id ? '收起回溯' : '🔍 回溯' }}</button>
          <button v-if="c.status!=='closed'" class="close" @click="toggleReview(c, true)">结案</button>
          <button v-else class="reopen" @click="reopen(c)">↩︎ 回滚结案</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { usePubStore } from '@/store/pub'
const store = usePubStore()
const showForm = ref(false)
const form = ref({ title: '', level: 'orange', topic: '', keyword: '', linked_email: '', plan: '', analysis: '' })
const reviewId = ref(null)
const review = ref(null)
const closeSummary = ref('')

function create() {
  store.addCrisis({ ...form.value })
  form.value = { title: '', level: 'orange', topic: '', keyword: '', linked_email: '', plan: '', analysis: '' }
  showForm.value = false
}
function advance(c) {
  const note = prompt('推进响应，记录一次处置动作：', c.status === 'monitoring' ? '转入处置阶段，发布首次回应' : '跟进处置进展')
  if (note == null) return
  if (c.status === 'monitoring') store.setCrisisStatus(c.id, { status: 'disposal', action: '启动处置', note })
  else store.addCrisisTimeline(c.id, { action: '处置跟进', note })
}
function addStep(c) {
  const note = prompt('新增一条处置记录：')
  if (note) store.addCrisisTimeline(c.id, { action: '处置记录', note })
}
async function toggleReview(c, forClose = false) {
  if (reviewId.value === c.id && !forClose) { reviewId.value = null; review.value = null; return }
  review.value = await store.fetchCrisisReview(c.id)
  reviewId.value = c.id
  closeSummary.value = c.status === 'closed' ? '' : defaultSummary(c)
}
function defaultSummary(c) {
  return `「${c.title}」处置完毕，舆情热度回落至常态区间，未出现次生舆情，完成闭环。`
}
async function confirmClose(c) {
  if (!confirm(`确定结案「${c.title}」？`)) return
  await store.closeCrisis(c.id, closeSummary.value)
  reviewId.value = null
  review.value = null
}
async function reopen(c) {
  const note = prompt(`回滚结案「${c.title}」：结案时联动解除的预警将恢复为未解除，事件重回处置流程。\n回滚说明（可留空）：`)
  if (note == null) return
  await store.reopenCrisis(c.id, note)
  if (reviewId.value === c.id) review.value = await store.fetchCrisisReview(c.id) // 刷新回溯（结案档案/未解除计数）
}
function kindText(k) { return { manual: '手动解除', batch: '批量解除', close: '结案联动' }[k] || k }
async function del(c) {
  if (confirm(`删除危机「${c.title}」？`)) await store.delCrisis(c.id)
}
function lvText(x) { return { red: '红', orange: '橙', yellow: '黄' }[x] || x }
function stText(x) { return { monitoring: '监测中', disposal: '处置中', closed: '已结案' }[x] || x }
</script>

<style scoped>
.crisis{display:flex;flex-direction:column;gap:12px;}
.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
.toolbar button{font-family:inherit;background:linear-gradient(135deg,#43a047,#2e7d32);border:none;color:#fff;border-radius:8px;padding:9px 14px;font-size:13px;font-weight:600;cursor:pointer;}
.loop-hint{font-size:11px;color:#5b6f94;}
.c-form{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px;}
.row{display:flex;gap:8px;flex-wrap:wrap;}
input,select,textarea,button{font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:8px 10px;font-size:12px;}
textarea{resize:vertical;min-height:52px;}
.save{background:#2962ff;border:none;color:#fff;font-weight:600;cursor:pointer;}
.ghost{background:#16263f;color:#8ba2c8;cursor:pointer;}
.c-form .row:last-child{margin-top:4px;}
.list{display:flex;flex-direction:column;gap:14px;}
.crisis-card{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:16px;border-top:4px solid #ffd54f;}
.crisis-card.red{border-top-color:#ef5350;}.crisis-card.orange{border-top-color:#ff9800;}
.c-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.lv{width:26px;height:26px;border-radius:7px;display:grid;place-items:center;color:#fff;font-size:14px;flex:none;}
.lv.red{background:#ef5350;}.lv.orange{background:#ff9800;}.lv.yellow{background:#ffd54f;color:#5d4037;}
.ct{color:#fff;font-size:16px;flex:1;min-width:140px;}
.origin{font-size:10px;padding:2px 8px;border-radius:6px;background:#0d2137;color:#90caf9;border:1px solid rgba(144,202,249,.25);}
.origin.manual{background:#1a2332;color:#8ba2c8;border-color:rgba(120,160,220,.2);}
.open-badge{font-size:10px;padding:2px 8px;border-radius:6px;background:#3e2723;color:#ffab91;border:1px solid rgba(255,138,101,.3);}
.st{font-size:11px;padding:2px 10px;border-radius:6px;}
.st.monitoring{background:#37474f;color:#b0bec5;}.st.disposal{background:#b71c1c;color:#ffcdd2;}.st.closed{background:#1b5e20;color:#a5d6a7;}
.del{background:none;border:none;color:#ef5350;font-size:15px;cursor:pointer;}
.keywords{display:flex;gap:16px;font-size:11px;color:#8ba2c8;margin:10px 0;flex-wrap:wrap;align-items:center;}
.keywords i{color:#90caf9;font-style:normal;}
.rules-chip{display:inline-flex;gap:5px;flex-wrap:wrap;align-items:center;}
.rule-chip{font-style:normal;font-size:10px;padding:1px 7px;border-radius:5px;background:#0d2137;border:1px solid rgba(144,202,249,.25);color:#90caf9;}
.rule-chip.red{color:#ef9a9a;border-color:rgba(239,83,80,.4);}
.rule-chip.orange{color:#ffcc80;border-color:rgba(255,152,0,.4);}
.rule-chip.yellow{color:#ffe082;border-color:rgba(255,213,79,.4);}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
@media(max-width:700px){.cols{grid-template-columns:1fr;}}
.col{background:#13233f;border-radius:10px;padding:12px;}
h5{margin:0 0 8px;color:#ffd54f;font-size:12px;}
.plan{white-space:pre-wrap;margin:0;color:#aebadd;font-size:12px;line-height:1.6;}
.analysis{color:#aebadd;font-size:12px;line-height:1.6;margin:0;}
.timeline-block{margin-top:12px;background:#13233f;border-radius:10px;padding:12px;}
.tl{border-left:2px solid #243357;padding-left:14px;display:flex;flex-direction:column;gap:8px;max-height:160px;overflow-y:auto;}
.tl-item{position:relative;}
.tl-dot{position:absolute;left:-19px;top:4px;width:9px;height:9px;border-radius:50%;background:#546e7a;}
.tl-dot.latest{background:#ffd54f;}
.tl-body b{color:#dbe4f3;font-size:12px;display:block;}
.tl-body span{color:#8ba2c8;font-size:11px;}
.tl-body em{color:#5b6f94;font-size:10px;font-style:normal;display:block;margin-top:2px;}
.review{margin-top:12px;background:#0c1a30;border:1px solid rgba(144,202,249,.2);border-radius:10px;padding:12px;}
.rv-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:8px;margin-bottom:10px;}
.rv-stats>div{background:#13233f;border-radius:8px;padding:8px;text-align:center;display:flex;flex-direction:column;gap:2px;}
.rv-stats b{color:#fff;font-size:16px;}
.rv-stats b.t{font-size:10px;color:#90caf9;line-height:1.4;}
.rv-stats .warn-num{color:#ffab91;}
.rv-stats em{font-size:10px;color:#5b6f94;font-style:normal;}
.rv-rules{display:flex;flex-direction:column;gap:5px;margin-bottom:10px;}
.rv-rule{display:flex;align-items:center;gap:6px;font-size:11px;color:#dbe4f3;background:#13233f;border-radius:7px;padding:5px 9px;}
.rv-rule .rd{width:8px;height:8px;border-radius:50%;background:#90a4ae;flex:none;}
.rv-rule.red .rd{background:#ef5350;}.rv-rule.orange .rd{background:#ff9800;}.rv-rule.yellow .rd{background:#ffd54f;}
.rv-rule b{margin-left:auto;color:#90caf9;font-size:10px;font-weight:600;}
.origin-tag{font-size:9px;font-style:normal;color:#1b2a44;background:#90caf9;border-radius:4px;padding:0 5px;}
.rv-events{display:flex;flex-direction:column;max-height:150px;overflow-y:auto;margin-bottom:10px;}
.rv-ev{display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-bottom:1px dashed rgba(120,160,220,0.1);}
.rv-ev:last-child{border-bottom:none;}
.rv-ev.resolved{opacity:.6;}
.rv-dot{width:8px;height:8px;border-radius:50%;margin-top:4px;flex:none;background:#546e7a;}
.rv-dot.red{background:#ef5350;}.rv-dot.orange{background:#ff9800;}.rv-dot.yellow{background:#ffd54f;}
.rv-body{flex:1;min-width:0;}
.rv-body b{color:#dbe4f3;font-size:11px;display:block;}
.rv-body span{color:#5b6f94;font-size:10px;}
.rv-st{font-size:10px;padding:1px 7px;border-radius:5px;flex:none;}
.rv-st.open{background:#3e2723;color:#ffab91;}
.rv-st.resolved{background:#1b5e20;color:#a5d6a7;}
.rv-kind{font-size:9px;font-style:normal;color:#90caf9;background:#0d2137;border:1px solid rgba(144,202,249,.25);border-radius:4px;padding:1px 5px;flex:none;margin-top:2px;}
.rv-closures{display:flex;flex-direction:column;gap:5px;margin-bottom:10px;}
.rv-closure{background:#13233f;border-radius:7px;padding:6px 9px;font-size:11px;color:#dbe4f3;display:flex;flex-direction:column;gap:2px;border-left:3px solid #66bb6a;}
.rv-closure.rolled{border-left-color:#ffb300;opacity:.85;}
.rv-closure .cl-sum{color:#8ba2c8;font-size:10px;}
.rv-closure em{color:#5b6f94;font-size:10px;font-style:normal;}
.rv-none{color:#5b6f94;font-size:11px;text-align:center;padding:8px 0;}
.close-box{border-top:1px dashed rgba(120,160,220,0.15);padding-top:10px;display:flex;flex-direction:column;gap:8px;}
.close-box textarea{min-height:56px;}
.close-row{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap;}
.cascade{font-size:10px;color:#ffab91;}
.closed-tip{color:#81c784;font-size:11px;text-align:center;padding:6px 0 2px;}
.actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;}
.prog{background:linear-gradient(135deg,#ef6c00,#e65100);border:none;color:#fff;font-weight:600;cursor:pointer;}
.close{background:linear-gradient(135deg,#2e7d32,#1b5e20);border:none;color:#fff;font-weight:600;cursor:pointer;}
.reopen{background:linear-gradient(135deg,#f9a825,#f57f17);border:none;color:#fff;font-weight:600;cursor:pointer;}
.none{color:#5b6f94;text-align:center;padding:40px;}
</style>
