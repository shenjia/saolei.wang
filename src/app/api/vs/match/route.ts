// /vs 对决选择页「匹配对手」接口（2026-11-11 21:08 张老师新口径）：
// GET /api/vs/match?exclude=id1,id2
//   → 以**登录者三级（初级/中级/高级）STNB 总分**（user_stnb_best 落盘表
//     SUM(stnb)，与卡片/雷达同源）为基准，先在上下浮动 5% 窗口内随机挑一名
//     玩家；窗口内无人则逐级扩大 10%、15%……直到找到为止，返回 { id, total, pct }；
//   → 客户端拿到 id 后走 /api/vs/player 渲染卡片。
// 仅登录可用；无任何 STNB 成绩返回 404 no_stnb。
// exclude：登录者自己恒排除；场上已有玩家一并排除（不能匹配同站两边）。
// （旧口径＝全国排名 ±50 名窗口，21:08 张老师定改为 STNB 总分浮动窗）

import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/** 起步浮动比例与步长（%）：5% → 10% → 15% ……；100% 必中（全员皆候选），
 *  循环天然有界，无需额外封顶 */
const STEP = 5;

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

  // 我的 STNB 总分（三级各有各行，SUM 覆盖已有级别；无任何成绩=无法匹配）
  const mine = await prisma.$queryRaw<{ s: number | null }[]>`
    SELECT SUM(stnb) s FROM user_stnb_best WHERE user = ${BigInt(uid)}`;
  const myTotal = Number(mine[0]?.s ?? 0);
  if (!myTotal) {
    return NextResponse.json({ error: "no_stnb" }, { status: 404 });
  }

  // 逐级扩大窗口找候选（user_stnb_best 按 (user,level) 主键聚组，万级行全扫
  // 毫秒级；窗口内全取 JS 随机，不值得 ORDER BY RAND()）
  for (let pct = STEP; pct <= 100; pct += STEP) {
    const lo = myTotal * (1 - pct / 100);
    const hi = myTotal * (1 + pct / 100);
    const cands = await prisma.$queryRaw<{ user: bigint }[]>`
      SELECT user FROM user_stnb_best
      WHERE user NOT IN (${Prisma.join(exBits)})
      GROUP BY user
      HAVING SUM(stnb) BETWEEN ${lo} AND ${hi}`;
    if (!cands.length) continue;
    const picked = cands[Math.floor(Math.random() * cands.length)];
    return NextResponse.json({ id: Number(picked.user), total: myTotal, pct });
  }
  // 理论不可达（100% 窗口覆盖全部有成绩用户，除非全被 exclude）
  return NextResponse.json({ error: "no_candidate" }, { status: 404 });
}
