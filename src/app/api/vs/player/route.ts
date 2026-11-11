// /vs 对决选择页配套接口（2026-11-11 张老师需求）：
// GET /api/vs/player?id=123 → { player: { 卡片 + 实力雷达字段 } } / 404
// 仅登录可用（页面本身有登录门槛，接口兜底）。数据口径与 /vs/[id] 的
// VsPanel 完全同源（getUserCard + getRadarData），只保留卡片渲染所需字段。

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getUserCard } from "@/lib/usercard";
import { getRadarData } from "@/lib/radar";

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const id = parseInt(new URL(req.url).searchParams.get("id") ?? "", 10);
  if (!id) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  const card = await getUserCard(id);
  if (!card) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // 没上传过录像的玩家无雷达（与主页「实力」板块同门槛），给空数组
  const radar = card.hasVideos ? await getRadarData(card.scores) : [];
  return NextResponse.json({
    player: {
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
    },
  });
}
