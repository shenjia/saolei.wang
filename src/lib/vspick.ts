// /vs 竞技场玩家卡片装配（2026-11-11 张老师需求）：
// 服务端（/vs/[[...ids]] 页面按 URL 段预取）与客户端（/api/vs/player 选定对手）
// 共用同一装配口径：getUserCard + getRadarData，字段与 PK 页 VsPanel 同源。
// 2026-11-19 张老师：卡片头像处补关注按钮——viewerId 传入时附带查观看者关注态
// （viewerFollowing），与侧栏卡片/对决页同一口径。

import { getUserCard } from "./usercard";
import { getRadarData } from "./radar";
import { isFollowing } from "./follow";
import type { VsPickPlayer } from "@/components/VsPick";

/** 装配单个玩家的竞技场卡片；查无此人返回 null（调用方按空位处理）。
 *  没上传过录像的玩家无雷达（与主页「实力」板块同门槛），给空数组。
 *  viewerId（2026-11-19）：登录者 id——非本人时附带查「观看者是否已关注 TA」
 *  （关注按钮初始态）；缺省/本人不查。 */
export async function getVsPickPlayer(id: number, viewerId = 0): Promise<VsPickPlayer | null> {
  const card = await getUserCard(id);
  if (!card) return null;
  const radar = card.hasVideos ? await getRadarData(card.scores) : [];
  const viewerFollowing =
    viewerId && viewerId !== card.id ? await isFollowing(viewerId, card.id) : false;
  return {
    id: card.id,
    name: card.chineseName,
    en: card.englishName,
    sex: card.sex,
    avatarUrl: card.avatarUrl,
    avatarOrigUrl: card.avatarOrigUrl,
    avatarIsDefault: card.avatarIsDefault,
    militaryTitle: card.militaryTitle,
    classicTitle: card.classicTitle,
    area: card.area,
    areaRank: card.areaPos,
    natRank: card.rank,
    radar,
    viewerFollowing,
  };
}
