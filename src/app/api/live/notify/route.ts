// 粉丝端「正在练习」通知数据（2026-11-27 张老师需求）：登录玩家轮询，返回
// 我关注且正在直播（玩完至少一盘、含踩雷局）的主播摘要（姓名/性别/军衔/
// 头像）——客户端右下角悬浮气泡消费。
// 上线开关：默认开启；紧急关闭在服务器 .env 设 LIVE_ENABLED=0（2026-11-27 张老师确认上线）。

import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import path from "node:path";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { liveStreamers, viewerCount, getState } from "@/lib/live-rep";
import { followingSet } from "@/lib/follow";
import { resolveTitleDisplay, parseTitleSystem } from "@/lib/title-system";
import { resolveAvatarUrl, DEFAULT_AVATAR } from "@/lib/avatar";
import { TITLE_COLORS } from "@/lib/config";

/** 上线闸口（2026-11-27 张老师确认上线）：默认全站开启；
 *  紧急关闭只需在服务器 .env 设 LIVE_ENABLED=0（无需重新构建）。
 *  ⚠️ 不再用 host 前缀判断——nginx 配置变化即失效，且生产域名不叫 dev.* */
function liveEnabled(): boolean {
  return process.env.LIVE_ENABLED !== "0";
}

export const dynamic = "force-dynamic";

interface NotifyStreamer {
  uid: number;
  name: string;
  sex: number;
  title: string;
  titleColor: string;
  /** 头像 URL（登录主播一般有 player 墙图，此处复用 resolveAvatarUrl 口径
   *  ——头像兜底交给客户端 DefaultAvatar） */
  avatar: string;
  isDefault: boolean;
  /** 当前旁观人数（2026-11-27 14:16 张老师需求：气泡下沿显示「x人正在旁观」） */
  viewers: number;
  /** 比赛模式（2026-11-27 20:30 张老师定）：主播在比赛时真——气泡文案
   *  「正在练习」换「正在比赛」 */
  comp: boolean;
}

export async function GET(req: Request) {
  if (!liveEnabled()) return NextResponse.json({ error: "Not Found" }, { status: 404 });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const streamers = liveStreamers();
  if (!streamers.length) return NextResponse.json({ ok: true, streamers: [] });
  /* 粉丝视角过滤：只看「我关注且非我」的主播 */
  const mySet = await followingSet(session.uid, streamers.map((s) => s.uid));
  const candidates = streamers.filter((s) => mySet.has(s.uid));
  if (!candidates.length) return NextResponse.json({ ok: true, streamers: [] });
  /* 摘要组装（姓名/性别/军衔/头像） */
  const users = await prisma.user.findMany({
    where: { id: { in: candidates.map((c) => BigInt(c.uid)) } },
    select: { id: true, chineseName: true, englishName: true, sex: true, avatar: true, status: true },
  });
  const scores = await prisma.userScores.findMany({
    where: { id: { in: candidates.map((c) => BigInt(c.uid)) } },
    select: { id: true, expTime: true },
  });
  const scoreMap = new Map(scores.map((s) => [Number(s.id), Number(s.expTime ?? 0)]));
  const out: NotifyStreamer[] = [];
  for (const u of users) {
    const uid = Number(u.id);
    const t = await resolveTitleDisplay(
      parseTitleSystem(null),
      scoreMap.get(uid) ?? 0,
      u.status === 0 && (scoreMap.get(uid) ?? 0) > 0,
      u.sex,
      uid,
    );
    /* 头像：默认墙图存在时给 URL，否则空串（客户端 DefaultAvatar 兜底） */
    const hasWall = u.avatar === "1"
      && existsSync(path.join(process.cwd(), "public", "images", "player", `${uid}.jpg`));
    const avatar = resolveAvatarUrl(u.avatar, hasWall ? `/images/player/${uid}.jpg` : DEFAULT_AVATAR);
    out.push({
      uid,
      name: u.chineseName,
      sex: u.sex,
      title: t.name,
      titleColor: t.color ?? TITLE_COLORS[t.name] ?? "#939387",
      avatar,
      isDefault: avatar === DEFAULT_AVATAR,
      viewers: viewerCount(uid), /* 旁观数（>0 时气泡显示「x人正在旁观」） */
      comp: !!getState(uid)?.compId, /* 比赛模式（20:30 张老师定）→「正在比赛」 */
    });
  }
  return NextResponse.json({ ok: true, streamers: out });
}
