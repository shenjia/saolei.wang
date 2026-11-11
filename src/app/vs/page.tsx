// /vs 对决选择页（2026-11-11 张老师需求）：登录态下选对手的准备页。
// 左侧放自己（服务端预取卡片+雷达数据直出），右侧空位 = 问号头像 + 搜索框；
// 选定对手后客户端拉 /api/vs/player 渲染其卡片与实力雷达（交互见 components/VsPick.tsx）。
// 卡片/雷达口径与 /vs/[id] 的 VsPanel 完全同源（getUserCard + getRadarData）。
// ⚠️ #page 不挂 .vs_page 类——那会命中 PK 页移动端隐藏 header/footer 的规则；
// 本页用独立类 vs_pick_page。/vs 路由与 /vs/[id] 静态段优先，互不影响。

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getUserCard } from "@/lib/usercard";
import { getRadarData } from "@/lib/radar";
import { VsPickArena, type VsPickPlayer } from "@/components/VsPick";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "对决" };

export default async function VsIndexPage() {
  const session = await getSession();
  if (!session) redirect("/account/login");

  const card = await getUserCard(session.uid);
  if (!card) notFound();
  // 没上传过录像的玩家无雷达（与主页「实力」板块同门槛），给空数组
  const radar = card.hasVideos ? await getRadarData(card.scores) : [];

  const me: VsPickPlayer = {
    id: card.id,
    name: card.chineseName,
    en: card.englishName,
    sex: card.sex,
    avatarUrl: card.avatarUrl,
    avatarIsDefault: card.avatarIsDefault,
    militaryTitle: card.militaryTitle,
    classicTitle: card.classicTitle,
    area: card.area,
    areaRank: card.areaPos,
    natRank: card.rank,
    radar,
  };

  return (
    <div id="page" className="main vs_pick_page">
      <VsPickArena me={me} />
    </div>
  );
}
