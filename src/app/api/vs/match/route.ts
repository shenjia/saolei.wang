// /vs 对决选择页「匹配对手」接口（2026-11-11 21:46 张老师定稿口径）：
// GET /api/vs/match?exclude=id1,id2
//   → 池子＝**高级（exp）STNB 在登录者 ±5% 内** 且 **全国排名在登录者 ±10 内**
//     的玩家，随机挑一名返回 { id, pct, rankWin }；
//   → 池内无人则两个维度**同步**逐步扩大（STNB ±10%/±15%……，排名 ±20/±30……），
//     直到找到为止（与 21:08「直到找到为止」口径一脉相承）；
//   → 客户端拿到 id 后走 /api/vs/player 渲染卡片。
// 仅登录可用；无高级 STNB 成绩 → 404 no_exp_stnb，无全国排名 → 404 no_rank。
// exclude：登录者自己恒排除；场上已有玩家一并排除（不能匹配同站两边）。
// （口径沿革：±50 名窗口 → 21:08 三级 STNB 总分 ±5% 逐级扩大 → 21:46 定稿
//   高级 STNB ±5% ∩ 排名 ±10——总分口径会被单级形态差异中和，高级 STNB
//   视作综合实力代表）

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
  const uid = session.uid;
  const exclude = new Set<number>([uid]);
  for (const s of (new URL(req.url).searchParams.get("exclude") ?? "").split(",")) {
    const n = parseInt(s, 10);
    if (n > 0) exclude.add(n);
  }
  const exBits = [...exclude].map((x) => BigInt(x));

  // 我的高级 STNB 与全国排名（池子两维度都以登录者为基准，缺一不可）
  const [mineStnb, mineRank] = await Promise.all([
    prisma.$queryRaw<{ stnb: number }[]>`
      SELECT stnb FROM user_stnb_best WHERE user = ${BigInt(uid)} AND level = "exp"`,
    prisma.$queryRaw<{ national: number }[]>`
      SELECT national FROM user_rank WHERE id = ${BigInt(uid)}`,
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
      WHERE r.id NOT IN (${Prisma.join(exBits)})
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
