// 比赛报名接口（POST /api/competition/join，2026-11-13）
// 仅未开始的比赛可报名；一人一比赛一条（唯一索引防重）。
// 进行中/已结束的比赛返回明确错误——报名闸只认「未开始」。

import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { compStatus } from "@/lib/competition";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: "请先登录后再报名" }, { status: 401 });
  }

  let body: { id?: unknown };
  try {
    body = (await req.json()) as { id?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "参数错误" }, { status: 400 });
  }
  const id = parseInt(String(body.id ?? ""), 10);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "参数错误" }, { status: 400 });
  }

  const comp = await prisma.competition.findUnique({ where: { id: BigInt(id) } });
  if (!comp) {
    return NextResponse.json({ ok: false, error: "比赛不存在" }, { status: 404 });
  }

  const now = Math.floor(Date.now() / 1000);
  const st = compStatus(comp.startTime, comp.endTime, now);
  if (st !== "upcoming") {
    return NextResponse.json(
      { ok: false, error: st === "active" ? "比赛已开始，无法报名" : "比赛已结束，无法报名" },
      { status: 400 }
    );
  }

  try {
    await prisma.competitionEntry.create({
      data: {
        competitionId: comp.id,
        userId: BigInt(session.uid),
        createTime: BigInt(now),
      },
    });
  } catch (e) {
    // 唯一索引冲突 = 重复报名（并发双击兜底）
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json({ ok: false, error: "你已报名过这场比赛" }, { status: 400 });
    }
    throw e;
  }

  return NextResponse.json({ ok: true });
}
