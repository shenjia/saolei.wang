// 回填 practice_daily 分级别完成盘数（2026-11-06 张老师要求：以往数据按现行规则清洗，
// 让所有地区的活跃指数立即按新口径生效，不必等 7 日窗口自然滚齐）。
//
// 回填规则（现行口径 = areaactivity.ts 的 LEVEL_WEIGHTS 加权前提）：
//   对 wins_beg/int/exp/cus 全 0 且 wins>0 的日行，按**该行自己**的级别尝试占比分配 wins：
//     cus 尝试 = plays − plays_beg − plays_int − plays_exp（路由口径：cus 只进 plays 总数）
//     四份 shares = wins × 各自尝试 / plays，最大余数法取整，保证四列之和恰好 = wins。
//   · 跳过已含实时分级别数据的行（四列不全 0）——那是上报路由的真实记录，绝不覆盖。
//   · plays_beg 起记日 2026-10-27，此前行无级别明细、无法还原，保持 0（既往不咎；
//     活跃指数只看近 7 日 = 10-31 起，均在明细覆盖内，不受影响）。
//     ⚠️ 不能靠「三列全 0」判无明细——真正的纯自定义日行三列也是 0；
//     必须按 day < 起记日序号硬跳过，否则历史行全量灌进 cus（首跑实测 320/417 全错）。
//
// 幂等：再跑一遍时候选集为空（被回填的行四列已非全 0，被跳过的行依旧跳过）。
// 跑法（本地/生产同）：set -a && . ./.env && set +a && \
//   env -u NODE_OPTIONS node --experimental-transform-types \
//   --import ./scripts/sync/ts-extension-loader.mjs scripts/backfill-practice-wins-by-level.ts

import { prisma } from "../src/lib/db";

/** 分级别尝试列起记日（2026-10-27，+08:00 切天序号；实测该日 MIN(day)=20753） */
const LEVEL_SINCE_DAY = Math.floor(Date.UTC(2026, 9, 27) / 86400000);

interface DailyRow {
  id: bigint;
  day: number;
  wins: number;
  plays: number;
  plays_beg: number;
  plays_int: number;
  plays_exp: number;
}

/** 最大余数法：把 total 按权重 weights 分成非负整数份，和恰好等于 total */
function largestRemainder(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  const shares = weights.map((w) => (total * w) / sum);
  const base = shares.map((s) => Math.floor(s));
  let rest = total - base.reduce((a, b) => a + b, 0); // 0..len-1
  const order = shares
    .map((s, i) => ({ i, frac: s - Math.floor(s) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < order.length && rest > 0; k++, rest--) base[order[k].i] += 1;
  return base;
}

async function main() {
  const rows = await prisma.$queryRawUnsafe<DailyRow[]>(
    `SELECT id, day, wins, plays, plays_beg, plays_int, plays_exp
     FROM practice_daily
     WHERE wins > 0 AND wins_beg = 0 AND wins_int = 0 AND wins_exp = 0 AND wins_cus = 0
       AND day >= ${LEVEL_SINCE_DAY}`,
  );
  let filled = 0;
  let skippedAllCus = 0;
  const totals = { beg: 0, int: 0, exp: 0, cus: 0 };
  for (const r of rows) {
    const wins = Number(r.wins);
    const plays = Number(r.plays);
    const pb = Number(r.plays_beg);
    const pi = Number(r.plays_int);
    const pe = Number(r.plays_exp);
    const pc = Math.max(0, plays - pb - pi - pe); // cus 尝试（路由口径：cus 只进 plays 总数）
    if (plays <= 0) {
      skippedAllCus++;
      continue;
    }
    const [wb, wi, we, wc] = largestRemainder(wins, [pb, pi, pe, pc]);
    await prisma.$executeRaw`UPDATE practice_daily
      SET wins_beg = ${wb}, wins_int = ${wi}, wins_exp = ${we}, wins_cus = ${wc}
      WHERE id = ${r.id}`;
    filled++;
    totals.beg += wb;
    totals.int += wi;
    totals.exp += we;
    totals.cus += wc;
  }
  console.log(
    `[backfill-wins-by-level] rows=${rows.length} filled=${filled} skipped(all-cus-or-zero)=${skippedAllCus} ` +
      `wins redistributed: beg=${totals.beg} int=${totals.int} exp=${totals.exp} cus=${totals.cus}`,
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
