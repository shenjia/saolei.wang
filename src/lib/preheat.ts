// 缓存自驱动预热（2026-11-03 张老师提出：不等过期、TTL 前留 60s 主动重建，
// 访客永远不撞「条目缺失/过期」的阻塞重建——cron 预热本质仍靠 HTTP 访问触发，
// 本模块改为应用内自驱动，与访问解耦）。
//
// 原理（Next 16.3.6 unstable-cache.js 实证）：无请求上下文调用 unstable_cache 包装函数时
// 走 globalThis.__incrementalCache 兜底分支——条目新鲜则直接返回；过期/缺失则执行回调并
// await 落盘（cacheNewResult），**TTL 时钟随之重置**。所以只要保证每个条目在
// TTL-margin 内被成功调用一次，Next 自己的过期计时永远走不到头，访客永远命中热缓存。
//
// 调度：registerPreheat() 把固定参数的刷新闭包挂进注册表，每 15s 扫一遍，
// 凡「距上次成功刷新 > TTL − 60s」且不在跑的 job 就 fire-and-forget 重跑。
// · 单飞（busy 标志）防同条目并发重建；
// · 失败指数退避（15s×2^n 封顶 5min），成功即恢复；退避中访客请求照常兜底（撞过期
//   也只是 300s 档的一次重建，与本模块互不干扰）；
// · 进程刚起时 __incrementalCache 可能未挂、CI 构建期不应碰库——两种情况都不调度。
// · ⚠️ 状态必须挂 globalThis：Next 会把同一模块打进多个服务端 bundle，模块级 Map
//   不是进程单例（2026-11-08 生产实证同槽同任务出现 44～47 份注册表）。
//   所有副本共享同一份 jobs / ticker / kickTimers，杜绝重复预热打满 Next 与 MySQL。
//
// ⚠️ ttlSec 必须与底层 unstable_cache 的 revalidate 一致——约定两条都要引用
//    config.REVALIDATE_HOME_CACHE 同一常量（注册行紧跟查询定义处），禁止写字面量。
// 任务注册分散在查询定义处：queries.ts / title-system.ts / practice.ts 各自紧跟对应
// 缓存条目调用 registerPreheat()（src/instrumentation.ts 启动时 import 触发）。
//
// kickPreheat（2026-11-06 张老师需求）：事件驱动的即时刷新——管理员批量审核完录像
// 后首页动态缓存应立刻失效+重建，不等 TTL（等 4 分钟自驱 = 批量过审的动态 4 分钟
// 不上首页）。与 registerPreheat 的定时自驱互补：
// · trailing 合并窗口（1s）：审核管线逐条 reviewVideo 反复触发时，只在最后一次
//   调用 1s 后重建一次，避免批量 100 条打 100 次重建；
// · 重建直接复用注册的 run 闭包（无请求上下文走 __incrementalCache 兜底分支），
//   成本由本次审核请求的后台任务承担，访客永远命中热缓存；
// · 与自驱 tick 撞车（busy）时把 last 清零交给下一次 tick 兜底，不会漏刷。

type PreheatJob = {
  run: () => Promise<unknown>;
  ttlMs: number;
  /** 上次成功刷新时刻（epoch ms）；0=从未成功（首跑受 nextTry 错峰约束） */
  last: number;
  /** 最早可重试时刻：首跑错峰 + 失败退避 */
  nextTry: number;
  busy: boolean;
  fails: number;
};

type PreheatState = {
  jobs: Map<string, PreheatJob>;
  started: boolean;
  kickTimers: Map<string, ReturnType<typeof setTimeout>>;
};

// 用进程全局状态而不是模块状态：同一文件被不同服务端 bundle 各加载一次时也只有一个调度器。
const processState = globalThis as typeof globalThis & {
  __saoleiPreheatStateV1?: PreheatState;
};
const state = (processState.__saoleiPreheatStateV1 ??= {
  jobs: new Map<string, PreheatJob>(),
  started: false,
  kickTimers: new Map<string, ReturnType<typeof setTimeout>>(),
});
const { jobs, kickTimers } = state;

const MARGIN_MS = 60_000; // 张老师口径：过期前 1 分钟刷新
const TICK_MS = 15_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const FIRST_RUN_STAGGER_MS = 2500; // 首跑逐个错峰，避免启动瞬间 9 个任务同打连接池

export function registerPreheat(
  name: string,
  ttlSec: number,
  run: () => Promise<unknown>
): void {
  if (jobs.has(name)) return;
  jobs.set(name, {
    run,
    ttlMs: ttlSec * 1000,
    last: 0,
    // 首跑按注册顺序错峰（jobs.size 递增 → 每个任务晚 2.5s）
    nextTry: Date.now() + jobs.size * FIRST_RUN_STAGGER_MS,
    busy: false,
    fails: 0,
  });
  startTicker();
}

function startTicker(): void {
  if (state.started) return;
  state.started = true;
  const timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  // 不阻止进程退出（CI 构建 / 误 import 场景也能干净结束）
  timer.unref?.();
}

// trailing 合并窗口的挂起定时器（同一任务多次 kick 只保留最后一个）
const KICK_DEBOUNCE_MS = 1000;

/** 事件驱动即时刷新：标记对应预热任务在合并窗口后立刻重建一次（不等 TTL）。
 *  未注册同名任务时为 no-op；调用方通常配合 revalidateTag 先把条目标脏。 */
export function kickPreheat(name: string): void {
  const prev = kickTimers.get(name);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    kickTimers.delete(name);
    const j = jobs.get(name);
    if (!j) return;
    // 就绪门（与 tick 同款）：__incrementalCache 未挂时 kick 硬跑只会 E469——
    // 清零 last/nextTry 交给就绪后的下一次 tick 兜底
    if (
      process.env.NEXT_PHASE === "phase-production-build" ||
      !(globalThis as { __incrementalCache?: unknown }).__incrementalCache
    ) {
      j.last = 0;
      j.nextTry = 0;
      return;
    }
    if (j.busy) {
      // 与自驱 tick 撞车：清零 last 让下一次 tick 强制重跑兜底，不漏刷
      j.last = 0;
      j.nextTry = 0;
      return;
    }
    j.busy = true;
    void j
      .run()
      .then(() => {
        j.last = Date.now();
        j.fails = 0;
        j.nextTry = 0;
      })
      .catch((e: unknown) => {
        // 失败交还自驱调度按退避重试（与 tick 内同款口径）
        j.fails += 1;
        const wait = Math.min(TICK_MS * 2 ** j.fails, MAX_BACKOFF_MS);
        j.nextTry = Date.now() + wait;
        console.error(
          `[preheat] ${name} 即时刷新失败（第 ${j.fails} 次，${Math.round(wait / 1000)}s 后自驱重试）:`,
          e instanceof Error ? e.message : e
        );
      })
      .finally(() => {
        j.busy = false;
      });
  }, KICK_DEBOUNCE_MS);
  timer.unref?.();
  kickTimers.set(name, timer);
}

/** 运维观察用快照（只读）：任务状态 + 挂起中的 kick */
export function preheatDebug(): {
  jobs: Record<string, { last: number; nextTry: number; busy: boolean; fails: number }>;
  pendingKicks: string[];
} {
  return {
    jobs: Object.fromEntries(
      [...jobs].map(([k, v]) => [k, { last: v.last, nextTry: v.nextTry, busy: v.busy, fails: v.fails }])
    ),
    pendingKicks: [...kickTimers.keys()],
  };
}

async function tick(): Promise<void> {
  // 就绪门：unstable_cache 无请求上下文时依赖 globalThis.__incrementalCache
  // （缺失时调用会抛 E469）；构建期（next build）也不应碰库
  if (
    process.env.NEXT_PHASE === "phase-production-build" ||
    !(globalThis as { __incrementalCache?: unknown }).__incrementalCache
  ) {
    return;
  }
  const now = Date.now();
  for (const [name, j] of jobs) {
    if (j.busy || now < j.nextTry) continue;
    if (now - j.last < j.ttlMs - MARGIN_MS) continue;
    j.busy = true;
    void j
      .run()
      .then(() => {
        if (j.last === 0) {
          // 首次成功落一行日志，便于在生产 pm2 日志确认自驱动已转起来
          console.log(`[preheat] ${name} 首次刷新成功`);
        }
        j.last = Date.now();
        j.fails = 0;
        j.nextTry = 0;
      })
      .catch((e: unknown) => {
        j.fails += 1;
        const wait = Math.min(TICK_MS * 2 ** j.fails, MAX_BACKOFF_MS);
        j.nextTry = Date.now() + wait;
        console.error(
          `[preheat] ${name} 刷新失败（第 ${j.fails} 次，${Math.round(wait / 1000)}s 后重试）:`,
          e instanceof Error ? e.message : e
        );
      })
      .finally(() => {
        j.busy = false;
      });
  }
}
