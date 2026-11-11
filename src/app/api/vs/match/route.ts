// /vs 对决选择页「匹配对手」接口（2026-11-11 张老师需求）：
// GET /api/vs/match?exclude=id1,id2
//   → 以**登录者**全国排名（user_rank.national，与卡片「全国第 N 名」同源）
//     为基准，上下浮动 50 名窗口内随机挑一名玩家，返回 { id }；
//   → 客户端拿到 id 后走 /api/vs/player 渲染卡片。
// 仅登录可用；无排名（无成绩不在榜）返回 404 no_rank。
// exclude：登录者自己恒排除；场上已有玩家一并排除（不能匹配同站两边）。

import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/** 匹配窗口：上下浮动 50 名（2026-11-11 张老师口径） */
const WINDOW = 50;

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

  const mine = await prisma.$queryRaw<{ national: number }[]>`
    SELECT national FROM user_rank WHERE id = ${BigInt(uid)}`;
  if (!mine.length) {
    return NextResponse.json({ error: "no_rank" }, { status: 404 });
  }
  const r = Number(mine[0].national);

  // 窗口内候选（user_rank 落盘表只含有成绩在榜用户，无需再 JOIN user 过滤）；
  // 全量取出后 JS 随机——窗口至多 ~101 行，不值得 ORDER BY RAND() 全扫
  const cands = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT id FROM user_rank
    WHERE national >= ${r - WINDOW} AND national <= ${r + WINDOW}
      AND id NOT IN (${Prisma.join([...exclude].map((x) => BigInt(x)))})`;
  if (!cands.length) {
    return NextResponse.json({ error: "no_candidate" }, { status: 404 });
  }
  const picked = cands[Math.floor(Math.random() * cands.length)];
  return NextResponse.json({ id: Number(picked.id), rank: r });
}
