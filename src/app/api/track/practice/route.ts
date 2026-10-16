// 练习局埋点采集（2026-10-16）：/online 每局结束由 OnlinePlay report() 上报（胜/负都记）。
// uid 服务端从 session 取，不信任客户端；字段只做粗校验（粉丝站轻量方案，接受伪造威胁模型）。
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
  await prisma.practiceLog.create({
    data: {
      userId: session ? BigInt(session.uid) : null,
      level,
      won: !!body.won,
      csec: Math.round(csec),
      bbbv,
      solvedBv,
      nf: !!body.nf,
      clicks,
      createTime: Math.floor(Date.now() / 1000),
    },
  });
  return NextResponse.json({ ok: true });
}
