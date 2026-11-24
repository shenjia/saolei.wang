// 练习/排名页薄壳（2026-10-27 私有仓抽取）：实现在私有 submodule
// src/core/src/app/online/page.tsx。路由段配置必须是编译期字面量
// （Next 静态分析要求，re-export 无效），此处原样复制；页面本体走转发。
// 2026-11-05：薄壳升级为包装——核心页外挂游客注册邀请浮层（SignupInvite，
// 局末弹出一天一次）；玩家数用 ACTIVE_USER 口径（与首页「注册人数」同源），
// 挂 unstable_cache 1h（注册数变化极慢，铁律：热点统计必须挂缓存）。
// 2026-11-13 二期（张老师需求）：比赛模式——/online?c=比赛ID 进入；
// · c 合法且比赛进行中 → 比赛模式（标题=比赛简称、隐藏自定义级别与
//   速旗/连击/无猜快捷钮、保存录像标识自动附加比赛标识）；
// · c 指向不存在/未开始/已结束的比赛 → 下发 compError，客户端弹红色气泡；
// · 标签页标题同样随比赛简称走（generateMetadata）。
import type { Metadata } from "next";
import { unstable_cache } from "next/cache";
import CoreOnlinePage from "@/core/src/app/online/page";
import SignupInvite from "@/components/SignupInvite";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getMyScoreSnapshot } from "@/lib/tournament";
import { parseTourMetric, type TourMetricKey } from "@/lib/tour-metric";

export const dynamic = "force-dynamic";

const getSignupPlayers = unstable_cache(
  () => prisma.user.count({ where: { status: 0 } }),
  ["signup-players", "v1"],
  { revalidate: 3600 }
);

/** 比赛模式下发给客户端的比赛上下文（2026-11-22 扩展张老师需求）：
 *  end=比赛结束时刻（秒；标题行倒计时用）；scoreSnapshot=本人总分快照（标题行
 *  「成绩」行用，null=暂无成绩）；metric=计分项（成绩数值格式化）；
 *  topn=各级别取盘数（底部级别统计区格子数，sum_topn 配置；0/缺失=该级别不收）；
 *  includeLevels=比赛收录级别（底部统计区只渲染这些级别，与算分口径同源） */
export interface OnlineCompParam {
  /** 进行中比赛（?c= 合法时）；code=比赛标识，2026-11-18 起可空（未设置=不附加标识）；
   *  race=窗口赛个人标识（2026-11-19，?race= 传入，优先注入结算 EVF） */
  comp: {
    id: number;
    shortName: string;
    code: string | null;
    race?: string | null;
    end: number;
    metric: TourMetricKey;
    topn: Record<string, number>;
    includeLevels: string[];
    scoreSnapshot: { score: number; rank: number; calc: { lv: string; n: number; real: number; fill: number; floorScore: number }[]; detail: { lv: string; videos: { vid: number; value: number }[] }[] } | null;
  } | null;
  /** ?c= 指向的比赛无效（不存在/未开始/已结束）时的人话提示 */
  compError: string | null;
}

/** 从 score_config 抽下发字段（topn/includeLevels——底部级别统计区渲染参数）；
 *  scoreConfig 解析失败回退空（客户端不渲染统计区，不炸） */
function compExtraOf(scoreConfig: string): { topn: Record<string, number>; includeLevels: string[] } {
  try {
    const o = JSON.parse(scoreConfig || "{}") as Record<string, unknown>;
    const topn: Record<string, number> = {};
    for (const lv of ["beg", "int", "exp"]) {
      const n = Number(o[lv]);
      if (Number.isFinite(n) && n > 0) topn[lv] = Math.floor(n);
    }
    return { topn, includeLevels: [] };
  } catch {
    return { topn: {}, includeLevels: [] };
  }
}

/** 解析 ?c= 比赛参数（2026-11-13 二期）：无参数=普通练习；非法=红色气泡文案。
 *  2026-11-22 扩展：下发 end（倒计时）+ 本人成绩快照（标题行成绩行，张老师需求） */
async function resolveCompParam(
  raw: string | undefined,
  uid: number | undefined
): Promise<OnlineCompParam> {
  const cid = parseInt(raw ?? "", 10);
  if (!raw || !Number.isInteger(cid) || cid <= 0) {
    // 带了 c 但不是合法数字 → 按不存在处理；不带 c → 普通练习
    return raw ? { comp: null, compError: "比赛不存在" } : { comp: null, compError: null };
  }
  const c = await prisma.tournament.findUnique({
    where: { id: BigInt(cid) },
    select: { id: true, shortName: true, code: true, startTime: true, endTime: true, scoreMode: true, scoreConfig: true, includeLevels: true },
  });
  if (!c) return { comp: null, compError: "比赛不存在" };
  const now = Math.floor(Date.now() / 1000);
  if (now < Number(c.startTime)) return { comp: null, compError: `「${c.shortName}」尚未开始` };
  if (now >= Number(c.endTime)) return { comp: null, compError: `「${c.shortName}」已结束` };
  const snapshot = uid ? await getMyScoreSnapshot(cid, uid) : null;
  const extra = compExtraOf(c.scoreConfig);
  return {
    comp: {
      id: Number(c.id),
      shortName: c.shortName,
      code: c.code,
      end: Number(c.endTime),
      // metric=计分数据项 key（score_config.metric；scoreMode 是计算方式 sum_topn
      // 不是数据项——首次实现误发 scoreMode 致 fmtTourScore 崩，2026-11-22 修）
      metric: parseTourMetric(JSON.parse(c.scoreConfig || "{}").metric),
      topn: extra.topn,
      includeLevels: (c.includeLevels ?? "beg,int,exp").split(",").map((s) => s.trim()).filter(Boolean),
      scoreSnapshot: snapshot,
    },
    compError: null,
  };
}

/** 解析 ?race= 窗口赛个人标识（2026-11-19 张老师定）：标识须命中当前登录玩家
 *  一个未过期的窗口会话 → 返回该比赛与标识；未登录/无会话/过期 → null（普通比赛模式降级）。
 *  2026-11-22 张老师定：race 命中即**完整比赛模式**（同 ?c= 口径——标题简称/
 *  隐藏不可用钮/自定义 tab）+ 下发个人窗口 end 与本人成绩快照 */
async function resolveRaceParam(
  raw: string | undefined,
  uid: number | undefined
): Promise<{ comp: OnlineCompParam["comp"] } | null> {
  if (!raw || !uid) return null;
  const sess = await prisma.tournamentWindowSession.findUnique({
    where: { race: raw.toUpperCase() },
  });
  if (!sess || Number(sess.userId) !== uid) return null;
  const now = Math.floor(Date.now() / 1000);
  if (now > Number(sess.endTime)) return null; // 会话过期，标识失效
  const c = await prisma.tournament.findUnique({
    where: { id: sess.tournamentId },
    select: { id: true, shortName: true, code: true, endTime: true, scoreConfig: true, includeLevels: true },
  });
  if (!c || now >= Number(c.endTime)) return null;
  const snapshot = await getMyScoreSnapshot(Number(c.id), uid, {
    start: Number(sess.startTime),
    end: Number(sess.endTime),
  });
  const extra = compExtraOf(c.scoreConfig);
  return {
    comp: {
      id: Number(c.id),
      shortName: c.shortName,
      code: c.code,
      race: sess.race,
      end: Number(sess.endTime),
      // metric=计分数据项 key（同 resolveCompParam，scoreConfig.metric）
      metric: parseTourMetric(JSON.parse(c.scoreConfig || "{}").metric),
      topn: extra.topn,
      includeLevels: (c.includeLevels ?? "beg,int,exp").split(",").map((s) => s.trim()).filter(Boolean),
      scoreSnapshot: snapshot,
    },
  };
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<Metadata> {
  const sp = await searchParams;
  const session = await getSession();
  const uid = session?.uid;
  // 标签页标题同页面口径（张老师 15:14 定「Title 由练习变成比赛简称」）：
  // ?race= 命中本人未过期会话 → 同样换简称（2026-11-22 张老师要求）
  const [, raceHit] = await Promise.all([resolveCompParam(sp.c, uid), resolveRaceParam(sp.race, uid)]);
  if (raceHit?.comp) return { title: raceHit.comp.shortName };
  const base = await resolveCompParam(sp.c, uid);
  return { title: base.comp ? base.comp.shortName : "练习" };
}

export default async function OnlinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const session = await getSession();
  const uid = session?.uid;
  const [base, raceHit] = await Promise.all([
    resolveCompParam(sp.c, uid),
    resolveRaceParam(sp.race, uid),
  ]);
  // 窗口赛个人标识优先（?race= 命中本人未过期会话）
  const comp = raceHit?.comp ?? base.comp;
  const compError = raceHit?.comp ? null : base.compError;
  const players = await getSignupPlayers();
  return (
    <>
      <CoreOnlinePage comp={comp} compError={compError} />
      <SignupInvite logged={!!session} players={players} />
    </>
  );
}
