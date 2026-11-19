// /vs 对决选择页「匹配对手」接口（2026-11-11 21:46 张老师定稿口径）：
// GET /api/vs/match?base=id[&avoid=id1,id2,…]
//   → 池子＝**高级（exp）STNB 在基准玩家窗口内** 且 **全国排名在基准玩家 ±10 内**
//     的玩家，随机挑一名返回 { id, pct, rankWin }；
//   → STNB 窗口半宽 = max(基准STNB × 5k%, **10 × k**)——比例与绝对下限取大者
//     （2026-11-13 张老师定：低 STNB 玩家按纯比例 ±5% 绝对宽度太小匹配不到人，
//     绝对下限每轮 ±10 个 STNB 点递增；高 STNB 玩家比例项自然接管）；
//   → 池内无人则两维度**同步**逐步扩大（STNB 半宽每轮 +10 个点……，排名 ±20/±30……），
//     直到找到为止（与 21:08「直到找到为止」口径一脉相承）；
//   → 防短期重复（2026-11-13 张老师定）：对决是单向发起（A 挑战 B，B 无感知），
//     服务端不建流水——客户端 localStorage 记最近 1h 匹配出过的对手 id，经
//     avoid 参数上报，服务端照单排除（软约束：客户端篡改/丢档最多重复出现，
//     无安全影响）；两遍扫描兜底——第一遍带排除，全扫仍无人 → 第二遍放开排除
//     再扫一遍，绝不因防重复而匹配失败；
//   → 客户端拿到 id 后走 /api/vs/player 渲染卡片。
// 仅登录可用；基准玩家无高级 STNB 成绩 → 404 no_exp_stnb，无全国排名 → 404 no_rank。
// base：匹配基准玩家 id（2026-11-12 张老师：竞技场可把自己换掉——匹配按**当下
//   场上现存那个玩家**的成绩/排名为基准，不是恒按登录者）；缺省＝登录者自己
//   （兼容旧口径，服务端兜底）。基准玩家自身恒排除（不能匹配出同站两边同一人）。
// （口径沿革：±50 名窗口 → 21:08 三级 STNB 总分 ±5% 逐级扩大 → 21:46 定稿
//   高级 STNB ±5% ∩ 排名 ±10——总分口径会被单级形态差异中和，高级 STNB
//   视作综合实力代表；→ 2026-11-12 基准改为场上现存玩家；→ 2026-11-13
//   STNB 半宽加绝对下限 10×k（与比例取大者）+ 1h 防重复排除（客户端
//   localStorage 上报 avoid，不建服务端流水表））

import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/** 起步窗口与步长：STNB 比例 ±5%（绝对下限 10×k 与之取大者）、排名 ±10，
 *  每轮同步扩大一档（5%→10%→…，10→20→…）；
 *  排名窗上限 100 亿级也必终局（全员覆盖），循环天然有界 */
const STNB_STEP = 5; // %
const STNB_FLOOR = 10; // STNB 半宽绝对下限（每轮 ×k 个点，2026-11-13 张老师定）
const RANK_STEP = 10; // 名
/** avoid 上报上限：本地 24h 记录远到不了这个量级，防御性截断 */
const AVOID_MAX = 200;

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // 匹配基准：场上现存玩家（base），缺省＝登录者自己（服务端兜底）
  const baseId =
    parseInt(new URL(req.url).searchParams.get("base") ?? "", 10) || session.uid;
  // 防重复排除名单（客户端 localStorage 上报）：只收合法正整数、截断防御
  const avoidIds = (new URL(req.url).searchParams.get("avoid") ?? "")
    .split(",")
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, AVOID_MAX);

  // 基准玩家的高级 STNB 与全国排名（池子两维度都以基准玩家为基准，缺一不可）
  const [mineStnb, mineRank] = await Promise.all([
    prisma.$queryRaw<{ stnb: number }[]>`
      SELECT stnb FROM user_stnb_best WHERE user = ${BigInt(baseId)} AND level = "exp"`,
    prisma.$queryRaw<{ national: number }[]>`
      SELECT national FROM user_rank WHERE id = ${BigInt(baseId)}`,
  ]);
  if (!mineStnb.length) {
    return NextResponse.json({ error: "no_exp_stnb" }, { status: 404 });
  }
  if (!mineRank.length) {
    return NextResponse.json({ error: "no_rank" }, { status: 404 });
  }
  const myStnb = Number(mineStnb[0].stnb);
  const myRank = Number(mineRank[0].national);

  // 一轮完整扩窗扫描（user_rank 有 national 索引，JOIN 落盘表毫秒级；
  // 窗口内全取 JS 随机，不值得 ORDER BY RAND()）。extra＝额外排除的近期对手。
  const scan = async (extra: number[]) => {
    const exclude = [baseId, ...extra];
    for (let k = 1; k <= 20; k++) {
      const pct = STNB_STEP * k;
      const rankWin = RANK_STEP * k;
      // STNB 半宽：比例项与绝对下限取大者（低 STNB 靠下限保证绝对宽度）
      const half = Math.max((myStnb * pct) / 100, STNB_FLOOR * k);
      const cands = await prisma.$queryRaw<{ id: bigint }[]>`
        SELECT r.id FROM user_rank r
        JOIN user_stnb_best s ON s.user = r.id AND s.level = "exp"
        WHERE r.id NOT IN (${Prisma.join(exclude.map((x) => BigInt(x)))})
          AND s.stnb BETWEEN ${myStnb - half} AND ${myStnb + half}
          AND r.national BETWEEN ${myRank - rankWin} AND ${myRank + rankWin}`;
      if (!cands.length) continue;
      const picked = cands[Math.floor(Math.random() * cands.length)];
      return { id: Number(picked.id), pct, rankWin };
    }
    return null;
  };

  // 两遍兜底：第一遍带 24h 防重复排除；全扫仍无人 → 第二遍放开排除
  // （保证永不因防重复而匹配失败）；理论不可达才报 no_candidate
  const picked = (await scan(avoidIds)) ?? (await scan([]));
  if (!picked) {
    return NextResponse.json({ error: "no_candidate" }, { status: 404 });
  }
  return NextResponse.json(picked);
}