// 旁观观看页（2026-11-27 张老师需求）：粉丝进入玩家主页「在线练习中」入口，
// 看到玩家的排行局自动连播——无进度条、无「回放/上一局」字样，形态接近实时旁观。
// 数据源＝服务端按 gameId 落的 EVF（含踩雷/重开的局），局级下发天然杜绝实时报点。
//
// 权限闸：本页 SSR 只做「登录 + 未拉黑」的入口判断；关注态分两路（2026-11-27
// 张老师定）：未关注 → 引导态「XXX没有在练习」+ 关注按钮（真实关注状态）+
// 关注引导文案；已关注/本人 → LiveWatch 观看态。数据访问仍经 feed 路由二次鉴权。
// 上线开关：默认开启；紧急关闭在服务器 .env 设 LIVE_ENABLED=0（2026-11-27 张老师确认上线）。

import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { existsSync } from "node:fs";
import path from "node:path";
import { getSession } from "@/lib/auth";
import { isBlocked, isFollowing } from "@/lib/follow";
import { prisma } from "@/lib/db";
import { resolveTitleDisplay, parseTitleSystem } from "@/lib/title-system";
import { resolveAvatarUrl, DEFAULT_AVATAR } from "@/lib/avatar";
import { TITLE_COLORS } from "@/lib/config";
import { getOnlineMetricDists } from "@/lib/queries";
import { isLiveNow, getState } from "@/lib/live-rep";
import { AvatarFollowBtn } from "@/components/AvatarFollowBtn";
import { RankBadge } from "@/components/RankBadge";
import { DefaultAvatar } from "@/components/DefaultAvatar";
import { LiveWatch } from "./LiveWatch";
import { LiveGateAction } from "./LiveGateAction";

export const dynamic = "force-dynamic";

/** 上线闸口（2026-11-27 张老师确认上线）：默认全站开启；
 *  紧急关闭在服务器 .env 设 LIVE_ENABLED=0（无需重新构建） */
function liveEnabled(): boolean {
  return process.env.LIVE_ENABLED !== "0";
}

/** 观看页标题行数据：头像/中文名/性别/称号 + 玩家名 */
async function liveHost(uid: number) {
  const [u, sc] = await Promise.all([
    prisma.user.findUnique({
      where: { id: uid },
      select: {
        chineseName: true, englishName: true, sex: true, avatar: true,
        status: true,
      },
    }),
    prisma.userScores.findUnique({
      where: { id: uid },
      select: { expTime: true },
    }),
  ]);
  if (!u) notFound();
  const hasWallPhoto = u.avatar === "1"
    && existsSync(path.join(process.cwd(), "public", "images", "player", `${uid}.jpg`));
  const avatar = resolveAvatarUrl(u.avatar, hasWallPhoto ? `/images/player/${uid}.jpg` : DEFAULT_AVATAR);
  const isDefault = avatar === DEFAULT_AVATAR;
  const expMs = Number(sc?.expTime ?? 0);
  const t = await resolveTitleDisplay(
    parseTitleSystem(null), // 服务端默认体系（军衔制）；观看页不随观看者切换
    expMs,
    u.status === 0 && expMs > 0,
    u.sex,
    uid,
  );
  return {
    name: u.chineseName,
    pinyin: u.englishName.trim(),
    sex: u.sex,
    avatar,
    isDefault,
    title: t.name,
    /* 军衔制配色按 TITLE_COLORS（resolveTitleDisplay 军衔不带 color——样式类
       驱动；观看页两处（标题行/引导页）都需要直接色值） */
    titleColor: t.color ?? TITLE_COLORS[t.name] ?? "#939387",
  };
}

/** 页面标题「旁观XXX的练习」（2026-11-27 20:30 张老师定：比赛模式换「的比赛」） */
async function liveTitle(uid: number): Promise<string> {
  const u = await prisma.user.findUnique({
    where: { id: uid },
    select: { chineseName: true },
  });
  if (!u) return "旁观练习";
  const comp = getState(uid)?.compId;
  return comp ? `旁观${u.chineseName}的比赛` : `旁观${u.chineseName}的练习`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ uid: string }>;
}): Promise<Metadata> {
  const { uid: raw } = await params;
  const uid = Number(raw);
  if (!liveEnabled() || !Number.isInteger(uid) || uid <= 0) return { title: "旁观练习" };
  return { title: await liveTitle(uid) };
}

export default async function LivePage({
  params,
}: {
  params: Promise<{ uid: string }>;
}) {
  if (!liveEnabled()) notFound();
  const { uid: raw } = await params;
  const uid = Number(raw);
  if (!Number.isInteger(uid) || uid <= 0) notFound();
  const session = await getSession();
  if (!session) {
    /* 未登录直接跳登录页（2026-11-27 张老师定），登录后回跳本页 */
    redirect(`/account/login?next=${encodeURIComponent(`/watch/${uid}`)}`);
  }

  /* 拉黑＝硬拒（黑名单用户无法进任何态） */
  const blocked = uid !== session.uid && await isBlocked(uid, session.uid);
  if (blocked) {
    return (
      <main id="page">
        <div className="box" style={{ padding: 40, textAlign: "center" }}>
                  <h2>无法旁观</h2>
          <p>由于该玩家的隐私设置，你无法旁观。</p>
        </div>
      </main>
    );
  }

  const host = await liveHost(uid);
  const [following, metricDists] = await Promise.all([
    uid === session.uid ? Promise.resolve(true) : isFollowing(session.uid, uid),
    getOnlineMetricDists(), // 评级基准分布池（练习页同源）
  ]);

  /* 未关注（且非本人）→ 引导态（2026-11-27 张老师定）：「旁观」黄 h1（左上角）
     +「XXX没有在练习」（头像/姓名可点进主页/性别/军衔徽章+称号同姓名大字号
     正确配色）+ 关注按钮（真实状态）+ 关注引导文案（关注后随按钮即时切换）。
     上下留足空（张老师 12:54：「界面太扁了，上下多留一些空」） */
  if (!following) {
    return (
      <main id="page" className="main">
        <div className="box live_gate">
          <div className="live_gate_title">
            {host.isDefault
              ? <DefaultAvatar sex={host.sex} size="small" className="live_avatar" alt={host.name} />
              : <img className="live_avatar" src={host.avatar} alt={host.name} />}
            <Link href={`/user/${uid}`} className="live_gate_name" prefetch={false}>{host.name}</Link>
            <span className={`gender ${host.sex ? "male" : "female"}`} aria-label={host.sex ? "男" : "女"} />
            <span className="live_gate_rank">
              <RankBadge title={host.title} />
              <span className="live_gate_rank_name" style={{ color: host.titleColor }}>{host.title}</span>
            </span>
            <span className="live_gate_rest">没有在练习</span>
          </div>
          <LiveGateAction uid={uid} sex={host.sex} loggedIn={!!session} />
        </div>
      </main>
    );
  }

  const live = isLiveNow(uid);
  /* 比赛模式（2026-11-27 20:30 张老师定）：state 心跳落盘的当前比赛——
     传给 LiveWatch 做 SSR 初始显示（标题行「正在参加xxx」），轮询随 feed 刷新 */
  const st = getState(uid);
  const comp = live && st?.compId ? { id: st.compId, name: st.compName ?? "", end: st.compEnd } : null;
  return (
    /* 练习页同款容器：#page.main > .box 深底圆角卡片（.op_root 结构由
       LiveWatch 根节点承担） */
    <main id="page" className="main">
      <div className="box" id="online_play">
        <LiveWatch uid={uid} host={host} initiallyLive={live} metricDists={metricDists} initialComp={comp} />
      </div>
    </main>
  );
}
