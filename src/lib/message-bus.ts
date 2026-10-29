// 站内信未读推送总线（2026-10-29 SSE 改造）：进程内 EventEmitter 单例。
//
// 背景：未读角标原为全站 30s 轮询 /api/message?action=unread（单窗口 2,880 req/日，
// 全站 4.8 万 req/日，占请求数 8.4% 而流量仅 0.06%——是请求数噪音不是带宽问题）。
// 改为写点 emit → SSE 长连接推送，轮询仅作降级兜底。
//
// 单进程前提：蓝绿部署同一时刻仅单 active 进程服务流量（pm2 fork + nginx 单
// upstream），且全部运行时写点收敛在 lib/message.ts（审计于 2026-10-29，scripts/
// 下直写 SQL 均为离线迁移脚本）——进程内总线即可覆盖，无需 Redis。
//
// 事件只带 uid 信号不带 payload：SSE handler 收到后自查 getUnreadCount 推送，
// 避免写函数与推送路径重复计数；重复 emit 无害（幂等自查，数字一致）。
import { EventEmitter } from "node:events";

const g = globalThis as unknown as { __messageBus?: EventEmitter };

/** globalThis 单例：防 dev HMR / 路由模块多实例重建后写点与订阅端失联 */
export const messageBus: EventEmitter = (g.__messageBus ??= new EventEmitter());

// 每个 SSE 连接挂 2 个 listener（"user" + "all"），默认 10 上限远不够
messageBus.setMaxListeners(500);

/** 某用户消息有变化（增/已读/清空），对应 SSE 连接收到信号后自查推送 */
export function notifyUserUnread(userId: number): void {
  messageBus.emit("user", Number(userId));
}

/** 全站广播写库完成，所有 SSE 连接各自自查推送（广播写点只有 broadcast 一处） */
export function notifyAllUnread(): void {
  messageBus.emit("all");
}
