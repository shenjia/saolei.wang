// 练习盘计数采集（2026-10-16 上线；2026-10-22 张老师定：改日汇总表，不再逐盘落行）
// /online 每局结束由 OnlinePlay report() 上报（胜/负都记），uid 服务端从 session 取，
// 不信任客户端。写入 practice_daily：当日当用户一行 UPSERT（plays+1、胜局再 wins+1）；
// 未登录归入 user_id=0 游客聚合行。字段粗校验仅防畸形请求（粉丝站轻量方案）。
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

const LEVELS = new Set(["beg", "int", "exp", "cus"]);

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const level = String(body.level ?? "");
  const csec = Number(body.csec);
  const bbbv = Number(body.bbbv);
  const solvedBv = Number(body.solvedBv);
  const clicks = Number(body.clicks);
  if (
    !LEVELS.has(level) ||
    !Number.isFinite(csec) || csec <= 0 || csec > 3_600_000 || // 10 小时封顶
    !Number.isInteger(bbbv) || bbbv < 1 || bbbv > 999 ||
    !Number.isInteger(solvedBv) || solvedBv < 0 || solvedBv > bbbv ||
    !Number.isInteger(clicks) || clicks < 0 || clicks > 99_999
  ) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const session = await getSession().catch(() => null);
  const now = Math.floor(Date.now() / 1000);
  const day = Math.floor((now + 28800) / 86400); // +08:00 切天序号（与全站日聚合口径一致）
  const uid = session ? BigInt(session.uid) : BigInt(0); // 0=游客聚合行（BigInt 字面量本仓禁用）
  const wonInt = body.won ? 1 : 0;
  // 原子 UPSERT：当日当用户无行则新建，有行则计数自增（并发局也安全）
  await prisma.$executeRaw`
    INSERT INTO practice_daily (day, user_id, plays, wins, create_time, update_time)
    VALUES (${day}, ${uid}, 1, ${wonInt}, ${now}, ${now})
    ON DUPLICATE KEY UPDATE
      plays = plays + 1,
      wins = wins + ${wonInt},
      update_time = ${now}
  `;
  return NextResponse.json({ ok: true });
}
