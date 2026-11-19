// 每日一星评选 cron（2026-10-25 上线配套；张老师定「每日凌晨决定新星星」）
// 语义：调用 getTodayStar()——star 表当日无行则按定稿口径评选（候选池两路并集、
// 头像权重×2、30 日不复选、日期哈希确定性随机）并补发当选动态（type=54 金色）
// 与系统私信；当日已有行则幂等跳过。此后首页首访只读不评，通知时刻固定在凌晨。
//
// 与 rank-snapshot-refresh 的顺序关系：本脚本排在 00:05 快照刷新之后（建议 00:15），
// 让「排名上升（delta>0）」条件用当日最新快照——凌晨刚评完名次就抽，语义贴合
// 「30 天内有打破过记录且排名处上升状态者」的公示口径。
//
// 用法（crontab 每天 00:15，同 rank-snapshot-refresh 模式）：
//   env -u NODE_OPTIONS node --experimental-transform-types \
//     --import ./scripts/sync/ts-extension-loader.mjs scripts/star-elect.ts
// 运行环境：项目根目录（.env 由 src/lib/db 读入；生产在 /home/deploy/saolei.wang）。

import { getTodayStar } from "../src/lib/star";
import { prisma } from "../src/lib/db";

async function main() {
  const t0 = Date.now();
  console.log(`[star-elect] start`);
  const star = await getTodayStar();
  if (!star?.user) {
    console.log(`[star-elect] no candidate — 今日无符合条件者（star 不落行，首页不展示卡片）`);
  } else {
    console.log(
      `[star-elect] elected user=${star.user.id} (${star.user.chineseName}) date=${star.date}` +
        (star.speech ? ` speech="${star.speech}"` : "")
    );
  }
  console.log(`[star-elect] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[star-elect] FAILED:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
