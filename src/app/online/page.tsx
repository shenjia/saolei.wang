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

export const dynamic = "force-dynamic";

const getSignupPlayers = unstable_cache(
  () => prisma.user.count({ where: { status: 0 } }),
  ["signup-players", "v1"],
  { revalidate: 3600 }
);

export interface OnlineCompParam {
  /** 进行中比赛（?c= 合法时）；code=比赛标识，2026-11-18 起可空（未设置=不附加标识）；
   *  race=窗口赛个人标识（2026-11-19，?race= 传入，优先注入结算 EVF） */
  comp: { id: number; shortName: string; code: string | null; race?: string | null } | null;
  /** ?c= 指向的比赛无效（不存在/未开始/已结束）时的人话提示 */
  compError: string | null;
}

/** 解析 ?c= 比赛参数（2026-11-13 二期）：无参数=普通练习；非法=红色气泡文案 */
async function resolveCompParam(raw: string | undefined): Promise<OnlineCompParam> {
  const cid = parseInt(raw ?? "", 10);
  if (!raw || !Number.isInteger(cid) || cid <= 0) {
    // 带了 c 但不是合法数字 → 按不存在处理；不带 c → 普通练习
    return raw ? { comp: null, compError: "比赛不存在" } : { comp: null, compError: null };
  }
  const c = await prisma.tournament.findUnique({
    where: { id: BigInt(cid) },
    select: { id: true, shortName: true, code: true, startTime: true, endTime: true },
  });
  if (!c) return { comp: null, compError: "比赛不存在" };
  const now = Math.floor(Date.now() / 1000);
  if (now < Number(c.startTime)) return { comp: null, compError: `「${c.shortName}」尚未开始` };
  if (now >= Number(c.endTime)) return { comp: null, compError: `「${c.shortName}」已结束` };
  return { comp: { id: Number(c.id), shortName: c.shortName, code: c.code }, compError: null };
}

/** 解析 ?race= 窗口赛个人标识（2026-11-19 张老师定）：标识须命中当前登录玩家
 *  一个未过期的窗口会话 → 返回该比赛与标识；未登录/无会话/过期 → null（普通比赛模式降级） */
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
    select: { id: true, shortName: true, code: true, endTime: true },
  });
  if (!c || now >= Number(c.endTime)) return null;
  return { comp: { id: Number(c.id), shortName: c.shortName, code: c.code, race: sess.race } };
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<Metadata> {
  const sp = await searchParams;
  const { comp } = await resolveCompParam(sp.c);
  // 比赛模式标签页标题＝比赛简称（张老师 15:14 定「Title 由练习变成比赛简称」）
  return { title: comp ? comp.shortName : "练习" };
}

export default async function OnlinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const session = await getSession();
  const [base, raceHit] = await Promise.all([
    resolveCompParam(sp.c),
    resolveRaceParam(sp.race, session?.uid),
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
