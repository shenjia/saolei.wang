// 比赛模式「总计成绩/排名」实时刷新接口（POST /api/tournament/my-score，
// 2026-11-22 张老师需求）：练习页比赛模式下每上传一盘，客户端调本接口拉取
// 最新总分与当前名次，标题行即时更新（不等刷新页面）。
// · 权限：仅登录态；比赛须进行中（start≤now<end）
// · 归属校验：race 参数命中**本人**未过期窗口会话才按个人窗过滤（防冒用他人
//   标识查别人成绩；集体赛/不命中按全局窗）
// · 返回 { score, rank, calc, filled }：getMyScoreValues 全量算分与详情页
//   排行榜完全同源（严格比较取名次；score 域=落库×1000）
// · 无有效成绩（窗口内无有效盘）→ score/rank=null，客户端显「—」

import { NextResponse } from "next/server";
import { getSession, renewSessionIfLow } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getMyScoreValues, parseScoreConfig } from "@/lib/tournament";

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  let body: { id?: unknown; race?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }
  const compId = Number(body.id);
  if (!Number.isInteger(compId) || compId <= 0) {
    return NextResponse.json({ error: "参数错误" }, { status: 400 });
  }
  const c = await prisma.tournament.findUnique({
    where: { id: BigInt(compId) },
    select: { startTime: true, endTime: true, scoreMode: true, scoreConfig: true },
  });
  if (!c) return NextResponse.json({ error: "比赛不存在" }, { status: 404 });
  const now = Math.floor(Date.now() / 1000);
  if (now < Number(c.startTime)) return NextResponse.json({ error: "比赛尚未开始" }, { status: 400 });
  if (now >= Number(c.endTime)) return NextResponse.json({ error: "比赛已结束" }, { status: 400 });

  // 窗口赛个人会话判窗（race 归属校验：只认本人的未过期会话）
  let sessWin: { start: number; end: number } | null = null;
  if (typeof body.race === "string" && body.race.length > 0 && body.race.length <= 32) {
    const sess = await prisma.tournamentWindowSession.findUnique({
      where: { race: body.race.toUpperCase() },
      select: { userId: true, startTime: true, endTime: true },
    });
    if (sess && Number(sess.userId) === session.uid && now <= Number(sess.endTime)) {
      sessWin = { start: Number(sess.startTime), end: Number(sess.endTime) };
    }
  }

  // 全量算分一次出齐（本人总分/名次/明细与排行榜同源；纯保底玩家 mine 由
  // getMyScoreValues 补算——「保底成绩也应该显示成绩和排名」张老师 2026-11-22 定）
  const r = await getMyScoreValues(compId, session.uid, sessWin);
  let score: number | null = null;
  let rank: number | null = null;
  if (r?.mine) {
    score = r.mine.score;
    const desc = parseScoreConfig(c.scoreMode, c.scoreConfig)?.desc ?? false;
    /* 名次 = 全量榜内严格更好的人数 + 1；纯保底补算的 mine 不在全量 Map
       （排行榜「无有效录像不上榜」口径不动），但名次仍按其保底总分与榜内
       严格比较得出——保底总分必然劣于任何实盘组合（配置端保证方向不倒挂），
       排在所有有盘玩家之后，语义正确 */
    rank = 1 + [...r.scores.values()].filter((s) => (desc ? s.score > r.mine!.score : s.score < r.mine!.score)).length;
  }

  const res = NextResponse.json({
    ok: true,
    score,
    rank,
    calc: r?.calc ?? [],
    // 逐盘明细（2026-11-24）：练习页比赛统计格按「该级别最好的 N 盘」渲染，
    // hover 显示该盘成绩（与总分同源，来自 computePlayerScores.detail）
    detail: r?.detail ?? [],
    filled: r?.filled ?? {},
  });
  // 比赛期间 30s tick 持续保活：session 剩余不足 1 天则重签续期（2026-11-24）。
  // 权威服务每次 WS 握手验 JWT exp，token 在对局中途到期会导致重连 401、局面丢失。
  await renewSessionIfLow(res, session);
  return res;
}
