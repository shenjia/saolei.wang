import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * 录像观看时长上报（2026-11-10 张老师定：每累计观看 1 分钟记 1 点活跃值）。
 * body: { videoId: number, watchMs: number }
 * - 只认登录态（getSession）：未登录的观看不计活跃值，直接忽略
 * - 前端在原地回放 playing 状态下累计前台可见毫秒（切后台/暂停不计），
 *   页面隐藏/卸载/路由切换时上报累计值；多次上报服务端累加（不是覆盖）
 * - watchMs 上限 30 分钟/次（防脏数据），正整数校验；videoId 存在性不查库
 *   （外键无业务意义，脏 id 只污染一行统计，按轻量方案放行）
 * - 单条 60s 内同 用户×录像 去重（防组件 StrictMode 双执行/重复挂载刷量）；
 *   进程内 Map 节流，正常观看节奏（暂停/隐藏才上报）天然稀疏
 * - 服务端按 +08:00 切天序号落 user_watch_daily（用户×日×录像 唯一键累加）；
 *   跨天边界按服务端收到时刻切天，观看中跨零点的最后一段计入新的一天（可接受）
 */
const MAX_WATCH_MS = 30 * 60 * 1000;
const DEDUPE_MS = 60 * 1000;

// 进程内节流：uid|videoId -> 上次落库 wall clock（ms）
const lastReport = new Map<string, number>();

/** 清理节流 Map 防膨胀（每 1000 条整表清一次，误杀窗口 60s 可接受） */
function maybePrune() {
  if (lastReport.size < 1000) return;
  const now = Date.now();
  for (const [k, t] of lastReport) {
    if (now - t > DEDUPE_MS) lastReport.delete(k);
  }
}

export async function POST(request: NextRequest) {
  let body: { videoId?: number; watchMs?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const videoId = Number(body.videoId);
  const watchMs = Number(body.watchMs);
  if (
    !Number.isInteger(videoId) ||
    videoId <= 0 ||
    videoId > 4_000_000 ||
    !Number.isFinite(watchMs) ||
    watchMs <= 0
  ) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const session = await getSession().catch(() => null);
  if (!session) {
    // 未登录不计（观看活跃值只激励注册用户）
    return NextResponse.json({ ok: true, skipped: true, anon: true });
  }
  const uid = session.uid;

  const clamped = Math.min(Math.round(watchMs), MAX_WATCH_MS);
  const key = `${uid}|${videoId}`;
  const now = Date.now();
  if (now - (lastReport.get(key) ?? 0) < DEDUPE_MS) {
    return NextResponse.json({ ok: true, deduped: true });
  }
  lastReport.set(key, now);
  maybePrune();

  const nowSec = Math.floor(now / 1000);
  const day = Math.floor((nowSec + 28800) / 86400); // +08:00 切天序号（同 practice_daily）
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO user_watch_daily (user_id, day, video_id, watch_ms, create_time, update_time)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE watch_ms = watch_ms + VALUES(watch_ms), update_time = VALUES(update_time)`,
      BigInt(uid),
      day,
      BigInt(videoId),
      BigInt(clamped),
      nowSec,
      nowSec,
    );
  } catch {
    // 落库失败静默（尽力而为的统计，不值得重试拖累请求）
  }
  return NextResponse.json({ ok: true });
}
