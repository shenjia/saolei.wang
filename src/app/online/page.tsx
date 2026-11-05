// 练习/排名页薄壳（2026-10-27 私有仓抽取）：实现在私有 submodule
// src/core/src/app/online/page.tsx。路由段配置必须是编译期字面量
// （Next 静态分析要求，re-export 无效），此处原样复制；页面本体走转发。
// 2026-11-05：薄壳升级为包装——核心页外挂游客注册邀请浮层（SignupInvite，
// 局末弹出一天一次）；玩家数用 ACTIVE_USER 口径（与首页「注册人数」同源），
// 挂 unstable_cache 1h（注册数变化极慢，铁律：热点统计必须挂缓存）。
import type { Metadata } from "next";
import { unstable_cache } from "next/cache";
import CoreOnlinePage from "@/core/src/app/online/page";
import SignupInvite from "@/components/SignupInvite";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const metadata: Metadata = { title: "练习" };
export const dynamic = "force-dynamic";

const getSignupPlayers = unstable_cache(
  () => prisma.user.count({ where: { status: 0 } }),
  ["signup-players", "v1"],
  { revalidate: 3600 }
);

export default async function OnlinePage() {
  const [session, players] = await Promise.all([getSession(), getSignupPlayers()]);
  return (
    <>
      <CoreOnlinePage />
      <SignupInvite logged={!!session} players={players} />
    </>
  );
}
