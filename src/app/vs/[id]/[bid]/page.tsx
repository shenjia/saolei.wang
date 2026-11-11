// 旁观对决页（2026-11-11 张老师）：/vs/[id]/[bid] = 左方 id 对 右方 id 的完整对局。
// 入口 = 后台对决统计（/admin/vs）最近对决记录「观看」按钮；登录后可旁观任意双方，
// 旁观不落 vs_duel（KPI 口径＝双方本人访问，见 VsDuelView record=false）。
// 版面与 /vs/[id] 完全同源（VsDuelView 共享渲染）。

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { VsDuelView, getVsDuelTitle } from "@/components/VsDuel";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string; bid: string }>;
}): Promise<Metadata> {
  const { id, bid } = await params;
  const uid1 = parseInt(id, 10);
  const uid2 = parseInt(bid, 10);
  if (!uid1 || !uid2 || uid1 === uid2) return { title: "玩家对战" };
  return { title: await getVsDuelTitle(uid1, uid2) };
}

export default async function VsSpectatePage({
  params,
}: {
  params: Promise<{ id: string; bid: string }>;
}) {
  const { id, bid } = await params;
  const uid1 = parseInt(id, 10);
  const uid2 = parseInt(bid, 10);
  if (!uid1 || !uid2) notFound();

  const session = await getSession();
  if (!session) redirect("/account/login");

  return <VsDuelView uid1={uid1} uid2={uid2} record={false} />;
}
