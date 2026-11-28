// 窗口赛手动开赛接口（POST /api/tournament/start，2026-11-19 张老师定）
// 仅 windowHours>0 且已开赛（start≤now<end）的比赛可手动开赛：
// · 生成个人随机标识 race（6 位大写字母数字，全局唯一，冲突重试）
// · 个人窗口 = [now, min(now + windowHours*3600, comp.end)]——窗口整体钳在比赛范围内
// · **一人一比赛只能开赛一次（2026-11-22 张老师定，18875 双会话事故）**：已存在
//   任意历史会话（含已过期）一律拒绝——原口径「有进行中会话就复用」挡不住
//   窗口结束后再点「开始比赛」开出第二个窗口（旧成绩按新窗口判窗全部消失）。
// · 防连点：unique(tournamentId, userId, startTime) 兜底
// 标识一旦过期即失效：上传挂接判据只认 endTime>now 的会话（matchTourByRace 扩展）。
// 开赛即补报名（2026-11-22 张老师定口径「有成绩就该有报名记录」的前置闸）：
// 创建窗口会话成功后立即 ensureTourEntry——报名动态 createTime=窗口 start_time。
// 此前只建会话不报名，玩家点开赛但尚未上传录像期间无任何报名动态（35598 案）。

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ensureTourEntry, bumpTourRankRev } from "@/lib/tournament";

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

  // 一次开赛铁律（2026-11-22 张老师定）：任意历史会话存在即拒绝（含已过期），
  // 绝不生成第二个窗口。进行中会话返回其信息（幂等，防连点双开）；
  // 已过期会话=已完赛，明确报错不可重开。
  const anySession = await prisma.tournamentWindowSession.findFirst({
    where: { tournamentId: comp.id, userId: BigInt(session.uid) },
    select: { race: true, startTime: true, endTime: true },
    orderBy: { startTime: "desc" },
  });
  if (anySession) {
    if (anySession.endTime > BigInt(now)) {
      // 进行中：直接返回现有会话（幂等）；顺带幂等补报名（防存量会话无报名行）
      await ensureTourEntry(id, session.uid, {
        windowStartSec: Number(anySession.startTime),
      });
      return NextResponse.json({
        ok: true,
        race: anySession.race,
        start: Number(anySession.startTime),
        end: Number(anySession.endTime),
        reused: true,
      });
    }
    return NextResponse.json(
      { ok: false, error: "你已完成本场比赛，不能再次开赛" },
      { status: 400 }
    );
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
    // 开赛即补报名：报名行+比赛动态 type=2+个人动态 type=58，报名时间=窗口 start_time
    await ensureTourEntry(id, session.uid, { windowStartSec: start });
    // 名次快照打脏（2026-11-28）：新会话改变该玩家的判窗集合（进行中幂等返回不打）
    await bumpTourRankRev(id);
    return NextResponse.json({
      ok: true,
      race: created.race,
      start: Number(created.startTime),
      end: Number(created.endTime),
      reused: false,
    });
  } catch {
    // 并发连点撞唯一索引 → 读回已存在会话（含历史会话：有人抢在前面开成了）
    const again = await prisma.tournamentWindowSession.findFirst({
      where: { tournamentId: comp.id, userId: BigInt(session.uid) },
      select: { race: true, startTime: true, endTime: true },
      orderBy: { startTime: "desc" },
    });
    if (again) {
      if (again.endTime > BigInt(now)) {
        return NextResponse.json({
          ok: true,
          race: again.race,
          start: Number(again.startTime),
          end: Number(again.endTime),
          reused: true,
        });
      }
      return NextResponse.json(
        { ok: false, error: "你已完成本场比赛，不能再次开赛" },
        { status: 400 }
      );
    }
    return NextResponse.json({ ok: false, error: "开赛失败，请重试" }, { status: 500 });
  }
}
