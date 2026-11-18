// 比赛报名接口（POST /api/competition/join，2026-11-13）
// 仅未开始的比赛可报名；一人一比赛一条（唯一索引防重）。
// 进行中/已结束的比赛返回明确错误——报名闸只认「未开始」。
// DELETE 同路径退赛（2026-11-13 五轮 20:13 张老师定：已报名 hover「退赛」，
// confirmDialog 确认后调本接口）；同样只认「未开始」，退赛不写动态
// （动态板块无退赛事件类型，张老师未要求）。

import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { addCompEvent, COMP_EVENT_PLAYER_JOIN, compStatus } from "@/lib/competition";

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

  // 「玩家报名参加」动态（2026-11-13 二期：详情页动态板块）
  await addCompEvent(Number(comp.id), COMP_EVENT_PLAYER_JOIN, session.uid);

  return NextResponse.json({ ok: true });
}

/** 退赛（DELETE 同路径，五轮 20:13）：仅未开始可退；幂等删一条报名记录 */
export async function DELETE(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: "请先登录后再操作" }, { status: 401 });
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
      { ok: false, error: st === "active" ? "比赛已开始，无法退赛" : "比赛已结束，无法退赛" },
      { status: 400 }
    );
  }

  const del = await prisma.competitionEntry.deleteMany({
    where: { competitionId: comp.id, userId: BigInt(session.uid) },
  });
  if (del.count === 0) {
    return NextResponse.json({ ok: false, error: "你尚未报名这场比赛" }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
