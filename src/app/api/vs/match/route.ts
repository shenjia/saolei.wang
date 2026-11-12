// /vs 对决选择页「匹配对手」接口（2026-11-11 21:46 张老师定稿口径）：
// GET /api/vs/match?base=id
//   → 池子＝**高级（exp）STNB 在基准玩家 ±5% 内** 且 **全国排名在基准玩家 ±10 内**
//     的玩家，随机挑一名返回 { id, pct, rankWin }；
//   → 池内无人则两个维度**同步**逐步扩大（STNB ±10%/±15%……，排名 ±20/±30……），
//     直到找到为止（与 21:08「直到找到为止」口径一脉相承）；
//   → 客户端拿到 id 后走 /api/vs/player 渲染卡片。
// 仅登录可用；基准玩家无高级 STNB 成绩 → 404 no_exp_stnb，无全国排名 → 404 no_rank。
// base：匹配基准玩家 id（2026-11-12 张老师：竞技场可把自己换掉——匹配按**当下
//   场上现存那个玩家**的成绩/排名为基准，不是恒按登录者）；缺省＝登录者自己
//   （兼容旧口径，服务端兜底）。基准玩家自身恒排除（不能匹配出同站两边同一人）。
// （口径沿革：±50 名窗口 → 21:08 三级 STNB 总分 ±5% 逐级扩大 → 21:46 定稿
//   高级 STNB ±5% ∩ 排名 ±10——总分口径会被单级形态差异中和，高级 STNB
//   视作综合实力代表；→ 2026-11-12 基准改为场上现存玩家）

import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/** 起步窗口与步长：STNB ±5%、排名 ±10，每轮同步扩大一档（5%→10%→…，10→20→…）；
 *  排名窗上限 100 亿级也必终局（全员覆盖），循环天然有界 */
const STNB_STEP = 5; // %
const RANK_STEP = 10; // 名

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // 匹配基准：场上现存玩家（base），缺省＝登录者自己（服务端兜底）
  const baseId =
    parseInt(new URL(req.url).searchParams.get("base") ?? "", 10) || session.uid;
  const exclude = new Set<number>([baseId]);

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

  // 两个维度同步扩大窗口找候选（user_rank 有 national 索引，JOIN 落盘表毫秒级；
  // 窗口内全取 JS 随机，不值得 ORDER BY RAND()）
  for (let k = 1; k <= 20; k++) {
    const pct = STNB_STEP * k;
    const rankWin = RANK_STEP * k;
    const cands = await prisma.$queryRaw<{ id: bigint }[]>`
      SELECT r.id FROM user_rank r
      JOIN user_stnb_best s ON s.user = r.id AND s.level = "exp"
      WHERE r.id NOT IN (${Prisma.join([...exclude].map((x) => BigInt(x)))})
        AND s.stnb BETWEEN ${myStnb * (1 - pct / 100)} AND ${myStnb * (1 + pct / 100)}
        AND r.national BETWEEN ${myRank - rankWin} AND ${myRank + rankWin}`;
    if (!cands.length) continue;
    const picked = cands[Math.floor(Math.random() * cands.length)];
    return NextResponse.json({
      id: Number(picked.id),
      pct,
      rankWin,
    });
  }
  // 理论不可达（窗口足够大后覆盖全部有成绩在榜用户，除非全被 exclude）
  return NextResponse.json({ error: "no_candidate" }, { status: 404 });
}
