// 窗口赛完赛动态每分钟补写（2026-11-23 张老师需求：不依赖页面访问，定时兜底）。
//
// ── 背景 ──────────────────────────────────────────────────────────────────
// 完赛动态（比赛侧 type=6「已完赛」+ 个人侧 type=59「已完赛！最终成绩：xxx」）
// 此前只有「惰性补写」一条路：有人访问 /tournaments 列表页或详情页时才在渲染期
// 补齐（ensureTourLifecycleEvents）。缺陷：比赛冷清、无人访问的时段，玩家窗口
// 早已结束但完赛动态迟迟不发（惜步杯实证：周宇昊窗口 00:47 结束，动态靠访问
// 触发补写，张老师 01:18 在详情页没看到，误以为漏发）。
// 本脚本把补写从「访问驱动」升级为「时间驱动」：每分钟扫一遍已开赛的窗口赛，
// 幂等补写（ensureTourLifecycleEvents 自带 doneSet 去重，重复跑零副作用），
// 与惰性补写互为兜底、完全同口径（同函数）。
//
// ── 范围 ──────────────────────────────────────────────────────────────────
// 只扫 windowHours>0 且已开赛（start_time<=now）的比赛。历届导入的旧比赛
// window_hours 带默认值 2 但会话表恒空 → 完赛分支空转，无副作用。
// 集体赛的开始/结束事件仍由惰性补写兜底（访问即补），不在此扫描范围。
//
// ── 首页缓存说明 ──────────────────────────────────────────────────────────
// 不在脚本内调 refreshHomeNewsCache：外部进程 revalidateTag 够不着 Next 服务
// 进程内存缓存（默认 cache handler），kickPreheat 也是进程内状态 no-op。
// 首页新闻流匿名侧由 300s TTL + preheat-cron 兜底（滞后≤5 分钟），登录态由
// feedsalt 水位探测近实时，可接受。
//
// 用法（crontab 每分钟，见文件尾注释）：
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/tour-finish-refresh.ts
//
// 运行环境：项目根目录（.env 由 src/lib/db 读入；生产在 /home/deploy/saolei.wang）。

import { ensureTourLifecycleEvents } from "../src/lib/tournament";
import { prisma } from "../src/lib/db";

async function main() {
  const t0 = Date.now();
  const now = Math.floor(Date.now() / 1000);
  const comps = await prisma.tournament.findMany({
    where: { startTime: { lte: BigInt(now) }, windowHours: { gt: 0 } },
    select: {
      id: true,
      startTime: true,
      endTime: true,
      windowHours: true,
      scoreMode: true,
      scoreConfig: true,
      includeLevels: true,
    },
    orderBy: { id: "asc" },
  });
  let finishEvents = 0;
  let finishNews = 0;
  const touched: string[] = [];
  for (const c of comps) {
    const r = await ensureTourLifecycleEvents(
      {
        id: c.id,
        startTime: c.startTime,
        endTime: c.endTime,
        windowHours: c.windowHours,
        scoreMode: c.scoreMode ?? undefined,
        scoreConfig: c.scoreConfig ?? undefined,
        includeLevels: c.includeLevels ?? undefined,
      },
      now
    );
    if (r.finishEvents > 0 || r.started || r.ended) {
      touched.push(`#${c.id}(events=${r.finishEvents},news=${r.finishNews}${r.started ? ",started" : ""}${r.ended ? ",ended" : ""})`);
    }
    finishEvents += r.finishEvents;
    finishNews += r.finishNews;
  }
  if (touched.length > 0) {
    console.log(
      `[tour-finish-refresh] patched ${touched.length} comp(s): ${touched.join(", ")}` +
        ` (finishEvents=${finishEvents}, finishNews=${finishNews})`
    );
  } else {
    // 全幂等静默：只有补写了东西才落日志，避免每分钟刷屏滚爆磁盘（同 preheat-cron 口径）
    console.log(
      `[tour-finish-refresh] idle: ${comps.length} window comp(s) checked in ${Date.now() - t0}ms`
    );
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[tour-finish-refresh] FAILED:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});

// ── crontab 配置（生产 deploy@60.205.137.210，上线部署时配置）──────────
// 每分钟补写（flock 防叠批；idle 时静默一行，有补写才明细）：
//   * * * * * cd /home/deploy/saolei.wang && /usr/bin/flock -n /tmp/tour-finish.lock \
//     /usr/bin/env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/tour-finish-refresh.ts \
//     >> /home/deploy/logs/tour-finish.log 2>&1
