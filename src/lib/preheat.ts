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
//
// ⚠️ ttlSec 必须与底层 unstable_cache 的 revalidate 一致（preheat-jobs.ts 注册处对齐）；
//    改某条目 revalidate 时同步改注册值，否则提前量失准。
// 任务清单见 src/lib/preheat-jobs.ts（由 src/instrumentation.ts 在服务启动时加载）。

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

const jobs = new Map<string, PreheatJob>();
const MARGIN_MS = 60_000; // 张老师口径：过期前 1 分钟刷新
const TICK_MS = 15_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const FIRST_RUN_STAGGER_MS = 2500; // 首跑逐个错峰，避免启动瞬间 9 个任务同打连接池
let started = false;

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
  if (started) return;
  started = true;
  const timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  // 不阻止进程退出（CI 构建 / 误 import 场景也能干净结束）
  timer.unref?.();
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
