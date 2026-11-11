// 玩家对战 PK 页（2026-11-09 张老师需求）：
// 入口 = 用户主页性别图标+对话气泡右侧、侧栏玩家卡片对话气泡正下方的对战按钮。
// 2026-11-11 张老师：版面渲染整体抽到 /src/components/VsDuel.tsx（VsDuelView），
// 与新增的旁观路由 /vs/[id]/[bid]（后台对决统计「观看」入口）共用；
// 本页＝登录的「我」uid1 对 uid2，访问落 vs_duel（record=true）。
// 版面/口径历史注释全部随实现移至 VsDuel.tsx，此处只留路由壳。

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { VsDuelView, getVsDuelTitle } from "@/components/VsDuel";

export const dynamic = "force-dynamic";

/** 浏览器标签页标题（2026-11-10 张老师定）：「我方名 vs 对方名」。
 *  未登录会跳登录页；自己和自己比拼走兜底提示，两种都不暴露对手姓名 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const targetId = parseInt(id, 10);
  if (!targetId) return { title: "玩家对战" };
  const session = await getSession();
  if (!session || session.uid === targetId) return { title: "玩家对战" };
  return { title: await getVsDuelTitle(session.uid, targetId) };
}

export default async function VsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ run?: string }>;
}) {
  const { id } = await params;
  const targetId = parseInt(id, 10);
  if (!targetId) notFound();

  const session = await getSession();
  if (!session) redirect("/account/login");

  // ?run=1：对决选择页「一决胜负」直达（2026-11-11 张老师：选定双方后落地即开跑，
  // 免二次点击）；主页入口等其它途径不带此参，保持「战前→点击开跑」两段式
  const { run } = await searchParams;

  return <VsDuelView uid1={session.uid} uid2={targetId} record autoRun={run === "1"} />;
}
