// 轻量进程内事件总线：业务侧（预警管线/危机路由）只负责 emit，
// 通知编排侧订阅并完成「订阅匹配 → 任务生成」，两者不互相依赖。
const handlers = new Map() // event -> Set<fn>

export function onEvent(event, fn) {
  if (!handlers.has(event)) handlers.set(event, new Set())
  handlers.get(event).add(fn)
  return () => handlers.get(event)?.delete(fn)
}

// payload 公共字段：type, alertId, alertEventId, postId, crisisId, level, topic,
// detail, title, time, extra（如危机状态 from/to）
export function emit(event, payload) {
  const list = handlers.get(event)
  if (!list) return
  for (const fn of [...list]) {
    try { fn({ ...payload, type: event }) } catch (e) {
      // 订阅方异常不影响业务主链路（通知失败绝不能阻断录入/处置）
      console.error(`[EVENTBUS] ${event} handler error:`, e?.message || e)
    }
  }
}
