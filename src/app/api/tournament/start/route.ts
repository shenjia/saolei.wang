// 窗口赛手动开赛接口（POST /api/tournament/start，2026-11-19 张老师定）
// 仅 windowHours>0 且已开赛（start≤now<end）的比赛可手动开赛：
// · 生成个人随机标识 race（6 位大写字母数字，全局唯一，冲突重试）
// · 个人窗口 = [now, min(now + windowHours*3600, comp.end)]——窗口整体钳在比赛范围内
// · 一人一比赛同时只有一个进行中窗口（已有未过期会话 → 直接返回它，幂等）
// · 防连点：unique(tournamentId, userId, startTime) 兜底
// 标识一旦过期即失效：上传挂接判据只认 endTime>now 的会话（matchTourByRace 扩展）。

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

const RACE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去 I/O/0/1 易混字符

async function genRace(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    let race = "";
    for (let i = 0; i < 6; i++) {
      race += RACE_CHARS[Math.floor(Math.random() * RACE_CHARS.length)];
    }
    const dup = await prisma.tournamentWindowSession.findUnique({ where: { race } });
    if (!dup) return race;
  }
  throw new Error("race gen exhausted");
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: "请先登录" }, { status: 401 });
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
  const comp = await prisma.tournament.findUnique({ where: { id: BigInt(id) } });
  if (!comp) {
    return NextResponse.json({ ok: false, error: "比赛不存在" }, { status: 404 });
  }
  if ((comp.windowHours ?? 0) <= 0) {
    return NextResponse.json({ ok: false, error: "该比赛为同期集体赛，无需手动开赛" }, { status: 400 });
  }
  const now = Math.floor(Date.now() / 1000);
  if (now < comp.startTime) {
    return NextResponse.json({ ok: false, error: "比赛尚未开始" }, { status: 400 });
  }
  if (now >= comp.endTime) {
    return NextResponse.json({ ok: false, error: "比赛已结束" }, { status: 400 });
  }

  // 幂等：已有进行中会话直接返回
  const existed = await prisma.tournamentWindowSession.findFirst({
    where: { tournamentId: comp.id, userId: BigInt(session.uid), endTime: { gt: BigInt(now) } },
    select: { race: true, startTime: true, endTime: true },
    orderBy: { endTime: "desc" },
  });
  if (existed) {
    return NextResponse.json({
      ok: true,
      race: existed.race,
      start: Number(existed.startTime),
      end: Number(existed.endTime),
      reused: true,
    });
  }

  const race = await genRace();
  const start = now;
  const end = Math.min(now + (comp.windowHours ?? 0) * 3600, Number(comp.endTime));
  try {
    const created = await prisma.tournamentWindowSession.create({
      data: {
        tournamentId: comp.id,
        userId: BigInt(session.uid),
        race,
        startTime: BigInt(start),
        endTime: BigInt(end),
        createTime: BigInt(now),
      },
    });
    return NextResponse.json({
      ok: true,
      race: created.race,
      start: Number(created.startTime),
      end: Number(created.endTime),
      reused: false,
    });
  } catch {
    // 并发连点撞唯一索引 → 读回已存在会话
    const again = await prisma.tournamentWindowSession.findFirst({
      where: { tournamentId: comp.id, userId: BigInt(session.uid), endTime: { gt: BigInt(now) } },
      select: { race: true, startTime: true, endTime: true },
      orderBy: { endTime: "desc" },
    });
    if (again) {
      return NextResponse.json({
        ok: true,
        race: again.race,
        start: Number(again.startTime),
        end: Number(again.endTime),
        reused: true,
      });
    }
    return NextResponse.json({ ok: false, error: "开赛失败，请重试" }, { status: 500 });
  }
}
