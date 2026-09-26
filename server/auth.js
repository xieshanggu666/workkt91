import { db } from './db.js'

// 极简 RBAC（演示）：前端登录后所有请求带 x-user-id；未带时回落为首个 operator，
// 保证 curl 旧调用方不受影响。三级权限矩阵：
//   viewer   ：只读 + 确认回执（订阅人确认自己收到的通知）
//   operator ：+ 暂停/恢复订阅与任务、手动重试、取消任务、渠道测试
//   admin    ：+ 渠道/订阅增删改、历史清理与任务删除
export const ROLES = ['viewer', 'operator', 'admin']
const CAN = {
  viewer: ['read', 'ack'],
  operator: ['read', 'ack', 'operate', 'channelTest'],
  admin: ['read', 'ack', 'operate', 'channelTest', 'config', 'purge']
}

export function attachUser(req, _res, next) {
  const uid = parseInt(req.headers['x-user-id'], 10)
  let user = null
  if (Number.isInteger(uid)) user = db.prepare('SELECT * FROM notify_users WHERE id=?').get(uid)
  if (!user) user = db.prepare("SELECT * FROM notify_users WHERE role='operator' ORDER BY id LIMIT 1").get()
  req.user = user || { id: null, name: 'anonymous', role: 'viewer' }
  req.can = (perm) => !!user && CAN[user.role]?.includes(perm)
  next()
}

export function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.can(perm)) {
      return res.status(403).json({
        error: `权限不足：当前用户「${req.user.name}」（${req.user.role}）无 ${perm} 权限，需 ${perm === 'config' || perm === 'purge' ? 'admin' : 'operator'} 角色`
      })
    }
    next()
  }
}
