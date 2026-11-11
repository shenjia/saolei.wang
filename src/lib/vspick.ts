// /vs 竞技场玩家卡片装配（2026-11-11 张老师需求）：
// 服务端（/vs/[[...ids]] 页面按 URL 段预取）与客户端（/api/vs/player 选定对手）
// 共用同一装配口径：getUserCard + getRadarData，字段与 PK 页 VsPanel 同源。

import { getUserCard } from "./usercard";
import { getRadarData } from "./radar";
import type { VsPickPlayer } from "@/components/VsPick";

/** 装配单个玩家的竞技场卡片；查无此人返回 null（调用方按空位处理）。
 *  没上传过录像的玩家无雷达（与主页「实力」板块同门槛），给空数组。 */
export async function getVsPickPlayer(id: number): Promise<VsPickPlayer | null> {
  const card = await getUserCard(id);
  if (!card) return null;
  const radar = card.hasVideos ? await getRadarData(card.scores) : [];
  return {
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
}
