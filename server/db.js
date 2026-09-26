import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const db = new DatabaseSync(process.env.PUBMON_DB || path.join(__dirname, 'pubmon.db'))

db.exec('PRAGMA foreign_keys = ON;')

db.exec(`
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  sentiment TEXT NOT NULL,        -- positive/neutral/negative
  sentiment_score REAL NOT NULL,  -- -1..1
  heat INTEGER NOT NULL,          -- 热度 0-100
  hot INTEGER NOT NULL DEFAULT 0,
  topic TEXT NOT NULL,
  media TEXT NOT NULL DEFAULT '',
  published TEXT NOT NULL,
  created TEXT NOT NULL,
  idem_key TEXT                   -- 条目幂等键（导入任务重试/断点续传去重，手工录入为 NULL）
);
CREATE TABLE IF NOT EXISTS hot_words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL,
  weight INTEGER NOT NULL,
  sentiment TEXT NOT NULL DEFAULT 'neutral'
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  level TEXT NOT NULL,            -- red/orange/yellow
  keyword TEXT NOT NULL DEFAULT '',
  sentiment TEXT NOT NULL DEFAULT '',
  heat_min INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created TEXT NOT NULL,
  trigger_count INTEGER NOT NULL DEFAULT 0,
  merge_topic TEXT NOT NULL DEFAULT '',   -- 危机归并话题（空=以命中舆情的话题为准）
  merge_window INTEGER NOT NULL DEFAULT 0 -- 归并时间窗口（分钟，0=不限时长）
);
CREATE TABLE IF NOT EXISTS alert_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER NOT NULL,
  post_id INTEGER,
  crisis_id INTEGER,              -- 关联危机事件（高等级预警自动建档/并入）
  detail TEXT NOT NULL,
  time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',  -- open/resolved（预警是否解除）
  resolved TEXT,                -- 解除时间
  resolve_kind TEXT NOT NULL DEFAULT '' -- 解除途径：manual/batch/close/notify（空=历史数据）
);
CREATE TABLE IF NOT EXISTS crisis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  level TEXT NOT NULL,
  status TEXT NOT NULL,           -- monitoring/disposal/closed
  plan TEXT NOT NULL DEFAULT '',
  analysis TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  linked_email TEXT NOT NULL DEFAULT '',
  keyword TEXT NOT NULL DEFAULT '',
  alert_id INTEGER,               -- 来源预警规则（自动建档时写入）
  origin TEXT NOT NULL DEFAULT 'manual',  -- auto/manual
  topic TEXT NOT NULL DEFAULT '',  -- 归并话题键（同一话题+窗口内的预警触发并入同一事件）
  last_trigger_at INTEGER          -- 最近预警触发毫秒时间戳（时间窗口归并判断依据）
);
CREATE TABLE IF NOT EXISTS crisis_alerts (
  crisis_id INTEGER NOT NULL,
  alert_id INTEGER NOT NULL,       -- 同一事件可承接多条规则（多对多）
  is_origin INTEGER NOT NULL DEFAULT 0,  -- 1=触发建档的来源规则
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  PRIMARY KEY (crisis_id, alert_id)
);
CREATE TABLE IF NOT EXISTS crisis_timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crisis_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  time TEXT NOT NULL
);
-- 结案档案：每次结案一行，记录联动解除的预警清单与结案前状态，支撑结案回滚精确恢复
CREATE TABLE IF NOT EXISTS crisis_closures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crisis_id INTEGER NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  resolved_events TEXT NOT NULL DEFAULT '[]',  -- 结案联动解除的 alert_event id 列表（JSON）
  prev_status TEXT NOT NULL DEFAULT 'disposal', -- 结案前状态（回滚恢复目标）
  closed_at TEXT NOT NULL,
  rolled_back INTEGER NOT NULL DEFAULT 0,
  rolled_back_at TEXT,
  rollback_note TEXT NOT NULL DEFAULT ''
);
-- 通知渠道配置：webhook/邮件/短信/站内信，target 为推送地址（演示用模拟发送）
CREATE TABLE IF NOT EXISTS notify_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'webhook', -- webhook/email/sms/inapp
  target TEXT NOT NULL DEFAULT '',      -- 推送地址/邮箱/号码
  enabled INTEGER NOT NULL DEFAULT 1,
  created TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT ''
);
-- 订阅编排：按预警规则/话题/危机状态匹配，多渠道并行推送，可要求回执并配置超时升级
CREATE TABLE IF NOT EXISTS notify_subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  alert_id INTEGER,                     -- 限定预警规则（NULL=不限）
  topic TEXT NOT NULL DEFAULT '',       -- 限定话题（空=不限）
  crisis_status TEXT NOT NULL DEFAULT '', -- 订阅危机状态流转（空=预警订阅；monitoring/disposal/closed）
  levels TEXT NOT NULL DEFAULT '',      -- 限定预警级别（空=不限；逗号分隔 red,orange,yellow）
  channel_ids TEXT NOT NULL DEFAULT '[]', -- 通知渠道 id 列表（JSON 数组）
  require_ack INTEGER NOT NULL DEFAULT 0, -- 是否需要确认回执
  ack_timeout_min INTEGER NOT NULL DEFAULT 30, -- 回执超时（分钟），超时未确认自动升级
  escalate_channel_id INTEGER,          -- 升级渠道（空=沿用原渠道）
  max_retry INTEGER NOT NULL DEFAULT 3, -- 发送失败自动重试上限
  active INTEGER NOT NULL DEFAULT 1,
  created TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT ''
);
-- 通知任务：由订阅匹配生成（幂等键去重），状态机驱动发送/重试/暂停/回执/升级
CREATE TABLE IF NOT EXISTS notify_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idem_key TEXT NOT NULL UNIQUE,        -- 幂等键：同一来源事件×订阅×渠道只生成一次
  sub_id INTEGER,
  channel_id INTEGER NOT NULL,
  alert_event_id INTEGER,               -- 来源预警触发（回执同步解除用）
  crisis_id INTEGER,                    -- 来源危机事件（回执/升级写时间线）
  kind TEXT NOT NULL DEFAULT 'alert',   -- alert/crisis
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', -- pending/sent/failed/acked/escalated/paused/cancelled
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_retry_at INTEGER,                -- 下次自动重试毫秒时间戳（NULL=立即）
  require_ack INTEGER NOT NULL DEFAULT 0,
  ack_by TEXT NOT NULL DEFAULT '',
  ack_at TEXT,
  ack_note TEXT NOT NULL DEFAULT '',
  escalate_at INTEGER,                  -- 回执超时升级毫秒时间戳
  escalated INTEGER NOT NULL DEFAULT 0,
  escalated_from INTEGER,               -- 升级来源任务（升级任务不再二次升级）
  pause_prev TEXT NOT NULL DEFAULT '',  -- 暂停前状态（恢复语义记录）
  last_error TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notify_tasks_due ON notify_tasks (status, next_retry_at);
-- 通知历史追踪：生成/发送/重试/暂停/恢复/回执/升级/取消全程留痕（含操作人）
CREATE TABLE IF NOT EXISTS notify_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  action TEXT NOT NULL,                 -- created/sent/retry/failed/paused/resumed/acked/escalated/cancelled
  detail TEXT NOT NULL DEFAULT '',
  operator TEXT NOT NULL DEFAULT '系统',
  time TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notify_logs_task ON notify_logs (task_id, id);
-- 可恢复批量导入：任务主表（幂等标识、状态机、进度、结果汇总）
CREATE TABLE IF NOT EXISTS import_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idem_key TEXT NOT NULL UNIQUE,  -- 任务幂等键：同键重复提交直接返回原任务
  total INTEGER NOT NULL DEFAULT 0,
  total_ok INTEGER NOT NULL DEFAULT 0,
  total_failed INTEGER NOT NULL DEFAULT 0,
  total_duplicate INTEGER NOT NULL DEFAULT 0,
  alerts_fired INTEGER NOT NULL DEFAULT 0,
  crises_created INTEGER NOT NULL DEFAULT 0,
  crises_merged INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending/running/paused/done/failed（failed=跑完仍有失败条目）
  attempts INTEGER NOT NULL DEFAULT 0,    -- 任务级执行轮次（用于中断/失败后恢复）
  last_error TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  finished TEXT
);
-- 逐条记录：状态与结果用于进度展示、失败重试、结果回写
CREATE TABLE IF NOT EXISTS import_job_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,           -- 批内序号（从 0 开始）
  idem_key TEXT NOT NULL,         -- 条目幂等键（去重在 posts 唯一索引上判定；不同任务可有同名键）
  payload TEXT NOT NULL,          -- 原始录入 JSON
  status TEXT NOT NULL DEFAULT 'pending', -- pending/success/failed/duplicate
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL DEFAULT '',        -- 成功结果 JSON（含触发预警）
  error TEXT NOT NULL DEFAULT '',
  post_id INTEGER,
  UNIQUE (job_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_import_job_items_job ON import_job_items (job_id, status);
CREATE INDEX IF NOT EXISTS idx_import_job_items_key ON import_job_items (idem_key);
-- 注：posts.idem_key 索引在下方 ensureColumn 之后创建（旧库可能尚无该列，此处创建会导致启动失败）
`)

// 把 toLocaleString('zh-CN') 形如「2026/9/26 01:54:38」解析为毫秒时间戳（迁移/窗口计算用）
export function parseTimeMs(s) {
  if (s == null) return null
  if (typeof s === 'number') return s
  const m = String(s).match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/)
  if (!m) return null
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime()
  return Number.isNaN(t) ? null : t
}

// 旧库迁移：缺列则补齐（SQLite 不支持 ADD COLUMN IF NOT EXISTS）
function ensureColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
}
ensureColumn('alert_events', 'crisis_id', 'crisis_id INTEGER')
ensureColumn('alert_events', 'status', "status TEXT NOT NULL DEFAULT 'open'")
ensureColumn('alert_events', 'resolved', 'resolved TEXT')
ensureColumn('alert_events', 'resolve_kind', "resolve_kind TEXT NOT NULL DEFAULT ''")
ensureColumn('crisis', 'alert_id', 'alert_id INTEGER')
ensureColumn('crisis', 'origin', "origin TEXT NOT NULL DEFAULT 'manual'")
ensureColumn('alerts', 'merge_topic', "merge_topic TEXT NOT NULL DEFAULT ''")
ensureColumn('alerts', 'merge_window', 'merge_window INTEGER NOT NULL DEFAULT 0')
ensureColumn('crisis', 'topic', "topic TEXT NOT NULL DEFAULT ''")
ensureColumn('crisis', 'last_trigger_at', 'last_trigger_at INTEGER')
ensureColumn('posts', 'idem_key', 'idem_key TEXT')
db.exec('CREATE INDEX IF NOT EXISTS idx_posts_idem_key ON posts (idem_key) WHERE idem_key IS NOT NULL;')

// 迁移：早期版本 import_job_items.idem_key 为全局唯一，跨任务内容去重时同名键会冲突，
// 重建表去掉该唯一约束（保留 (job_id, seq) 唯一与普通索引）。
function migrateJobItemsKeyUnique() {
  const idxList = db.prepare("PRAGMA index_list('import_job_items')").all()
  let bad = null
  for (const ix of idxList) {
    if (!ix.unique) continue
    const cols = db.prepare(`PRAGMA index_info('${ix.name}')`).all().map((c) => c.name)
    // 仅 idem_key 单列唯一的索引是旧约束（(job_id,seq) 复合唯一保留）
    if (cols.length === 1 && cols[0] === 'idem_key') { bad = ix; break }
  }
  if (!bad) return
  const cols = db.prepare('PRAGMA table_info(import_job_items)').all().map((c) => c.name)
  if (!cols.includes('idem_key')) return
  db.exec(`
    CREATE TABLE import_job_items_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      idem_key TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      result TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      post_id INTEGER,
      UNIQUE (job_id, seq)
    );
    INSERT INTO import_job_items_new (id,job_id,seq,idem_key,payload,status,attempts,result,error,post_id)
      SELECT id,job_id,seq,idem_key,payload,status,attempts,result,error,post_id FROM import_job_items;
    DROP TABLE import_job_items;
    ALTER TABLE import_job_items_new RENAME TO import_job_items;
    CREATE INDEX IF NOT EXISTS idx_import_job_items_job ON import_job_items (job_id, status);
    CREATE INDEX IF NOT EXISTS idx_import_job_items_key ON import_job_items (idem_key);
  `)
}
migrateJobItemsKeyUnique()

// 旧关联迁移：crisis.alert_id 单规则 → crisis_alerts 多对多；回填话题与最近触发时间。
// 幂等：仅在关联表为空时执行，历史时间线（crisis_timeline）原样保留。
function migrateLegacyLinks() {
  const linked = db.prepare('SELECT COUNT(*) c FROM crisis_alerts').get().c
  if (linked > 0) return
  const crises = db.prepare('SELECT id, alert_id, topic, updated FROM crisis').all()
  const insLink = db.prepare('INSERT INTO crisis_alerts (crisis_id,alert_id,is_origin,first_at,last_at) VALUES (?,?,?,?,?)')
  for (const c of crises) {
    // 该事件关联过的全部规则（alert_events 中去重），来源规则置 is_origin=1
    const ruleIds = db.prepare('SELECT DISTINCT alert_id FROM alert_events WHERE crisis_id=?').all(c.id).map((r) => r.alert_id)
    if (c.alert_id && !ruleIds.includes(c.alert_id)) ruleIds.unshift(c.alert_id)
    let topic = c.topic
    if (!topic) {
      const ev = db.prepare(`SELECT ae.time, p.topic ptopic FROM alert_events ae
        LEFT JOIN posts p ON p.id=ae.post_id WHERE ae.crisis_id=? ORDER BY ae.id ASC LIMIT 1`).get(c.id)
      topic = (ev && ev.ptopic) || ''
    }
    let lastAt = null, lastMs = null
    const lastEv = db.prepare('SELECT time FROM alert_events WHERE crisis_id=? ORDER BY id DESC LIMIT 1').get(c.id)
    if (lastEv) { lastAt = lastEv.time; lastMs = parseTimeMs(lastEv.time) }
    if (lastMs == null) lastMs = parseTimeMs(c.updated)
    if (topic) db.prepare('UPDATE crisis SET topic=?, last_trigger_at=? WHERE id=?').run(topic, lastMs, c.id)
    else db.prepare('UPDATE crisis SET last_trigger_at=? WHERE id=?').run(lastMs, c.id)
    ruleIds.forEach((rid) => {
      const first = db.prepare('SELECT MIN(time) t FROM alert_events WHERE crisis_id=? AND alert_id=?').get(c.id, rid).t || c.updated
      const last = db.prepare('SELECT MAX(time) t FROM alert_events WHERE crisis_id=? AND alert_id=?').get(c.id, rid).t || first
      insLink.run(c.id, rid, rid === c.alert_id ? 1 : 0, first, last)
    })
  }
}
migrateLegacyLinks()

// 旧库迁移：为历史已结案事件补建结案档案（幂等：已有档案则跳过）。
// 联动解除清单无法追溯置空——此类结案回滚时仅恢复事件状态，不回滚预警。
function migrateClosures() {
  const closed = db.prepare("SELECT id, updated FROM crisis WHERE status='closed'").all()
  const hasClosure = db.prepare('SELECT 1 FROM crisis_closures WHERE crisis_id=? LIMIT 1')
  const findNote = db.prepare("SELECT note, time FROM crisis_timeline WHERE crisis_id=? AND action='事件结案' ORDER BY id DESC LIMIT 1")
  const ins = db.prepare('INSERT INTO crisis_closures (crisis_id,summary,resolved_events,prev_status,closed_at) VALUES (?,?,?,?,?)')
  for (const c of closed) {
    if (hasClosure.get(c.id)) continue
    const tl = findNote.get(c.id)
    ins.run(c.id, tl ? tl.note : '', '[]', 'disposal', tl ? tl.time : c.updated)
  }
}
migrateClosures()

function seed() {
  const n = db.prepare('SELECT COUNT(*) c FROM posts').get().c
  if (n > 0) return
  const now = new Date()
  const nowStr = now.toLocaleString('zh-CN')

  const si = db.prepare('INSERT INTO sources VALUES (?,?)')
  const sources = [['微博'], ['微信'], ['新闻'], ['知乎'], ['抖音'], ['论坛']]
  sources.forEach((s, i) => si.run(i + 1, s[0]))
  const srcName = (i) => sources[i - 1][0]

  // 舆情模拟数据
  const sample = [
    // [title, content, sourceIdx, sentiment, score, heat, hot, topic, media]
    ['某电商平台预售商品迟迟不发货引用户吐槽', '网友晒出多份订单截图，称下单后近两周仍未发货，客服回应迟缓，引发大量讨论。', 1, 'negative', -0.7, 82, 1, '电商物流', '新浪科技'],
    ['新上线的某支付功能被指流程繁琐', '多位用户在社交平台反映新功能需多次验证，操作成本高，官方暂无明确回应。', 3, 'negative', -0.55, 67, 1, '产品体验', '知乎热议'],
    ['某出行企业发布年度服务质量报告', '报告显示投诉率同比下降，用户满意度多项指标回升，业内普遍关注。', 4, 'positive', 0.62, 58, 0, '企业动态', '行业观察'],
    ['专家谈绿色能源转型前景', '受访专家认为短期阵痛不改长期趋势，政策利好明显，市场反应积极。', 3, 'positive', 0.7, 71, 0, '行业趋势', '第一财经'],
    ['某连锁品牌被曝门店后厨卫生隐患', '暗访视频显示多位后厨操作不规范，品牌方紧急回应称已开展全面自查并关停涉事门店。', 6, 'negative', -0.82, 90, 1, '食品安全', '澎湃新闻'],
    ['城市新推惠民政策引关注', '多地同步推出惠民补贴与便民措施，市民普遍点赞落实情况。', 2, 'positive', 0.66, 55, 0, '民生', '人民日报'],
    ['电子产品新品发布会亮点解析', '新机型在续航与影像上提升明显，网友讨论热情高涨，预约量攀升。', 5, 'positive', 0.6, 63, 0, '消费电子', '微博热搜'],
    ['某地产项目延期交付业主维权', '多位业主聚集反映工程进度缓慢，项目方表示将给出补偿方案，事件仍在发酵。', 1, 'negative', -0.74, 78, 1, '房地产', '凤凰网'],
    ['行业大模型落地案例盘点', '多家企业公布行业大模型在企业效率提升上的实测数据，外界关注商业模式可持续性。', 3, 'neutral', 0.1, 49, 0, '科技', '科技媒体'],
    ['某视频平台会员涨价引发议论', '涨价公告后大量网友讨论性价比与内容质量，情绪以中性偏负为主。', 1, 'negative', -0.4, 70, 0, '平台运营', '排行榜'],
    ['社区养老新模式获好评', '多个社区试点养老互助点，老人家属反馈积极，成为正面典型。', 2, 'positive', 0.72, 52, 0, '民生', '中新社'],
    ['某新能源汽车充电服务再引分歧', '车主反映充电桩故障率偏高、客服响应慢，品牌方回应正在扩容并优化售后。', 5, 'negative', -0.66, 74, 1, '新能源', '汽车之家'],
    ['旅游旺季景区秩序引关注', '假期多景区实行预约限流，整体秩序良好，但也有排队偏长等零星抱怨。', 6, 'neutral', -0.15, 45, 0, '文旅', '本地资讯'],
    ['某外卖平台骑手权益保障进展', '平台公布骑手社保与安全培训新举措，舆论整体肯定，细则仍需观察。', 1, 'neutral', 0.2, 50, 0, '平台运营', '澎湃新闻'],
    ['科学家团队在脑机接口研究取得进展', '相关成果经权威期刊发表，引发学界乐观讨论，也被提醒需长期验证。', 3, 'positive', 0.68, 60, 0, '前沿科技', '科普中国']
  ]

  const pi = db.prepare('INSERT INTO posts (title,content,source_id,sentiment,sentiment_score,heat,hot,topic,media,published,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
  const base = new Date()
  sample.forEach((s, i) => {
    const pub = new Date(base.getTime() - (i * 37 + 12) * 60 * 1000).toLocaleString('zh-CN')
    pi.run(s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], pub, nowStr)
  })

  const wi = db.prepare('INSERT INTO hot_words (word,weight,sentiment) VALUES (?,?,?)')
  ;[['发货慢', 40, 'negative'], ['后厨卫生', 36, 'negative'], ['延期交付', 32, 'negative'], ['充电桩', 30, 'negative'],
    ['会员涨价', 28, 'negative'], ['服务报告', 26, 'positive'], ['惠民政策', 25, 'positive'], ['绿色能源', 24, 'positive'],
    ['新品发布', 23, 'positive'], ['养老互助', 22, 'positive'], ['脑机接口', 21, 'positive'], ['景区限流', 18, 'neutral'],
    ['骑手保障', 17, 'neutral'], ['会员', 16, 'neutral'], ['大模型', 15, 'neutral']]
    .forEach((w) => wi.run(w[0], w[1], w[2]))

  const ago = (m) => new Date(now.getTime() - m * 60000).toLocaleString('zh-CN')

  const ai = db.prepare('INSERT INTO alerts (title,level,keyword,sentiment,heat_min,active,created,trigger_count,merge_topic,merge_window) VALUES (?,?,?,?,?,?,?,?,?,?)')
  const a1 = ai.run('负面情绪集中爆发', 'red', '卫生', 'negative', 80, 1, nowStr, 1, '食品安全', 720).lastInsertRowid
  const a2 = ai.run('投诉类话题升温', 'orange', '投诉', 'negative', 65, 1, nowStr, 2, '服务投诉', 1440).lastInsertRowid
  const a3 = ai.run('选址关键词监控', 'yellow', '延期', 'negative', 60, 1, nowStr, 1, '房地产', 1440).lastInsertRowid
  ai.run('正面口碑监测', 'yellow', '服务', 'positive', 50, 1, nowStr, 1, '', 0)

  // 危机事件：c1 红色自动建档·处置中；c2 橙色自动建档·监测中（同话题去重并入）；c3 人工建档·已结案（承接两条规则）
  const ci = db.prepare('INSERT INTO crisis (title,level,status,plan,analysis,created,updated,linked_email,keyword,alert_id,origin,topic,last_trigger_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const c1 = ci.run('某连锁品牌门店卫生事件', 'red', 'disposal',
    '1. 24小时内全网回应，公布整改时间表\n2. 关停涉事门店并启动第三方复查\n3. 官方渠道连续发布整改动态\n4. 与权威媒体合作发布透明报告',
    '负面传播主阵地为短视频与微博，需在2小时内完成首次回应，重点关注转发量头部账号。',
    ago(180), ago(120), 'crisis@brand.com', '卫生', a1, 'auto', '食品安全', new Date(now.getTime() - 180 * 60000).getTime()).lastInsertRowid
  const c2 = ci.run('投诉类话题升温事件', 'orange', 'monitoring', '',
    '由橙色预警「投诉类话题升温」自动建档：命中关键词「投诉」，首条关联舆情《某电商平台预售商品迟迟不发货引用户吐槽》（热度82）。',
    ago(90), ago(30), '', '投诉', a2, 'auto', '服务投诉', new Date(now.getTime() - 30 * 60000).getTime()).lastInsertRowid
  const c3 = ci.run('某视频平台会员涨价争议', 'orange', 'closed',
    '1. 发布定价说明与会员权益升级方案\n2. 客服通道集中答疑\n3. 观察期一周，舆情回落后结案',
    '情绪以中性偏负为主，未出现大规模抵制，重点回应性价比质疑。',
    ago(4320), ago(2840), '', '涨价', null, 'manual', '会员涨价', new Date(now.getTime() - 2880 * 60000).getTime()).lastInsertRowid

  // 事件↔规则多对多：c3 为人工建档但承接了两条规则（同一事件承接多条规则）
  const cl = db.prepare('INSERT INTO crisis_alerts (crisis_id,alert_id,is_origin,first_at,last_at) VALUES (?,?,?,?,?)')
  cl.run(c1, a1, 1, ago(180), ago(180))
  cl.run(c2, a2, 1, ago(90), ago(30))
  cl.run(c3, a2, 0, ago(4310), ago(4300))
  cl.run(c3, a3, 0, ago(2880), ago(2880))

  // 预警触发记录：c1/c2 由预警自动建档，c2 第二次触发去重并入；黄色规则不自动建档
  const ae = db.prepare('INSERT INTO alert_events (alert_id,post_id,crisis_id,detail,time,status,resolved,resolve_kind) VALUES (?,?,?,?,?,?,?,?)')
  ae.run(a1, 5, c1, '命中关键词「卫生」· 情感：negative · 热度90', ago(180), 'open', null, '')
  ae.run(a2, 1, c2, '命中关键词「投诉」· 情感：negative · 热度82', ago(90), 'open', null, '')
  ae.run(a2, 12, c2, '命中关键词「投诉」· 情感：negative · 热度74', ago(30), 'open', null, '')
  ae.run(a3, 8, null, '命中关键词「延期」· 情感：negative · 热度78', ago(60), 'open', null, '')
  // c3 人工建档但处置期承接了 a2/a3 两条规则，结案前已逐条手动解除（历史闭环）
  ae.run(a2, 11, c3, '命中关键词「投诉」· 情感：negative · 热度70', ago(4310), 'resolved', ago(2880), 'manual')
  ae.run(a3, 11, c3, '命中关键词「延期」· 情感：negative · 热度66', ago(2880), 'resolved', ago(2880), 'manual')

  // c3 结案档案（历史结案：预警先于结案手动解除，联动解除清单为空）
  db.prepare('INSERT INTO crisis_closures (crisis_id,summary,resolved_events,prev_status,closed_at) VALUES (?,?,?,?,?)')
    .run(c3, '舆情热度回落至常态区间，负面占比降至 5% 以下，完成处置闭环。', '[]', 'disposal', ago(2840))

  const ct = db.prepare('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)')
  ;[['自动建档', '高等级预警触发：命中关键词「卫生」· 情感：negative · 热度90', ago(180)],
    ['全网回应', '官方发布回应声明', ago(150)],
    ['关停门店', '涉事门店暂停营业，启动自查', ago(120)]].forEach((t) => ct.run(c1, t[0], t[1], t[2]))
  ;[['自动建档', '高等级预警触发：命中关键词「投诉」· 情感：negative · 热度82', ago(90)],
    ['预警再次触发', '命中关键词「投诉」· 情感：negative · 热度74 · 关联舆情《某新能源汽车充电服务再引分歧》', ago(30)]].forEach((t) => ct.run(c2, t[0], t[1], t[2]))
  ;[['事件建档', '人工建档，进入监测', ago(4320)],
    ['启动处置', '发布定价说明，开通集中答疑', ago(4300)],
    ['预警解除', '风险指标回落，预警解除', ago(2880)],
    ['事件结案', '舆情热度回落至常态区间，负面占比降至 5% 以下，完成处置闭环。', ago(2840)]].forEach((t) => ct.run(c3, t[0], t[1], t[2]))
}
seed()

// 通知渠道与订阅编排种子（独立幂等：老库升级后同样补齐演示配置；任务由调度器在运行时生成）
function seedNotify() {
  const n = db.prepare('SELECT COUNT(*) c FROM notify_channels').get().c
  if (n > 0) return
  const nowStr = new Date().toLocaleString('zh-CN')
  const nc = db.prepare('INSERT INTO notify_channels (name,type,target,enabled,created,created_by) VALUES (?,?,?,1,?,?)')
  const ch1 = Number(nc.run('值班 Webhook', 'webhook', 'https://ops.internal/alert-hook', nowStr, '系统初始化').lastInsertRowid)
  const ch2 = Number(nc.run('危机邮箱组', 'email', 'mailto:crisis@brand.com', nowStr, '系统初始化').lastInsertRowid)
  const ch3 = Number(nc.run('短信网关', 'sms', 'sms://flaky-gateway', nowStr, '系统初始化').lastInsertRowid) // flaky：首次发送模拟瞬时故障，演示自动重试
  const ch4 = Number(nc.run('升级专线', 'webhook', 'https://ops.internal/escalation', nowStr, '系统初始化').lastInsertRowid)
  const ns = db.prepare('INSERT INTO notify_subs (name,alert_id,topic,crisis_status,levels,channel_ids,require_ack,ack_timeout_min,escalate_channel_id,max_retry,active,created,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)')
  // 红色预警 → Webhook + 邮箱，需回执，1 分钟超时升级至升级专线
  ns.run('红色预警全员通知', null, '', '', 'red', JSON.stringify([ch1, ch2]), 1, 1, ch4, 3, nowStr, '系统初始化')
  // 食安话题 → 邮箱 + 短信（短信通道首次发送模拟故障，演示失败重试）
  ns.run('食安话题跟踪推送', null, '食品安全', '', '', JSON.stringify([ch2, ch3]), 0, 30, null, 3, nowStr, '系统初始化')
  // 危机结案 → Webhook 通报
  ns.run('危机结案通报', null, '', 'closed', '', JSON.stringify([ch1]), 0, 30, null, 3, nowStr, '系统初始化')
}
seedNotify()