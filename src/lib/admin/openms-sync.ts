// 后台仪表盘「开源扫雷网录像同步」概览卡数据源（2026-11-10）
//
// 口径（张老师 2026-11-10 确认）：只做首页卡、10 秒轮询、纯只读、无任何干预操作。
// 实时查询，**不进 unstable_cache**：状态灯/心跳/本轮计数必须跟跑批同步，缓存会骗人。
//
// 三张表各司其职：
//   openms_sync_run   —— 现在是否在跑、跑到哪、上次为什么停（心跳/计数/上下文/配置快照）
//   openms_video_map  —— 累计已扫过 ID 与 state 分布（0 待处理 1 已导入 2 已拒收 3 已放弃）
//   openms_link       —— 参与同步的用户数（consent=1）与每人游标
//
// ⚠️ 对方 unmapped_videos 不返回 total，且 unmapped 集合会随对方映射变化，
//    因此这里绝不计算「全量完成百分比」；进度只显示本轮实际扫到的 ID 构成。

import { prisma } from "@/lib/db";

/** 跑批记录视图（BigInt 一律转 number，供 JSON 序列化） */
export type OpenmsSyncRunView = {
  id: number;
  trigger: string;
  status: number;
  startedAt: number;
  heartbeatAt: number;
  finishedAt: number;
  startedText: string;
  heartbeatText: string;
  finishedText: string;
  durationSec: number | null;
  users: number;
  pages: number;
  handled: number;
  ok: number;
  skip: number;
  retry: number;
  gaveUp: number;
  seen: number;
  registered: number;
  currentUser: number;
  currentProfile: number;
  currentCursor: number;
  currentVideoId: number;
  lastError: string | null;
  maxItems: number;
  pageCount: number;
  minGapMs: number;
  listGapMs: number;
  maxRetries: number;
};

export type OpenmsSyncState = "never" | "running" | "stuck" | "idle" | "stalled" | "failed";

export type OpenmsSyncStatus = {
  /** 服务端当前时刻（Unix 秒）：客户端用它算相对时间，避免 hydration 不一致 */
  now: number;
  state: OpenmsSyncState;
  label: string;
  tone: "ok" | "warn" | "bad" | "info" | "plain";
  dot: "run" | "warn" | "bad" | "idle" | "plain";
  /** 最新一轮（可能进行中） */
  run: OpenmsSyncRunView | null;
  /** 最近一轮已结束的，用于「上一轮耗时」 */
  lastFinished: OpenmsSyncRunView | null;
  heartbeatAgeSec: number | null;
  totals: {
    scanned: number;
    imported: number;
    rejected: number;
    pending: number;
    gaveUp: number;
    /** state=0 且 attempts>=3（下一次失败即放弃） */
    pendingHigh: number;
    /** 今日落定为 state=1 的盘数（按台账结论时刻，不是录像上传时间） */
    importedToday: number;
    syncUsers: number;
    linksTotal: number;
  };
};

type RunRow = NonNullable<Awaited<ReturnType<typeof prisma.openmsSyncRun.findFirst>>>;

/** +08:00 固定时区 HH:mm:ss（纯算术，服务端/客户端一致，不依赖机器时区） */
function hhmmss(sec: number): string {
  if (!sec || sec <= 0) return "—";
  const d = new Date((sec + 28800) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function toView(r: RunRow, now: number): OpenmsSyncRunView {
  const startedAt = Number(r.startedAt);
  const heartbeatAt = Number(r.heartbeatAt);
  const finishedAt = Number(r.finishedAt);
  return {
    id: Number(r.id),
    trigger: r.trigger,
    status: r.status,
    startedAt, heartbeatAt, finishedAt,
    startedText: hhmmss(startedAt),
    heartbeatText: hhmmss(heartbeatAt),
    finishedText: finishedAt > 0 ? hhmmss(finishedAt) : "—",
    // 进行中的轮次按心跳算已运行时间，不显示假的「耗时」
    durationSec: finishedAt > 0 ? Math.max(0, finishedAt - startedAt) : Math.max(0, now - startedAt),
    users: r.users, pages: r.pages, handled: r.handled,
    ok: r.ok, skip: r.skip, retry: r.retry, gaveUp: r.gaveUp,
    seen: r.seen, registered: r.registered,
    currentUser: Number(r.currentUser), currentProfile: r.currentProfile,
    currentCursor: Number(r.currentCursor), currentVideoId: Number(r.currentVideoId),
    lastError: r.lastError,
    maxItems: r.maxItems, pageCount: r.pageCount, minGapMs: r.minGapMs,
    listGapMs: r.listGapMs, maxRetries: r.maxRetries,
  };
}

/** 状态判定阈值：心跳 180s 内算运行中；15min 无新一轮算 crontab 停滞 */
const HEARTBEAT_OK_SEC = 180;
const NO_RUN_STALL_SEC = 900;

export async function getOpenmsSyncStatus(): Promise<OpenmsSyncStatus> {
  const now = Math.floor(Date.now() / 1000);
  // +08:00 日界（今日 00:00 对应的 Unix 秒）
  const todayStart = Math.floor((now + 28800) / 86400) * 86400 - 28800;

  const [latest, lastDoneRow, groups, pendingHigh, importedToday, syncUsers, linksTotal] = await Promise.all([
    prisma.openmsSyncRun.findFirst({ orderBy: { id: "desc" } }),
    prisma.openmsSyncRun.findFirst({ where: { finishedAt: { gt: BigInt(0) } }, orderBy: { id: "desc" } }),
    prisma.openmsVideoMap.groupBy({ by: ["state"], _count: { _all: true } }),
    prisma.openmsVideoMap.count({ where: { state: 0, attempts: { gte: 3 } } }),
    prisma.openmsVideoMap.count({ where: { state: 1, updateTime: { gte: BigInt(todayStart) } } }),
    prisma.openmsLink.count({ where: { consent: 1 } }),
    prisma.openmsLink.count(),
  ]);

  const byState = new Map(groups.map((g) => [g.state, g._count._all]));
  const totals = {
    scanned: [...byState.values()].reduce((a, b) => a + b, 0),
    imported: byState.get(1) ?? 0,
    rejected: byState.get(2) ?? 0,
    pending: byState.get(0) ?? 0,
    gaveUp: byState.get(3) ?? 0,
    pendingHigh,
    importedToday,
    syncUsers,
    linksTotal,
  };

  const run = latest ? toView(latest, now) : null;
  const lastFinished = lastDoneRow ? toView(lastDoneRow, now) : null;
  const heartbeatAgeSec = run ? Math.max(0, now - run.heartbeatAt) : null;

  let state: OpenmsSyncState = "never";
  let label = "尚未启用";
  let tone: OpenmsSyncStatus["tone"] = "plain";
  let dot: OpenmsSyncStatus["dot"] = "plain";
  if (run) {
    const running = run.finishedAt === 0;
    if (running && (heartbeatAgeSec ?? 0) <= HEARTBEAT_OK_SEC) {
      state = "running"; label = "正在同步"; tone = "ok"; dot = "run";
    } else if (running) {
      state = "stuck"; label = "疑似卡住"; tone = "warn"; dot = "warn";
    } else if (now - run.startedAt > NO_RUN_STALL_SEC) {
      state = "stalled"; label = "跑批停滞"; tone = "bad"; dot = "bad";
    } else if (run.status === 2 || run.status === 3) {
      state = "failed"; label = run.status === 3 ? "上轮异常终止" : "上轮部分失败"; tone = "bad"; dot = "bad";
    } else {
      state = "idle"; label = "等待下一轮"; tone = "info"; dot = "idle";
    }
  }

  return { now, state, label, tone, dot, run, lastFinished, heartbeatAgeSec, totals };
}
