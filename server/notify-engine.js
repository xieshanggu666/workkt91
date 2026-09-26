import crypto from 'node:crypto'
import { db, parseTimeMs } from './db.js'
import { addTimeline, LV_RANK } from './pipeline.js'
import { emit, onEvent } from './event-bus.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)
const now = () => new Date().toLocaleString('zh-CN')

// 调度参数（演示用偏短，便于观察重试/升级）
const TICK_MS = 1000
const RETRY_DELAYS = [10_000, 30_000] // 第 1/2 次失败后的退避（达到 max_attempts 转 failed）
const RATE_LIMIT_DEFER_MS = 30_000
const inflight = new Set() // 发送中的任务 id（同任务不并发）

export const CH_TYPES = { email: '邮件', sms: '短信', wecom: '企业微信', dingtalk: '钉钉', webhook: 'Webhook' }
export const EVENT_TYPES = {
  alert_fired: '预警触发', alert_resolved: '预警解除',
  crisis_created: '危机建档', crisis_status: '危机状态流转', crisis_closed: '危机结案'
}
export const TASK_STATUS_TEXT = {
  pending: '待发送', sending: '发送中', sent: '已送达', acked: '已回执',
  failed: '发送失败', escalated: '已升级', canceled: '已取消', paused: '已暂停'
}
const ST_MONITOR = { monitoring: '监测中', disposal: '处置中', closed: '已结案' }
const LV_TEXT = { red: '红色', orange: '橙色', yellow: '黄色' }

const safeJson = (s, d) => { try { const v = JSON.parse(s); return v ?? d } catch { return d } }

// ---------- mock 渠道投递（演示：无真实外部依赖；渠道可配失败率演练重试/升级） ----------
const FAIL_MSG = {
  email: 'SMTP 554 发送被拒', sms: '短信网关响应超时',
  wecom: '机器人 webhook 返回 errcode=45009（接口超频）',
  dingtalk: '钉钉接口返回 errcode=130101（频率限制）', webhook: 'HTTP 502 Bad Gateway'
}
export function channelSend(channel, task) {
  const latency = 120 + Math.round(Math.random() * 220)
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (channel.sim_fail_rate > 0 && Math.random() * 100 < channel.sim_fail_rate) {
        return reject(new Error(FAIL_MSG[channel.type] || '渠道返回失败'))
      }
      resolve({ providerMsgId: crypto.randomUUID().slice(0, 8), latency })
    }, latency)
  })
}

// ---------- 订阅匹配 ----------
function levelOk(minLevel, eventLevel) {
  return (LV_RANK[eventLevel] || 0) >= (LV_RANK[minLevel] || 0)
}
function inQuiet(sub, d = new Date()) {
  if (!sub.quiet_start || !sub.quiet_end) return false
  const toMin = (h) => { const [H, M] = String(h).split(':').map(Number); return H * 60 + M }
  const cur = d.getHours() * 60 + d.getMinutes()
  const s = toMin(sub.quiet_start), e = toMin(sub.quiet_end)
  return s === e ? false : s < e ? (cur >= s && cur < e) : (cur >= s || cur < e) // 跨夜
}
function topicOk(sub, topic) {
  const wants = String(sub.topics || '').split(',').map((t) => t.trim()).filter(Boolean)
  if (!wants.length) return true
  return !!topic && wants.some((w) => topic === w || topic.includes(w) || w.includes(topic))
}
function subMatches(sub, ev) {
  const types = safeJson(sub.event_types, [])
  if (!types.includes(ev.type)) return false
  if (!levelOk(sub.min_level, ev.level || 'yellow')) return false
  if (!topicOk(sub, ev.topic)) return false
  const alertIds = safeJson(sub.alert_ids, [])
  if (alertIds.length && (!ev.alertId || !alertIds.includes(ev.alertId))) return false
  // crisis_status 过滤仅对危机类事件生效
  if (sub.crisis_status && ev.type.startsWith('crisis_')) {
    const st = ev.extra?.toStatus || ev.extra?.status
    if (st && st !== sub.crisis_status) return false
  }
  return true
}

// ---------- 消息内容编排 ----------
function compose(ev) {
  const lv = ev.level ? `【${LV_TEXT[ev.level] || ''}预警】` : ''
  switch (ev.type) {
    case 'alert_fired':
      return { title: `${lv}${ev.title || '预警触发'}`, body: ev.detail || '' }
    case 'alert_resolved':
      return { title: `【预警解除】${ev.title || ''}`, body: ev.detail || ev.note || '' }
    case 'crisis_created':
      return { title: `【危机建档】${ev.title || ''}`, body: ev.detail || '' }
    case 'crisis_status': {
      const f = ST_MONITOR[ev.extra?.from] || ev.extra?.from || ''
      const t = ST_MONITOR[ev.extra?.to] || ev.extra?.to || ''
      return { title: `【危机状态流转】${ev.title || ''}：${f}→${t}`, body: ev.extra?.note || ev.detail || '' }
    }
    case 'crisis_closed':
      return { title: `【危机结案】${ev.title || ''}`, body: ev.detail || ev.note || '' }
    default:
      return { title: ev.title || ev.type, body: ev.detail || '' }
  }
}

// ---------- 编排：事件 → 命中订阅 → 按渠道生成任务 ----------
function refId(ev) {
  if (ev.type === 'alert_fired' || ev.type === 'alert_resolved') return `ae${ev.alertEventId}`
  return `c${ev.crisisId}${ev.type === 'crisis_status' ? `:${ev.extra?.from || ''}-${ev.extra?.to || ''}` : ''}`
}

function orchestrate(ev) {
  const subs = q('SELECT * FROM notify_subscriptions WHERE active=1')
  const { title, body } = compose(ev)
  const ts = now()
  for (const sub of subs) {
    if (!subMatches(sub, ev)) continue
    const channelIds = safeJson(sub.channel_ids, [])
    if (!channelIds.length) continue
    const batchKey = `sub${sub.id}:${ev.type}:${refId(ev)}`
    if (q1('SELECT 1 FROM notify_tasks WHERE batch_key=? LIMIT 1', batchKey)) continue // 编排幂等
    const quiet = inQuiet(sub)
    db.exec('BEGIN')
    try {
      for (const chId of channelIds) {
        const ch = q1('SELECT * FROM notify_channels WHERE id=?', chId)
        const r = run(`INSERT INTO notify_tasks
          (batch_key,sub_id,channel_id,event_type,alert_event_id,crisis_id,level,title,body,target,
           status,max_attempts,paused_reason,created,updated)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          batchKey, sub.id, chId, ev.type, ev.alertEventId || null, ev.crisisId || null,
          ev.level || '', title, body, ch ? ch.target : '',
          quiet ? 'paused' : 'pending', 3,
          quiet ? `quiet:${sub.quiet_start}-${sub.quiet_end}` : '', ts, ts)
        const id = Number(r.lastInsertRowid)
        run('INSERT INTO notify_task_logs (task_id,action,note,by,time) VALUES (?,?,?,?,?)',
          id, 'created',
          `命中订阅「${sub.name}」，编排至 ${CH_TYPES[ch?.type] || '未知渠道'}「${ch?.name || '已删除渠道'}」` +
          (quiet ? `；当前处于静默时段 ${sub.quiet_start}–${sub.quiet_end}，已暂存` : ''),
          '系统', ts)
      }
      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
      console.error('[NOTIFY] orchestrate failed:', e?.message || e)
    }
  }
}

// 业务事件反向同步：预警解除/危机结案 → 取消尚未发出的待办通知（已送达的保留留痕）
function cancelPending(ev) {
  const where = ev.type === 'alert_resolved' ? 'alert_event_id=?' : 'crisis_id=?'
  const arg = ev.type === 'alert_resolved' ? ev.alertEventId : ev.crisisId
  const reason = ev.type === 'alert_resolved' ? '关联预警已解除' : '关联危机已结案'
  const rows = q(`SELECT * FROM notify_tasks WHERE ${where} AND status IN ('pending','paused','sending')`, arg)
  const ts = now()
  for (const t of rows) {
    // 仅取消同类事件（结案取消的是历史待办，不影响本次「结案通知」自身——其 batch 事件不同）
    if (ev.type === 'crisis_closed' && t.event_type === 'crisis_closed') continue
    run("UPDATE notify_tasks SET status='canceled', paused_reason='', done_at=?, updated=? WHERE id=? AND status IN ('pending','paused','sending')", ts, ts, t.id)
    run('INSERT INTO notify_task_logs (task_id,action,note,by,time) VALUES (?,?,?,?,?)', t.id, 'cancel', `${reason}，待办通知取消`, '系统', ts)
  }
}

function handleEvent(ev) {
  // 解除/结案先取消待办，再按订阅编排「解除/结案通知」本身
  if (ev.type === 'alert_resolved' || ev.type === 'crisis_closed') cancelPending(ev)
  orchestrate(ev)
}

// ---------- 升级链 ----------
function chainOf(sub) {
  return { channels: safeJson(sub.channel_ids, []), escalate: safeJson(sub.escalate_to, []) }
}
function escalate(task, sub, trigger) {
  const { escalate } = chainOf(sub)
  const nextLevel = task.escalate_level + 1
  const nextChId = escalate[task.escalate_level] // level0 超时 → escalate[0]
  if (!nextChId) return false
  // 同批次同级别升级任务已存在（多并行渠道之一已触发）：仅把自己标记为已升级
  const existing = q1('SELECT id FROM notify_tasks WHERE batch_key=? AND escalate_level=?', task.batch_key, nextLevel)
  const ts = now()
  run("UPDATE notify_tasks SET status='escalated', done_at=?, updated=? WHERE id=?", ts, ts, task.id)
  run('INSERT INTO notify_task_logs (task_id,action,note,by,time) VALUES (?,?,?,?,?)',
    task.id, 'escalate',
    trigger === 'failed'
      ? `渠道连续 ${task.attempts} 次发送失败，升级至第 ${nextLevel} 级通知渠道`
      : `超过确认时限（${sub.ack_timeout_min} 分钟）未收到回执，升级至第 ${nextLevel} 级通知渠道`,
    '系统', ts)
  if (!existing) {
    const ch = q1('SELECT * FROM notify_channels WHERE id=?', nextChId)
    const r = run(`INSERT INTO notify_tasks
      (batch_key,sub_id,channel_id,event_type,alert_event_id,crisis_id,level,title,body,target,
       status,max_attempts,escalate_from,escalate_level,created,updated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      task.batch_key, sub.id, nextChId, task.event_type, task.alert_event_id, task.crisis_id,
      task.level, task.title, task.body, ch ? ch.target : '',
      'pending', 3, task.id, nextLevel, ts, ts)
    const newId = Number(r.lastInsertRowid)
    run('INSERT INTO notify_task_logs (task_id,action,note,by,time) VALUES (?,?,?,?,?)',
      newId, 'created',
      `第 ${nextLevel} 级升级通知（来源任务 #${task.id}，${trigger === 'failed' ? '原渠道发送失败' : '回执超时'}）→ ${CH_TYPES[ch?.type] || '未知渠道'}「${ch?.name || '已删除渠道'}」，跳过静默限制`,
      '系统', ts)
  }
  return true
}

// ---------- 回执确认：批次级幂等，同步危机时间线，可联动解除预警 ----------
export function ackTask(taskId, { note = '', by = '', resolveAlert = false } = {}) {
  const primary = q1('SELECT * FROM notify_tasks WHERE id=?', taskId)
  if (!primary) return { error: '任务不存在' }
  if (primary.status === 'acked') return { ok: true, already: true }
  const ts = now()
  const siblings = q('SELECT * FROM notify_tasks WHERE batch_key=?', primary.batch_key)
  const sub = q1('SELECT * FROM notify_subscriptions WHERE id=?', primary.sub_id)
  const chName = (id) => { const c = q1('SELECT name FROM notify_channels WHERE id=?', id); return c?.name || '已删除渠道' }

  let resolvedEvent = null, crisisTimelineWritten = false
  db.exec('BEGIN')
  try {
    for (const t of siblings) {
      if (t.status === 'acked' || t.status === 'canceled') continue
      if (['sent', 'escalated', 'sending', 'paused', 'failed'].includes(t.status)) {
        run("UPDATE notify_tasks SET status='acked', acked_at=?, acked_by=?, ack_note=?, ack_resolve_alert=?, done_at=COALESCE(done_at,?), updated=? WHERE id=?",
          ts, by, note, resolveAlert ? 1 : 0, ts, ts, t.id)
        run('INSERT INTO notify_task_logs (task_id,action,note,by,time) VALUES (?,?,?,?,?)',
          t.id, 'ack', `确认回执（批次统一确认 · 经 ${chName(primary.channel_id)} 回执）${note ? '：' + note : ''}`, by, ts)
      } else if (t.status === 'pending') {
        run("UPDATE notify_tasks SET status='canceled', done_at=?, updated=? WHERE id=?", ts, ts, t.id)
        run('INSERT INTO notify_task_logs (task_id,action,note,by,time) VALUES (?,?,?,?,?)',
          t.id, 'cancel', '同批次已有渠道确认回执，未发出的通知取消', '系统', ts)
      }
    }
    // 回执同步危机时间线（一个批次仅写一条）
    if (primary.crisis_id) {
      const c = q1('SELECT id,status FROM crisis WHERE id=?', primary.crisis_id)
      if (c) {
        addTimeline(c.id, '通知确认',
          `通知回执：${EVENT_TYPES[primary.event_type] || primary.event_type}「${primary.title}」经 ${chName(primary.channel_id)} 确认` +
          (by ? `（确认人：${by}）` : '') + (note ? `。${note}` : ''), ts)
        crisisTimelineWritten = true
      }
    }
    // 回执联动解除预警（幂等守卫：仅 open 生效，resolve_kind='ack'），并同步危机时间线
    if (resolveAlert && primary.alert_event_id) {
      const ev = q1('SELECT * FROM alert_events WHERE id=?', primary.alert_event_id)
      if (ev && ev.status === 'open') {
        const rr = run("UPDATE alert_events SET status='resolved', resolved=?, resolve_kind='ack' WHERE id=? AND status='open'", ts, ev.id)
        if (Number(rr.changes)) {
          resolvedEvent = ev
          if (ev.crisis_id) {
            const al = q1('SELECT title FROM alerts WHERE id=?', ev.alert_id)
            addTimeline(ev.crisis_id, '预警解除',
              `规则「${al?.title || ev.alert_id}」：经通知回执联动解除${note ? '（' + note + '）' : ''}`, ts)
          }
        }
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  // 事务后发事件：通知其他订阅者「预警已解除」，并取消其他订阅下该事件的待办
  if (resolvedEvent) {
    const al = q1('SELECT title,level FROM alerts WHERE id=?', resolvedEvent.alert_id)
    emit('alert_resolved', {
      alertId: resolvedEvent.alert_id, alertEventId: resolvedEvent.id,
      crisisId: resolvedEvent.crisis_id, level: al?.level || '',
      title: al?.title || '预警', detail: '经通知回执联动解除', time: ts
    })
  }
  return { ok: true, resolvedAlert: !!resolvedEvent, crisisTimelineWritten, crisisId: primary.crisis_id }
}

// ---------- 暂停 / 恢复 / 取消 / 手动重试 ----------
export function pauseTask(id, by) {
  const t = q1('SELECT * FROM notify_tasks WHERE id=?', id)
  if (!t) return null
  if (!['pending'].includes(t.status)) return t
  run("UPDATE notify_tasks SET status='paused', paused_reason='manual', updated=? WHERE id=?", now(), id)
  run("INSERT INTO notify_task_logs (task_id,action,note,by,time) VALUES (?,?,?,?,?)", id, 'pause', '手动暂停通知任务', by, now())
  return q1('SELECT * FROM notify_tasks WHERE id=?', id)
}
export function resumeTask(id, by) {
  const t = q1('SELECT * FROM notify_tasks WHERE id=?', id)
  if (!t) return null
  if (!['paused'].includes(t.status)) return t
  run("UPDATE notify_tasks SET status='pending', paused_reason='', next_retry_at=?, updated=? WHERE id=?", Date.now(), now(), id)
  run("INSERT INTO notify_task_logs (task_id,action,note,by,time) VALUES (?,?,?,?,?)", id, 'resume', '手动恢复通知任务', by, now())
  return q1('SELECT * FROM notify_tasks WHERE id=?', id)
}
export function cancelTask(id, by) {
  const t = q1('SELECT * FROM notify_tasks WHERE id=?', id)
  if (!t) return null
  if (['acked', 'canceled'].includes(t.status)) return t
  run("UPDATE notify_tasks SET status='canceled', paused_reason='', done_at=?, updated=? WHERE id=?", now(), now(), id)
  run("INSERT INTO notify_task_logs (task_id,action,note,by,time) VALUES (?,?,?,?,?)", id, 'cancel', '人工取消通知任务', by, now())
  return q1('SELECT * FROM notify_tasks WHERE id=?', id)
}
export function retryTask(id, by) {
  const t = q1('SELECT * FROM notify_tasks WHERE id=?', id)
  if (!t) return null
  if (!['failed', 'canceled'].includes(t.status)) return t
  run("UPDATE notify_tasks SET status='pending', attempts=0, last_error='', next_retry_at=?, done_at=NULL, updated=? WHERE id=?", Date.now(), now(), id)
  run("INSERT INTO notify_task_logs (task_id,action,note,by,time) VALUES (?,?,?,?,?)", id, 'retry', '手动重试（重置发送计数）', by, now())
  return q1('SELECT * FROM notify_tasks WHERE id=?', id)
}
// 演练/应急：立即触发一次升级（不等确认超时）
export function forceEscalate(id, by) {
  const t = q1('SELECT * FROM notify_tasks WHERE id=?', id)
  if (!t) return null
  const sub = q1('SELECT * FROM notify_subscriptions WHERE id=?', t.sub_id)
  if (!sub) return null
  const ok = escalate(t, sub, t.status === 'failed' ? 'failed' : 'timeout')
  return { ok, task: q1('SELECT * FROM notify_tasks WHERE id=?', id) }
}

// ---------- 调度器 ----------
function channelHourlyCount(channelId) {
  // 以 sent_at 落在近 1 小时内的任务数计速（演示口径）
  const cutoff = Date.now() - 3600_000
  return q('SELECT sent_at FROM notify_tasks WHERE channel_id=? AND sent_at IS NOT NULL', channelId)
    .filter((r) => (parseTimeMs(r.sent_at) || 0) >= cutoff).length
}

async function sendOne(task, sub) {
  const ch = q1('SELECT * FROM notify_channels WHERE id=?', task.channel_id)
  if (!ch || !ch.enabled) return // 渠道缺失/停用：保留 pending，启用后自动发出
  run("UPDATE notify_tasks SET status='sending', updated=? WHERE id=? AND status='pending'", now(), task.id)
  let res
  try { res = await channelSend(ch, task) } catch (e) {
    const attempts = task.attempts + 1
    run("INSERT INTO notify_task_logs (task_id,action,note,by,time) VALUES (?,?,?,?,?)",
      task.id, 'send_fail', `${e.message || e}（第 ${attempts} 次）`, '', now())
    run('UPDATE notify_channels SET sent_fail=sent_fail+1 WHERE id=?', ch.id)
    if (attempts >= task.max_attempts) {
      run("UPDATE notify_tasks SET status='failed', attempts=?, last_error=?, done_at=?, updated=? WHERE id=?",
        attempts, String(e.message || e), now(), now(), task.id)
      const fresh = q1('SELECT * FROM notify_tasks WHERE id=?', task.id)
      if (sub) escalate(fresh, sub, 'failed') // 发送失败也升级
    } else {
      const delay = RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)]
      run("UPDATE notify_tasks SET status='pending', attempts=?, last_error=?, next_retry_at=?, updated=? WHERE id=?",
        attempts, String(e.message || e), Date.now() + delay, now(), task.id)
      run("INSERT INTO notify_task_logs (task_id,action,note,by,time) VALUES (?,?,?,?,?)",
        task.id, 'retry', `${Math.round(delay / 1000)} 秒后自动退避重试`, '', now())
    }
    return
  }
  // 发送成功：设确认时限（升级链上还有下一级时才需要超时升级）
  const { escalate } = chainOf(sub || { escalate_to: '[]' })
  let deadline = null
  if (sub && sub.ack_timeout_min > 0 && escalate.length > task.escalate_level) {
    deadline = Date.now() + sub.ack_timeout_min * 60000
  }
  const ts = now()
  run("UPDATE notify_tasks SET status='sent', attempts=attempts+1, last_error='', sent_at=?, ack_deadline=?, next_retry_at=NULL, done_at=NULL, updated=? WHERE id=?",
    ts, deadline, ts, task.id)
  run('UPDATE notify_channels SET sent_ok=sent_ok+1 WHERE id=?', ch.id)
  run("INSERT INTO notify_task_logs (task_id,action,note,by,time) VALUES (?,?,?,?,?)",
    task.id, 'send_ok', `渠道回执：投递成功（provider=${res.providerMsgId}，耗时 ${res.latency}ms）${deadline ? `；需在 ${sub.ack_timeout_min} 分钟内确认，否则自动升级` : ''}`, '', ts)
}

function tick() {
  try {
    // 1) 静默暂存任务：离开静默窗口后自动恢复
    for (const t of q("SELECT * FROM notify_tasks WHERE status='paused' AND paused_reason LIKE 'quiet:%'")) {
      const sub = q1('SELECT * FROM notify_subscriptions WHERE id=?', t.sub_id)
      if (sub && !inQuiet(sub)) {
        run("UPDATE notify_tasks SET status='pending', paused_reason='', next_retry_at=?, updated=? WHERE id=?", Date.now(), now(), t.id)
        run("INSERT INTO notify_task_logs (task_id,action,note,by,time) VALUES (?,?,?,?,?)",
          t.id, 'resume', '静默时段结束，自动恢复发送', '系统', now())
      }
    }
    // 2) 到期待发送
    const due = q("SELECT * FROM notify_tasks WHERE status='pending' AND (next_retry_at IS NULL OR next_retry_at<=?) ORDER BY id ASC LIMIT 5", Date.now())
    for (const t of due) {
      if (inflight.has(t.id)) continue
      // 批次已被确认/取消：惰性收尾
      const acked = q1("SELECT 1 FROM notify_tasks WHERE batch_key=? AND status='acked' LIMIT 1", t.batch_key)
      if (acked) {
        run("UPDATE notify_tasks SET status='canceled', done_at=?, updated=? WHERE id=? AND status='pending'", now(), now(), t.id)
        run("INSERT INTO notify_task_logs (task_id,action,note,by,time) VALUES (?,?,?,?,?)", t.id, 'cancel', '同批次已确认回执', '系统', now())
        continue
      }
      const sub = q1('SELECT * FROM notify_subscriptions WHERE id=?', t.sub_id)
      if (sub && !sub.active) continue // 订阅暂停期间：任务挂起不发送
      const ch = q1('SELECT * FROM notify_channels WHERE id=?', t.channel_id)
      if (!ch || !ch.enabled) continue
      if (ch.max_per_hour > 0 && channelHourlyCount(ch.id) >= ch.max_per_hour) {
        run("UPDATE notify_tasks SET next_retry_at=?, updated=? WHERE id=? AND status='pending'",
          Date.now() + RATE_LIMIT_DEFER_MS, now(), t.id)
        run("INSERT OR IGNORE INTO notify_task_logs (task_id,action,note,by,time) VALUES (?,?,?,?,?)",
          t.id, 'retry', `渠道「${ch.name}」达到每小时 ${ch.max_per_hour} 条限速，30 秒后再试`, '系统', now())
        continue
      }
      inflight.add(t.id)
      Promise.resolve(sendOne(t, sub)).catch((e) => {
        run("UPDATE notify_tasks SET status='pending', last_error=?, next_retry_at=?, updated=? WHERE id=? AND status='sending'",
          String(e.message || e), Date.now() + 5000, now(), t.id)
      }).finally(() => inflight.delete(t.id))
    }
    // 3) 确认超时升级（已送达、有时限、未回执、批次尚未产生下一级升级任务）
    const waiting = q("SELECT * FROM notify_tasks WHERE status='sent' AND ack_deadline IS NOT NULL AND ack_deadline<?", Date.now())
    for (const t of waiting) {
      const sub = q1('SELECT * FROM notify_subscriptions WHERE id=?', t.sub_id)
      if (!sub) continue
      const nextLevel = t.escalate_level + 1
      const exists = q1('SELECT 1 FROM notify_tasks WHERE batch_key=? AND escalate_level=?', t.batch_key, nextLevel)
      if (exists) { run("UPDATE notify_tasks SET status='escalated', updated=? WHERE id=?", now(), t.id); continue }
      escalate(t, sub, 'timeout')
    }
  } catch (e) {
    console.error('[NOTIFY] tick error:', e?.message || e)
  }
}

// ---------- 启动恢复 + 注册事件 ----------
let timer = null
export function initNotify() {
  // 崩溃恢复：发送中中断的任务回到待发送（已成功/失败状态不丢）
  const n = run("UPDATE notify_tasks SET status='pending', next_retry_at=?, updated=? WHERE status='sending'", Date.now(), now()).changes
  if (n) console.log(`[NOTIFY] 恢复 ${n} 个发送中断的通知任务（待重新发送）`)
  onEvent('alert_fired', handleEvent)
  onEvent('alert_resolved', handleEvent)
  onEvent('crisis_created', handleEvent)
  onEvent('crisis_status', handleEvent)
  onEvent('crisis_closed', handleEvent)
  if (!timer) timer = setInterval(tick, TICK_MS)
  return { recovered: n }
}

// ---------- 查询：历史追踪 ----------
export function listTasks(f = {}) {
  let sql = `SELECT t.*, c.name channel_name, c.type channel_type, s.name sub_name, u.name owner_name,
      cr.title crisis_title
    FROM notify_tasks t
    LEFT JOIN notify_channels c ON c.id=t.channel_id
    LEFT JOIN notify_subscriptions s ON s.id=t.sub_id
    LEFT JOIN notify_users u ON u.id=s.owner_id
    LEFT JOIN crisis cr ON cr.id=t.crisis_id WHERE 1=1`
  const args = []
  if (f.status && f.status !== 'all') { args.push(f.status); sql += ' AND t.status=?' }
  if (f.channel_id) { args.push(+f.channel_id); sql += ' AND t.channel_id=?' }
  if (f.sub_id) { args.push(+f.sub_id); sql += ' AND t.sub_id=?' }
  if (f.event_type) { args.push(f.event_type); sql += ' AND t.event_type=?' }
  if (f.crisis_id) { args.push(+f.crisis_id); sql += ' AND t.crisis_id=?' }
  if (f.q) { args.push(`%${f.q}%`); sql += ' AND (t.title LIKE ? OR t.body LIKE ?)' ; args.push(`%${f.q}%`) }
  sql += ' ORDER BY t.id DESC LIMIT 200'
  return db.prepare(sql).all(...args).map((t) => ({ ...t, statusText: TASK_STATUS_TEXT[t.status] || t.status }))
}
export function getTask(id) {
  const t = q1(`SELECT t.*, c.name channel_name, c.type channel_type, s.name sub_name
    FROM notify_tasks t LEFT JOIN notify_channels c ON c.id=t.channel_id
    LEFT JOIN notify_subscriptions s ON s.id=t.sub_id WHERE t.id=?`, id)
  if (!t) return null
  const logs = q('SELECT * FROM notify_task_logs WHERE task_id=? ORDER BY id ASC', id)
  const siblings = q(`SELECT t.id,t.status,t.channel_id,c.name channel_name,c.type channel_type,t.escalate_level,t.escalate_from
    FROM notify_tasks t LEFT JOIN notify_channels c ON c.id=t.channel_id
    WHERE t.batch_key=? AND t.id!=? ORDER BY t.id`, t.batch_key, id)
  return { task: { ...t, statusText: TASK_STATUS_TEXT[t.status] || t.status }, logs, siblings }
}
export function notifySummary() {
  const byStatus = {}
  for (const r of q('SELECT status, COUNT(*) c FROM notify_tasks GROUP BY status')) byStatus[r.status] = r.c
  const nowMs = Date.now()
  const overdue = q1("SELECT COUNT(*) c FROM notify_tasks WHERE status='sent' AND ack_deadline IS NOT NULL AND ack_deadline<?", nowMs).c
  const awaiting = q1("SELECT COUNT(*) c FROM notify_tasks WHERE status='sent' AND (ack_deadline IS NULL OR ack_deadline>=?)", nowMs).c
  const dayAgo = nowMs - 86400_000
  const sent24 = q('SELECT sent_at FROM notify_tasks WHERE sent_at IS NOT NULL').filter((r) => (parseTimeMs(r.sent_at) || 0) >= dayAgo).length
  return {
    pending: byStatus.pending || 0, sending: byStatus.sending || 0,
    sent: byStatus.sent || 0, acked: byStatus.acked || 0, failed: byStatus.failed || 0,
    escalated: byStatus.escalated || 0, canceled: byStatus.canceled || 0, paused: byStatus.paused || 0,
    awaitingAck: awaiting, overdueAck: overdue, sent24
  }
}
