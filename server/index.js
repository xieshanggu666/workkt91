import express from 'express'
import { db } from './db.js'
import {
  now, statsSummary, validateItem, ingestPost, addTimeline
} from './pipeline.js'
import {
  JOB_MAX, createJob, getJob, listJobs, resumeJob, pauseJob, recoverInterrupted
} from './import-engine.js'
import { emit } from './event-bus.js'
import { attachUser, requirePerm } from './auth.js'
import * as notify from './notify-engine.js'

const app = express()
app.use(express.json({ limit: '5mb' })) // 大批量导入（上限 5000 条）
app.use(attachUser) // 通知模块 RBAC：x-user-id → req.user/req.can（缺省回落值班角色）

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// 启动恢复：崩溃/重启时未完成的导入任务转「已暂停」，保留进度，等待续跑
const recovered = recoverInterrupted()
if (recovered) console.log(`[PUBMON] 恢复 ${recovered} 个中断的批量导入任务（已暂停，可续跑）`)
// 通知调度器：订阅业务事件 + 启动定时发送/重试/升级；发送中断任务自动回待发送
const nrec = notify.initNotify()
if (nrec.recovered) console.log(`[NOTIFY] 恢复 ${nrec.recovered} 个发送中断的通知任务`)

// 危机列表（含来源规则、承接规则、未解除预警数、时间线）
function crisisList(withTimeline = false) {
  const list = q(`SELECT c.*, a.title alert_title,
    (SELECT COUNT(*) FROM alert_events ae WHERE ae.crisis_id=c.id AND ae.status='open') open_events
    FROM crisis c LEFT JOIN alerts a ON a.id=c.alert_id ORDER BY c.id DESC`)
  return list.map((c) => {
    const rules = q(`SELECT ca.alert_id, ca.is_origin, ca.first_at, ca.last_at, al.title alert_title, al.level alert_level
      FROM crisis_alerts ca LEFT JOIN alerts al ON al.id=ca.alert_id
      WHERE ca.crisis_id=? ORDER BY ca.is_origin DESC, ca.alert_id`, c.id)
    const item = { ...c, rules }
    if (withTimeline) item.timeline = q('SELECT * FROM crisis_timeline WHERE crisis_id=? ORDER BY id DESC', c.id)
    return item
  })
}

// ===== 总览 =====
app.get('/api/state', (req, res) => {
  const posts = q('SELECT * FROM posts')
  const hot = q('SELECT * FROM hot_words ORDER BY weight DESC LIMIT 12')
  const activeAlerts = q('SELECT * FROM alerts WHERE active=1')
  const crises = crisisList()
  const sources = q('SELECT s.*, COUNT(p.id) cnt FROM sources s LEFT JOIN posts p ON p.source_id=s.id GROUP BY s.id')
  // 闭环统计：未解除预警 / 在办危机（与预警中心、危机处置同口径，SQL 直查不受列表分页限制）
  const loop = q1(`SELECT
    (SELECT COUNT(*) FROM alert_events WHERE status='open') alertOpen,
    (SELECT COUNT(*) FROM alert_events) alertTotal,
    (SELECT COUNT(*) FROM crisis WHERE status!='closed') crisisActive,
    (SELECT COUNT(*) FROM crisis WHERE status='closed') crisisClosed`)
  // 热度趋势（近7时段）
  const nowH = new Date().getHours()
  const trend = []
  for (let i = 6; i >= 0; i--) {
    const seg = nowH - i
    const label = (seg + 24) % 24
    const len = posts.length
    const v = Math.round((len * (0.55 + ((i % 3) * 0.15))) + (Math.sin(i * 1.7) * 6))
    trend.push({ label, value: Math.max(18, v) })
  }
  res.json({
    sources, hotWords: hot, activeAlerts, crises,
    stats: { ...statsSummary(posts), ...loop },
    trend
  })
})

// ===== 舆情列表（支持筛选） =====
app.get('/api/posts', (req, res) => {
  const { sentiment, source, topic, q: kw } = req.query
  let sql = 'SELECT * FROM posts WHERE 1=1'
  const args = []
  if (sentiment && sentiment !== 'all') { args.push(sentiment); sql += ` AND sentiment=?` }
  if (source && source !== 'all') { args.push(+source); sql += ` AND source_id=?` }
  if (topic) { args.push(topic); sql += ` AND topic LIKE ?`; args.push(`%${topic}%`) }
  if (kw) { args.push(`%${kw}%`); args.push(`%${kw}%`); sql += ` AND (title LIKE ? OR content LIKE ?)` }
  sql += ' ORDER BY published DESC'
  res.json(q(sql, ...args))
})
app.get('/api/topics', (req, res) => {
  res.json(db.prepare('SELECT DISTINCT topic FROM posts').all().map((r) => r.topic))
})

// 新增舆情（单条录入，走统一管线，支持可选条目幂等键；响应结构保持不变）
app.post('/api/posts', (req, res) => {
  const err = validateItem(req.body, 0)
  if (err) return res.status(400).json({ error: err })
  const r = ingestPost(req.body, { idemKey: (req.body.idem_key || '').trim() || null })
  if (r.duplicate) {
    const p = q1('SELECT sentiment, heat FROM posts WHERE id=?', r.id)
    return res.json({ ok: true, id: r.id, duplicate: true, sentiment: p?.sentiment, heat: p?.heat, triggered: [] })
  }
  res.json({ ok: true, id: r.id, sentiment: r.sentiment, heat: r.heat, triggered: r.triggered })
})

// ===== 可恢复批量导入任务 =====
function parseFailSeqs(req) {
  // 演练用：请求头 x-sim-fail: "2,5" → 指定条目首轮注入瞬时故障，验证自动重试
  const raw = String(req.headers['x-sim-fail'] || '')
  return raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n))
}
function parseAlwaysFailSeqs(req) {
  // 演练用：x-sim-fail-always → 每轮都失败（验证条目达到上限 → 任务 failed → 手动重试恢复）
  const raw = String(req.headers['x-sim-fail-always'] || '')
  return raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n))
}

// 创建导入任务（任务幂等：同 idem_key 重复提交返回同一任务，不重复执行）
app.post('/api/imports', (req, res) => {
  const items = req.body && req.body.items
  const jobKey = typeof req.body?.idem_key === 'string' ? req.body.idem_key.trim() : ''
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items 不能为空' })
  if (items.length > JOB_MAX) return res.status(400).json({ error: `单次最多导入 ${JOB_MAX} 条` })
  // 创建前整批预校验，任一不合格拒绝建任务（尚未写库）
  const errors = items.map((it, i) => validateItem(it, i)).filter(Boolean)
  if (errors.length) return res.status(400).json({ error: '校验失败，未创建导入任务', details: errors })

  const { job, createdNow } = createJob({ idemKey: jobKey, items, failSeqs: parseFailSeqs(req), alwaysFailSeqs: parseAlwaysFailSeqs(req) })
  if (!createdNow) {
    return res.status(200).json({ ok: true, reused: true, jobId: job.id, job: getJob(job.id) })
  }
  const started = resumeJob(job.id)
  res.status(202).json({ ok: true, jobId: job.id, status: started.status, job: getJob(job.id) })
})

// 任务列表（最近导入）
app.get('/api/imports', (req, res) => res.json({ jobs: listJobs(20) }))

// 任务详情：进度 + 逐条结果回写
app.get('/api/imports/:id', (req, res) => {
  const detail = getJob(+req.params.id)
  if (!detail) return res.status(404).json({ error: '任务不存在' })
  res.json(detail)
})

// 暂停（状态立即落库，当前块跑完后停在断点）
app.post('/api/imports/:id/pause', (req, res) => {
  const job = pauseJob(+req.params.id)
  if (!job) return res.status(404).json({ error: '任务不存在' })
  res.json({ ok: true, job: getJob(job.id) })
})

// 续跑 / 失败重试：pending 继续，failed 条目重置后续跑；幂等键保证不产生重复数据。
// 请求头 x-clear-injection: 1 为演练用——清除持续故障注入，模拟外部依赖恢复后手动重试。
app.post('/api/imports/:id/resume', (req, res) => {
  const job = resumeJob(+req.params.id, { clearInjection: req.headers['x-clear-injection'] === '1' })
  if (!job) return res.status(404).json({ error: '任务不存在' })
  res.json({ ok: true, job: getJob(job.id) })
})

// 旧版整批接口（同步语义保留）：内部改为创建可恢复任务并等待结束，任一失败返回 207 + 逐条结果
app.post('/api/posts/batch', async (req, res) => {
  const items = req.body && req.body.items
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items 不能为空' })
  if (items.length > 200) return res.status(400).json({ error: '单次最多导入 200 条' })
  const errors = items.map((it, i) => validateItem(it, i)).filter(Boolean)
  if (errors.length) return res.status(400).json({ error: '校验失败，未导入任何数据', details: errors })

  const { job } = createJob({ items, failSeqs: parseFailSeqs(req) })
  resumeJob(job.id)
  let detail
  for (let i = 0; i < 6000; i++) { // 最多等待约 2 分钟
    await new Promise((r) => setTimeout(r, 20))
    detail = getJob(job.id)
    if (['done', 'failed'].includes(detail.job.status)) break
  }
  const results = detail.items.map((it) => it.result || { title: it.payload?.title, error: it.error })
  const fired = results.flatMap((r) => r.triggered || [])
  const body = {
    ok: detail.job.status === 'done',
    jobId: detail.job.id,
    imported: detail.job.total_ok,
    duplicates: detail.job.total_duplicate,
    failed: detail.job.total_failed,
    failures: detail.items.filter((it) => it.status === 'failed').map((it) => ({ seq: it.seq, error: it.error })),
    results,
    summary: {
      alerts: fired.length,
      crisesCreated: fired.filter((t) => t.crisisId && !t.deduped).length,
      crisesMerged: fired.filter((t) => t.deduped).length
    },
    stats: statsSummary()
  }
  res.status(detail.job.status === 'done' ? 200 : 207).json(body)
})

// ===== 热门词 =====
app.post('/api/hotwords', (req, res) => {
  const { word, weight, sentiment = 'neutral' } = req.body
  run('INSERT INTO hot_words (word,weight,sentiment) VALUES (?,?,?)', word, weight, sentiment)
  res.json({ ok: true })
})
app.delete('/api/hotwords/:id', (req, res) => {
  run('DELETE FROM hot_words WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// ===== 预警 =====
app.get('/api/alerts', (req, res) => {
  // 未解除计数按规则 SQL 聚合（触发记录列表仅取最近 60 条，计数不能受其限制）
  const openCounts = {}
  for (const r of q("SELECT alert_id, COUNT(*) c FROM alert_events WHERE status='open' GROUP BY alert_id")) openCounts[r.alert_id] = r.c
  res.json({
    alerts: q('SELECT * FROM alerts ORDER BY id DESC'),
    events: q(`SELECT ae.*, p.title pt, p.heat heat, p.sentiment sent, c.title crisis_title
      FROM alert_events ae LEFT JOIN posts p ON p.id=ae.post_id LEFT JOIN crisis c ON c.id=ae.crisis_id
      ORDER BY ae.id DESC LIMIT 60`),
    openCounts
  })
})
app.post('/api/alerts', (req, res) => {
  const { title, level, keyword, sentiment, heat_min, merge_topic, merge_window } = req.body
  run('INSERT INTO alerts (title,level,keyword,sentiment,heat_min,active,created,trigger_count,merge_topic,merge_window) VALUES (?,?,?,?,?,1,?,0,?,?)',
    title, level, keyword || '', sentiment || '', heat_min || 0, now(), (merge_topic || '').trim(), Math.max(0, +merge_window || 0))
  res.json({ ok: true })
})
// 编辑规则（含归并话题/时间窗口变更）：新参数即时作用于后续触发归并；
// 归并参数变更写入关联未结案事件的统一时间线，历史归并保持不变
app.put('/api/alerts/:id', (req, res) => {
  const al = q1('SELECT * FROM alerts WHERE id=?', req.params.id)
  if (!al) return res.status(404).json({ error: 'not found' })
  const b = req.body || {}
  const next = {
    title: typeof b.title === 'string' && b.title.trim() ? b.title.trim() : al.title,
    level: ['red', 'orange', 'yellow'].includes(b.level) ? b.level : al.level,
    keyword: b.keyword !== undefined ? String(b.keyword).trim() : al.keyword,
    sentiment: b.sentiment !== undefined ? String(b.sentiment) : al.sentiment,
    heat_min: b.heat_min !== undefined ? Math.max(0, +b.heat_min || 0) : al.heat_min,
    merge_topic: b.merge_topic !== undefined ? String(b.merge_topic).trim() : al.merge_topic,
    merge_window: b.merge_window !== undefined ? Math.max(0, parseInt(b.merge_window, 10) || 0) : al.merge_window
  }
  run('UPDATE alerts SET title=?,level=?,keyword=?,sentiment=?,heat_min=?,merge_topic=?,merge_window=? WHERE id=?',
    next.title, next.level, next.keyword, next.sentiment, next.heat_min, next.merge_topic, next.merge_window, al.id)
  if (next.merge_topic !== al.merge_topic || next.merge_window !== al.merge_window) {
    const fmtT = (t) => (t ? `「${t}」` : '取舆情话题')
    const fmtW = (w) => (w > 0 ? `${w} 分钟` : '不限')
    const note = `规则「${next.title}」归并参数调整：话题 ${fmtT(al.merge_topic)}→${fmtT(next.merge_topic)}，时间窗口 ${fmtW(al.merge_window)}→${fmtW(next.merge_window)}（后续触发按新参数归并，历史归并保持不变）`
    const linked = q(`SELECT c.id FROM crisis_alerts ca JOIN crisis c ON c.id=ca.crisis_id WHERE ca.alert_id=? AND c.status!='closed'`, al.id)
    for (const c of linked) addTimeline(c.id, '规则变更', note)
  }
  res.json({ ok: true })
})
app.post('/api/alerts/:id/toggle', (req, res) => {
  const al = q1('SELECT * FROM alerts WHERE id=?', req.params.id)
  if (!al) return res.status(404).json({ error: 'not found' })
  run('UPDATE alerts SET active=? WHERE id=?', al.active ? 0 : 1, al.id)
  res.json({ ok: true, active: al.active ? 0 : 1 })
})
app.delete('/api/alerts/:id', (req, res) => {
  // 保留 alert_events 触发记录（危机回溯/历史时间线的一部分），仅解除事件↔规则关联
  run('DELETE FROM crisis_alerts WHERE alert_id=?', req.params.id)
  run('DELETE FROM alerts WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// 解除单条触发记录：幂等（重复解除不重复写时间线），同步危机时间线，返回该危机剩余未解除数
app.post('/api/alert-events/:id/resolve', (req, res) => {
  const ev = q1('SELECT * FROM alert_events WHERE id=?', req.params.id)
  if (!ev) return res.status(404).json({ error: 'not found' })
  const openLeftOf = (cid) => (cid ? q1("SELECT COUNT(*) c FROM alert_events WHERE crisis_id=? AND status='open'", cid).c : 0)
  if (ev.status === 'resolved') {
    // 重复解除：幂等忽略，不回写时间线，返回当前未解除计数
    return res.json({ ok: true, already: true, crisisId: ev.crisis_id, openLeft: openLeftOf(ev.crisis_id) })
  }
  const note = (req.body.note || '').trim() || '风险指标回落，预警解除'
  const ts = now()
  // 状态守卫：并发/重复提交下仅首次生效
  const r = run("UPDATE alert_events SET status='resolved', resolved=?, resolve_kind='manual' WHERE id=? AND status='open'", ts, ev.id)
  if (!Number(r.changes)) return res.json({ ok: true, already: true, crisisId: ev.crisis_id, openLeft: openLeftOf(ev.crisis_id) })
  let alTitle = '', alLevel = ''
  if (ev.crisis_id) {
    const c = q1('SELECT * FROM crisis WHERE id=?', ev.crisis_id)
    if (c && c.status !== 'closed') {
      const al = q1('SELECT title FROM alerts WHERE id=?', ev.alert_id)
      alTitle = al?.title || ''
      addTimeline(c.id, '预警解除', al ? `规则「${al.title}」：${note}` : note, ts)
    }
  }
  // 通知编排：预警解除（订阅者收解除通报；其他订阅下该事件的待办通知取消）
  const arow = q1('SELECT title,level FROM alerts WHERE id=?', ev.alert_id)
  emit('alert_resolved', {
    alertId: ev.alert_id, alertEventId: ev.id, crisisId: ev.crisis_id,
    level: arow?.level || '', title: arow?.title || alTitle, detail: note, note, time: ts
  })
  res.json({ ok: true, crisisId: ev.crisis_id, openLeft: openLeftOf(ev.crisis_id) })
})

// 批量解除某规则全部未解除触发（按危机合并写入时间线；无未解除时幂等返回 0）
app.post('/api/alerts/:id/resolve', (req, res) => {
  const al = q1('SELECT * FROM alerts WHERE id=?', req.params.id)
  if (!al) return res.status(404).json({ error: 'not found' })
  const events = q("SELECT * FROM alert_events WHERE alert_id=? AND status='open'", al.id)
  if (!events.length) return res.json({ ok: true, resolved: 0 })
  const note = (req.body.note || '').trim() || '风险指标回落，批量解除'
  const ts = now()
  const byCrisis = {}
  db.exec('BEGIN')
  try {
    for (const ev of events) {
      run("UPDATE alert_events SET status='resolved', resolved=?, resolve_kind='batch' WHERE id=? AND status='open'", ts, ev.id)
      if (ev.crisis_id) (byCrisis[ev.crisis_id] ||= []).push(ev)
    }
    for (const [cid, evs] of Object.entries(byCrisis)) {
      const c = q1('SELECT * FROM crisis WHERE id=?', cid)
      if (c && c.status !== 'closed') {
        addTimeline(c.id, '预警解除', `规则「${al.title}」：${note}（一并解除 ${evs.length} 条触发记录）`, ts)
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    return res.status(500).json({ error: String(e.message || e) })
  }
  // 通知编排：逐条发布解除（按触发记录取消对应待办通知并编排解除通报）
  for (const ev of events) {
    emit('alert_resolved', {
      alertId: al.id, alertEventId: ev.id, crisisId: ev.crisis_id,
      level: al.level || '', title: al.title, detail: note, note, time: ts
    })
  }
  res.json({ ok: true, resolved: events.length })
})

// ===== 危机处置 =====
app.get('/api/crisis', (req, res) => {
  res.json(crisisList(true))
})
app.post('/api/crisis', (req, res) => {
  const { title, level, keyword, topic, plan, analysis, linked_email } = req.body
  const r = run("INSERT INTO crisis (title,level,status,plan,analysis,created,updated,linked_email,keyword,origin,topic,last_trigger_at) VALUES (?,?,?,?,?,?,?,?,?,'manual',?,NULL)",
    title, level || 'orange', 'monitoring', plan || '', analysis || '', now(), now(), linked_email || '', keyword || '', (topic || '').trim())
  const id = Number(r.lastInsertRowid)
  const ts = now()
  run('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)', id, '事件建档', '人工建档，初始响应', ts)
  // 通知编排：人工建档事件
  emit('crisis_created', {
    crisisId: id, level: level || 'orange', topic: (topic || '').trim(),
    title, detail: `人工建档危机事件（话题「${(topic || '').trim() || '未分类'}」），当前监测中`, time: ts
  })
  res.json({ ok: true, id })
})
app.post('/api/crisis/:id/status', (req, res) => {
  const { status, action, note } = req.body
  const c = q1('SELECT * FROM crisis WHERE id=?', req.params.id)
  if (!c) return res.status(404).json({ error: 'not found' })
  // 闭环一致性：结案/重开必须走专用链路（级联解除、结案档案、回滚恢复）
  if (status === 'closed') return res.status(400).json({ error: '请使用结案接口（级联解除未解除预警并写入结案档案）' })
  if (c.status === 'closed') return res.status(400).json({ error: '已结案事件请先回滚结案再变更状态' })
  const ts = now()
  run('UPDATE crisis SET status=? WHERE id=?', status || c.status, c.id)
  addTimeline(c.id, action || '状态更新', note || '', ts)
  emit('crisis_status', {
    crisisId: c.id, level: c.level, topic: c.topic, title: c.title,
    detail: note || action || '', extra: { from: c.status, to: status || c.status, note: note || action || '' }, time: ts
  })
  res.json({ ok: true })
})
app.post('/api/crisis/:id/timeline', (req, res) => {
  const { action, note } = req.body
  addTimeline(req.params.id, action, note || '')
  res.json({ ok: true })
})

// 回溯：危机档案 + 承接规则 + 关联预警触发记录（按规则拆分）+ 统计
app.get('/api/crisis/:id/review', (req, res) => {
  const c = q1('SELECT c.*, a.title alert_title FROM crisis c LEFT JOIN alerts a ON a.id=c.alert_id WHERE c.id=?', req.params.id)
  if (!c) return res.status(404).json({ error: 'not found' })
  const timeline = q('SELECT * FROM crisis_timeline WHERE crisis_id=? ORDER BY id DESC', c.id)
  const events = q(`SELECT ae.*, p.title pt, p.heat, p.sentiment sent, a.title alert_title, a.level alert_level
    FROM alert_events ae LEFT JOIN posts p ON p.id=ae.post_id LEFT JOIN alerts a ON a.id=ae.alert_id
    WHERE ae.crisis_id=? ORDER BY ae.id DESC`, c.id)
  const open = events.filter((e) => e.status === 'open').length
  // 按规则拆分触发统计（同一事件承接多条规则时分别统计）
  const rules = q(`SELECT ca.alert_id, ca.is_origin, ca.first_at, ca.last_at,
      al.title alert_title, al.level alert_level,
      (SELECT COUNT(*) FROM alert_events ae WHERE ae.crisis_id=ca.crisis_id AND ae.alert_id=ca.alert_id) triggers,
      (SELECT COUNT(*) FROM alert_events ae WHERE ae.crisis_id=ca.crisis_id AND ae.alert_id=ca.alert_id AND ae.status='open') open
    FROM crisis_alerts ca LEFT JOIN alerts al ON al.id=ca.alert_id
    WHERE ca.crisis_id=? ORDER BY ca.is_origin DESC, ca.alert_id`, c.id)
  // 结案档案（含已回滚）：回溯面板展示结案/回滚历史
  const closures = q('SELECT * FROM crisis_closures WHERE crisis_id=? ORDER BY id DESC', c.id)
  res.json({
    crisis: c, timeline, events, rules, closures,
    stats: {
      triggers: events.length,
      open,
      resolved: events.length - open,
      rules: rules.length,
      posts: new Set(events.map((e) => e.post_id).filter((x) => x != null)).size,
      firstAt: events.length ? events[events.length - 1].time : null,
      lastAt: events.length ? events[0].time : null
    }
  })
})

// 结案：事务化写入结案档案 + 级联解除关联的未解除预警，完成闭环（重复结案幂等）
app.post('/api/crisis/:id/close', (req, res) => {
  const c = q1('SELECT * FROM crisis WHERE id=?', req.params.id)
  if (!c) return res.status(404).json({ error: 'not found' })
  if (c.status === 'closed') return res.json({ ok: true, already: true })
  const summary = (req.body.summary || '').trim() || '预警解除，舆情回落，完成处置闭环。'
  const ts = now()
  const opens = q("SELECT * FROM alert_events WHERE crisis_id=? AND status='open'", c.id)
  let closureId = null
  db.exec('BEGIN')
  try {
    for (const ev of opens) run("UPDATE alert_events SET status='resolved', resolved=?, resolve_kind='close' WHERE id=? AND status='open'", ts, ev.id)
    // 结案档案：记录联动解除清单与结案前状态，供结案回滚精确恢复
    const cr = run('INSERT INTO crisis_closures (crisis_id,summary,resolved_events,prev_status,closed_at) VALUES (?,?,?,?,?)',
      c.id, summary, JSON.stringify(opens.map((e) => e.id)), c.status, ts)
    closureId = Number(cr.lastInsertRowid)
    run("UPDATE crisis SET status='closed' WHERE id=?", c.id)
    // 结案级联解除可能横跨多条规则，记录涉及的规则名
    const auto = opens.length
      ? `（同步解除 ${opens.length} 条未解除预警：${[...new Set(opens.map((e) => e.alert_id))].map((rid) => {
          const al = q1('SELECT title FROM alerts WHERE id=?', rid); return al ? `「${al.title}」` : '已删除规则'
        }).join('、')}）`
      : ''
    addTimeline(c.id, '事件结案', summary + auto, ts)
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    return res.status(500).json({ error: String(e.message || e) })
  }
  // 通知编排：联动解除的预警逐条发布解除，再发布结案通报
  for (const ev of opens) {
    const ar = q1('SELECT title,level FROM alerts WHERE id=?', ev.alert_id)
    emit('alert_resolved', {
      alertId: ev.alert_id, alertEventId: ev.id, crisisId: c.id,
      level: ar?.level || '', title: ar?.title || '预警', detail: '结案联动解除', note: summary, time: ts
    })
  }
  emit('crisis_closed', {
    crisisId: c.id, level: c.level, topic: c.topic, title: c.title,
    detail: summary, note: summary, extra: { from: c.status, to: 'closed' }, time: ts
  })
  res.json({ ok: true, resolved: opens.length, closureId })
})

// 结案回滚：恢复最近一次未回滚结案联动解除的预警为未解除，事件重回结案前状态
app.post('/api/crisis/:id/reopen', (req, res) => {
  const c = q1('SELECT * FROM crisis WHERE id=?', req.params.id)
  if (!c) return res.status(404).json({ error: 'not found' })
  if (c.status !== 'closed') return res.json({ ok: true, already: true, status: c.status })
  const closure = q1('SELECT * FROM crisis_closures WHERE crisis_id=? AND rolled_back=0 ORDER BY id DESC LIMIT 1', c.id)
  const note = (req.body.note || '').trim()
  const ts = now()
  const ST = { monitoring: '监测中', disposal: '处置中' }
  const backTo = closure && closure.prev_status && closure.prev_status !== 'closed' ? closure.prev_status : 'disposal'
  let restored = 0
  db.exec('BEGIN')
  try {
    if (closure) {
      let ids = []
      try { ids = JSON.parse(closure.resolved_events || '[]') } catch { ids = [] }
      for (const id of ids) {
        // 状态守卫：仅恢复仍处解除态的记录（重复回滚/已被其他链路处理时幂等）
        const r = run("UPDATE alert_events SET status='open', resolved=NULL, resolve_kind='' WHERE id=? AND status='resolved'", id)
        restored += Number(r.changes || 0)
      }
      run('UPDATE crisis_closures SET rolled_back=1, rolled_back_at=?, rollback_note=? WHERE id=?', ts, note, closure.id)
    }
    run('UPDATE crisis SET status=? WHERE id=?', backTo, c.id)
    addTimeline(c.id, '结案回滚',
      `结案回滚：事件重回「${ST[backTo] || backTo}」` +
      (closure ? `，恢复 ${restored} 条结案联动解除的预警为未解除` : '（历史结案无回滚档案，仅恢复状态）') +
      (note ? ` · ${note}` : ''), ts)
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    return res.status(500).json({ error: String(e.message || e) })
  }
  emit('crisis_status', {
    crisisId: c.id, level: c.level, topic: c.topic, title: c.title,
    detail: note || '结案回滚，事件重新打开',
    extra: { from: 'closed', to: backTo, note: note || '结案回滚' }, time: ts
  })
  res.json({ ok: true, restored, status: backTo })
})
app.delete('/api/crisis/:id', (req, res) => {
  run('DELETE FROM crisis_alerts WHERE crisis_id=?', req.params.id)
  run('UPDATE alert_events SET crisis_id=NULL WHERE crisis_id=?', req.params.id)
  run('DELETE FROM crisis_timeline WHERE crisis_id=?', req.params.id)
  run('DELETE FROM crisis_closures WHERE crisis_id=?', req.params.id)
  run('DELETE FROM notify_tasks WHERE crisis_id=?', req.params.id) // 通知任务随事件清理
  res.json({ ok: true })
})

// ================= 多渠道订阅与通知编排 =================
const jp = (v, d) => { try { const x = JSON.parse(v); return Array.isArray(x) ? x : d } catch { return d } }

// 当前登录用户（前端顶栏切换角色用）
app.get('/api/notify/me', (req, res) => res.json({ user: req.user }))
app.get('/api/notify/users', (req, res) => {
  res.json({ users: q('SELECT * FROM notify_users ORDER BY id') })
})
app.get('/api/notify/meta', (req, res) => {
  res.json({
    channelTypes: notify.CH_TYPES, eventTypes: notify.EVENT_TYPES,
    channels: q('SELECT * FROM notify_channels ORDER BY id'),
    subscriptions: subList(),
    levels: { red: '红色', orange: '橙色', yellow: '黄色' },
    users: q('SELECT id,name,role FROM notify_users ORDER BY id'),
    summary: notify.notifySummary()
  })
})

// ----- 渠道（admin 配置；operator 可启停/测试/演练失败率） -----
app.get('/api/notify/channels', (req, res) => res.json({ channels: q('SELECT * FROM notify_channels ORDER BY id') }))
app.post('/api/notify/channels', requirePerm('config'), (req, res) => {
  const b = req.body || {}
  if (!b.name || !b.type) return res.status(400).json({ error: '渠道名称与类型必填' })
  if (!notify.CH_TYPES[b.type]) return res.status(400).json({ error: '未知渠道类型' })
  const ts = now()
  const r = run('INSERT INTO notify_channels (name,type,target,enabled,max_per_hour,sim_fail_rate,created) VALUES (?,?,?,?,?,?,?)',
    String(b.name).trim(), b.type, (b.target || '').trim(), b.enabled === 0 ? 0 : 1,
    Math.max(0, +b.max_per_hour || 0), Math.min(100, Math.max(0, +b.sim_fail_rate || 0)), ts)
  res.json({ ok: true, id: Number(r.lastInsertRowid) })
})
app.put('/api/notify/channels/:id', requirePerm('config'), (req, res) => {
  const ch = q1('SELECT * FROM notify_channels WHERE id=?', req.params.id)
  if (!ch) return res.status(404).json({ error: '渠道不存在' })
  const b = req.body || {}
  run('UPDATE notify_channels SET name=?,type=?,target=?,max_per_hour=?,sim_fail_rate=? WHERE id=?',
    b.name !== undefined ? String(b.name).trim() : ch.name,
    notify.CH_TYPES[b.type] ? b.type : ch.type,
    b.target !== undefined ? String(b.target).trim() : ch.target,
    b.max_per_hour !== undefined ? Math.max(0, +b.max_per_hour || 0) : ch.max_per_hour,
    b.sim_fail_rate !== undefined ? Math.min(100, Math.max(0, +b.sim_fail_rate || 0)) : ch.sim_fail_rate,
    ch.id)
  res.json({ ok: true })
})
// 启停 / 演练失败率：operator 可操作（不改核心配置）
app.post('/api/notify/channels/:id/toggle', requirePerm('operate'), (req, res) => {
  const ch = q1('SELECT * FROM notify_channels WHERE id=?', req.params.id)
  if (!ch) return res.status(404).json({ error: '渠道不存在' })
  run('UPDATE notify_channels SET enabled=? WHERE id=?', ch.enabled ? 0 : 1, ch.id)
  res.json({ ok: true, enabled: ch.enabled ? 0 : 1 })
})
app.post('/api/notify/channels/:id/sim-rate', requirePerm('operate'), (req, res) => {
  const rate = Math.min(100, Math.max(0, parseInt(req.body?.rate, 10) || 0))
  run('UPDATE notify_channels SET sim_fail_rate=? WHERE id=?', rate, req.params.id)
  res.json({ ok: true, rate })
})
app.post('/api/notify/channels/:id/test', requirePerm('channelTest'), async (req, res) => {
  const ch = q1('SELECT * FROM notify_channels WHERE id=?', req.params.id)
  if (!ch) return res.status(404).json({ error: '渠道不存在' })
  try {
    const r = await notify.channelSend(ch, { title: '渠道连通性测试', body: `由 ${req.user.name} 发起的测试投递` })
    res.json({ ok: true, ...r })
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message || e) })
  }
})
app.delete('/api/notify/channels/:id', requirePerm('config'), (req, res) => {
  const ch = q1('SELECT * FROM notify_channels WHERE id=?', req.params.id)
  if (!ch) return res.status(404).json({ error: '渠道不存在' })
  const pending = q1("SELECT COUNT(*) c FROM notify_tasks WHERE channel_id=? AND status IN ('pending','sending','paused')", ch.id).c
  if (pending) return res.status(409).json({ error: `该渠道还有 ${pending} 个待发送/暂停任务，请先处理` })
  run('DELETE FROM notify_channels WHERE id=?', ch.id)
  res.json({ ok: true })
})

// ----- 订阅（admin 增删改；operator 可暂停/恢复） -----
function subList() {
  return q('SELECT * FROM notify_subscriptions ORDER BY id DESC').map((s) => ({
    ...s,
    event_types: jp(s.event_types, []),
    alert_ids: jp(s.alert_ids, []),
    channel_ids: jp(s.channel_ids, []),
    escalate_to: jp(s.escalate_to, [])
  }))
}
app.get('/api/notify/subscriptions', (req, res) => res.json({ subscriptions: subList() }))
function normalizeSub(b, cur = {}) {
  const level = ['red', 'orange', 'yellow'].includes(b.min_level) ? b.min_level : (cur.min_level || 'yellow')
  return {
    name: String(b.name ?? cur.name ?? '').trim(),
    owner_id: b.owner_id ? +b.owner_id : (cur.owner_id ?? null),
    event_types: JSON.stringify(Array.isArray(b.event_types) ? b.event_types : jp(cur.event_types, ['alert_fired'])),
    alert_ids: JSON.stringify(Array.isArray(b.alert_ids) ? b.alert_ids.map(Number) : jp(cur.alert_ids, [])),
    topics: String(b.topics ?? cur.topics ?? '').trim(),
    min_level: level,
    crisis_status: String(b.crisis_status ?? cur.crisis_status ?? '').trim(),
    channel_ids: JSON.stringify(Array.isArray(b.channel_ids) ? b.channel_ids.map(Number) : jp(cur.channel_ids, [])),
    ack_timeout_min: Math.max(0, parseInt(b.ack_timeout_min ?? cur.ack_timeout_min ?? 30, 10) || 0),
    escalate_to: JSON.stringify(Array.isArray(b.escalate_to) ? b.escalate_to.map(Number) : jp(cur.escalate_to, [])),
    quiet_start: String(b.quiet_start ?? cur.quiet_start ?? '').trim(),
    quiet_end: String(b.quiet_end ?? cur.quiet_end ?? '').trim()
  }
}
app.post('/api/notify/subscriptions', requirePerm('config'), (req, res) => {
  const v = normalizeSub(req.body || {})
  if (!v.name) return res.status(400).json({ error: '订阅名称必填' })
  if (!jp(v.channel_ids, []).length) return res.status(400).json({ error: '至少选择一个通知渠道' })
  const ts = now()
  const r = run(`INSERT INTO notify_subscriptions
    (name,owner_id,event_types,alert_ids,topics,min_level,crisis_status,channel_ids,ack_timeout_min,escalate_to,quiet_start,quiet_end,active,created,updated)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
    v.name, v.owner_id, v.event_types, v.alert_ids, v.topics, v.min_level, v.crisis_status,
    v.channel_ids, v.ack_timeout_min, v.escalate_to, v.quiet_start, v.quiet_end, ts, ts)
  res.json({ ok: true, id: Number(r.lastInsertRowid) })
})
app.put('/api/notify/subscriptions/:id', requirePerm('config'), (req, res) => {
  const s = q1('SELECT * FROM notify_subscriptions WHERE id=?', req.params.id)
  if (!s) return res.status(404).json({ error: '订阅不存在' })
  const v = normalizeSub(req.body || {}, s)
  if (!v.name) return res.status(400).json({ error: '订阅名称必填' })
  if (!jp(v.channel_ids, []).length) return res.status(400).json({ error: '至少选择一个通知渠道' })
  run(`UPDATE notify_subscriptions SET name=?,owner_id=?,event_types=?,alert_ids=?,topics=?,min_level=?,
    crisis_status=?,channel_ids=?,ack_timeout_min=?,escalate_to=?,quiet_start=?,quiet_end=?,updated=? WHERE id=?`,
    v.name, v.owner_id, v.event_types, v.alert_ids, v.topics, v.min_level, v.crisis_status,
    v.channel_ids, v.ack_timeout_min, v.escalate_to, v.quiet_start, v.quiet_end, now(), s.id)
  res.json({ ok: true })
})
// 暂停/恢复订阅：仅影响后续触发（恢复后不补发），已有任务保持各自状态
app.post('/api/notify/subscriptions/:id/toggle', requirePerm('operate'), (req, res) => {
  const s = q1('SELECT * FROM notify_subscriptions WHERE id=?', req.params.id)
  if (!s) return res.status(404).json({ error: '订阅不存在' })
  const active = s.active ? 0 : 1
  run('UPDATE notify_subscriptions SET active=?, updated=? WHERE id=?', active, now(), s.id)
  res.json({ ok: true, active })
})
app.delete('/api/notify/subscriptions/:id', requirePerm('config'), (req, res) => {
  const s = q1('SELECT * FROM notify_subscriptions WHERE id=?', req.params.id)
  if (!s) return res.status(404).json({ error: '订阅不存在' })
  const pending = q1("SELECT COUNT(*) c FROM notify_tasks WHERE sub_id=? AND status IN ('pending','sending','paused','sent')", s.id).c
  if (pending) return res.status(409).json({ error: `该订阅还有 ${pending} 个在途/待回执任务，请先处理或保留订阅（仅暂停）` })
  run('DELETE FROM notify_task_logs WHERE task_id IN (SELECT id FROM notify_tasks WHERE sub_id=?)', s.id)
  run('DELETE FROM notify_tasks WHERE sub_id=?', s.id)
  run('DELETE FROM notify_subscriptions WHERE id=?', s.id)
  res.json({ ok: true })
})

// ----- 通知任务（发送编排/重试/升级/回执/历史） -----
app.get('/api/notify/tasks', (req, res) => {
  res.json({ tasks: notify.listTasks(req.query), summary: notify.notifySummary() })
})
app.get('/api/notify/tasks/:id', (req, res) => {
  const d = notify.getTask(+req.params.id)
  if (!d) return res.status(404).json({ error: '任务不存在' })
  res.json(d)
})
// 确认回执：viewer 亦可（订阅人确认收到）；可联动解除预警，时间线由引擎同步
app.post('/api/notify/tasks/:id/ack', (req, res) => {
  const d = notify.getTask(+req.params.id)
  if (!d) return res.status(404).json({ error: '任务不存在' })
  if (!['sent', 'escalated', 'sending', 'paused', 'failed'].includes(d.task.status)) {
    return res.status(400).json({ error: `当前状态「${d.task.statusText}」无需确认` })
  }
  try {
    const r = notify.ackTask(d.task.id, {
      note: String(req.body?.note || '').trim(),
      by: req.user.name,
      resolveAlert: !!req.body?.resolve_alert
    })
    res.json(r)
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})
app.post('/api/notify/tasks/:id/pause', requirePerm('operate'), (req, res) => {
  const t = notify.pauseTask(+req.params.id, req.user.name)
  if (!t) return res.status(404).json({ error: '任务不存在' })
  res.json({ ok: true, task: t })
})
app.post('/api/notify/tasks/:id/resume', requirePerm('operate'), (req, res) => {
  const t = notify.resumeTask(+req.params.id, req.user.name)
  if (!t) return res.status(404).json({ error: '任务不存在' })
  res.json({ ok: true, task: t })
})
app.post('/api/notify/tasks/:id/cancel', requirePerm('operate'), (req, res) => {
  const t = notify.cancelTask(+req.params.id, req.user.name)
  if (!t) return res.status(404).json({ error: '任务不存在' })
  res.json({ ok: true, task: t })
})
app.post('/api/notify/tasks/:id/retry', requirePerm('operate'), (req, res) => {
  const t = notify.retryTask(+req.params.id, req.user.name)
  if (!t) return res.status(404).json({ error: '任务不存在' })
  res.json({ ok: true, task: t })
})
app.post('/api/notify/tasks/:id/escalate', requirePerm('operate'), (req, res) => {
  const r = notify.forceEscalate(+req.params.id, req.user.name)
  if (!r) return res.status(404).json({ error: '任务不存在' })
  if (!r.ok) return res.status(400).json({ error: '升级链已到末端（没有更多升级渠道）' })
  res.json({ ok: true })
})
app.delete('/api/notify/tasks/:id', requirePerm('purge'), (req, res) => {
  const t = q1('SELECT * FROM notify_tasks WHERE id=?', req.params.id)
  if (!t) return res.status(404).json({ error: '任务不存在' })
  if (['pending', 'sending'].includes(t.status)) return res.status(409).json({ error: '在途任务请先取消再删除' })
  run('DELETE FROM notify_task_logs WHERE task_id=?', t.id)
  run('DELETE FROM notify_tasks WHERE id=?', t.id)
  res.json({ ok: true })
})
// 历史清理：清空 30 天前已完结任务（admin）
app.post('/api/notify/history/purge', requirePerm('purge'), (req, res) => {
  const days = Math.max(1, +req.body?.days || 30)
  const cutoffMs = Date.now() - days * 86400_000
  const olds = q("SELECT id FROM notify_tasks WHERE status IN ('acked','failed','canceled','escalated')")
    .filter((t) => (parseTimeMs(t.updated) || 0) < cutoffMs)
  for (const t of olds) {
    run('DELETE FROM notify_task_logs WHERE task_id=?', t.id)
    run('DELETE FROM notify_tasks WHERE id=?', t.id)
  }
  res.json({ ok: true, purged: olds.length })
})
app.get('/api/notify/summary', (req, res) => res.json(notify.notifySummary()))

const PORT = Number(process.env.PORT) || 4130
app.listen(PORT, () => console.log(`[PUBMON] API running at http://localhost:${PORT}`))
