// 侧栏个人面板（2026-10-13 六轮定稿，设计稿 design/sidebar-panel.html）
// 布局：左列正方形照片（点击进主页）｜ 右列姓名 + 性别图标（首页同款 AvatarCell）
//   + 军衔（TitleBadge，条件文案走 hover 气泡），其下地区/全国排行
//   （与用户主页 #user_view .ranks 同构：两行 rank_line、13px / #888 /
//   名次数字 #e6db74 加粗正体；整块与左侧头像上下等高齐平）；
//   分隔线以下为四级纪录（直接复用用户主页的 ScoreTime / Score3bvs 渲染，
//   级别灰阶与 hover 变色同源，数字可点进对应录像）。
//   2026-10-14 张老师要求：卡片不再显示最近登录时间。
// 卡片下方可跟一个「实力」雷达图板块（UserPanel 统一组装，与用户主页同款）。
// 旧版「进入TA的地盘」按钮、人气 / 今日人气、旧版称号、(id) 均已下线。
// 用于 /bbs/[id] 右栏与 /video/[id] 右栏。

import Link from "next/link";
import type { UserCardData } from "@/lib/usercard";
import { getUserCard } from "@/lib/usercard";
import { getRadarData } from "@/lib/radar";
import { AvatarCell, Score3bvs, ScoreTime, TitleBadge } from "./Cells";
import { RadarChart } from "./RadarChart";
import { areaDisplay, LEVELS, LEVEL_NAMES } from "@/lib/config";

export function UserCard({ card }: { card: UserCardData }) {
  return (
    <div className="user_card">
      <div className="ucd_top">
        <div className="ucd_left">
          <Link
            className="avatar_link"
            href={`/user/${card.id}`}
            target="_blank"
            title={`进入 ${card.chineseName} 的地盘`}
          >
            <img className="ucd_avatar" src={card.avatarUrl} alt={card.chineseName} />
          </Link>
        </div>
        <div className="ucd_right">
          {/* 姓名 + 性别 + 军衔：与首页「入伍新兵 / 国内TOP10」同一套组件，显示方式天然一致
              （军衔条件文案由 TitleBadge 的 data-tip 在 hover 时显示） */}
          <p className="ucd_name">
            <AvatarCell id={card.id} name={card.chineseName} sex={card.sex} gender="small" link />
            <TitleBadge title={card.militaryTitle} link />
          </p>
          {/* 地区 / 全国排名：与用户主页 #user_view .info .rank_label .ranks 完全同构
              （两行 rank_line、13px、文字 #888、名次数字 Monokai 黄加粗正体；
              省份行在前、全国行在后），紧随名字下方，整体与左侧头像上下齐平 */}
          <div className="ranks">
            {card.areaPos !== null ? (
              <span className="rank_line">
                {areaDisplay(card.area)}第 <em>{card.areaPos}</em> 名
              </span>
            ) : (
              <span className="rank_line ucd_null">未加入地区排行</span>
            )}
            {card.rank !== null ? (
              <span className="rank_line">
                全国第 <em>{card.rank}</em> 名
              </span>
            ) : (
              <span className="rank_line ucd_null">未加入排行</span>
            )}
          </div>
        </div>
      </div>

      <hr className="ucd_hr" />

      {/* 四级纪录：照搬用户主页 .scores 的渲染（ScoreTime / Score3bvs）；
          2026-10-15 张老师要求：卡片不再传 date（不显示纪录达成日期），用户主页不受影响 */}
      <table className="scores" cellPadding={0} cellSpacing={0}>
        <tbody>
          {LEVELS.map((level) => {
            const timeRec = card.scores[`${level}_time`];
            const bvsRec = card.scores[`${level}_3bvs`];
            return (
              <tr key={level} className={level}>
                <th>{LEVEL_NAMES[level]}</th>
                <td>
                  <ScoreTime
                    score={timeRec?.score ?? null}
                    videoId={timeRec?.videoId ?? null}
                    className={level}
                  />
                </td>
                <td>
                  <Score3bvs
                    score={bvsRec?.score ?? null}
                    videoId={bvsRec?.videoId ?? null}
                    className={level}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 侧栏个人面板（服务端取数 + 组装）：个人卡片盒 + 「实力」雷达图盒。
 * 论坛主题详情页（cardId="bbs_op_card"）与录像详情页共用。
 * 没上传过录像的玩家不渲染雷达板块（与用户主页同门槛）。
 * 录像详情页传 hideRadar：右栏只留个人卡片，雷达位置让给「录像分析」（本局六维，
 * 2026-10-14 张老师定）。
 */
export async function UserPanel({
  userId,
  cardId,
  hideRadar,
}: {
  userId: number;
  cardId?: string;
  hideRadar?: boolean;
}) {
  const card = await getUserCard(userId);
  if (!card) return null;
  const radar = card.hasVideos && !hideRadar ? await getRadarData(card.scores) : [];
  return (
    <>
      <div id={cardId} className="box">
        <UserCard card={card} />
      </div>
      {card.hasVideos && !hideRadar && (
        <div className="radar box">
          <h2>实力</h2>
          <RadarChart data={radar} />
        </div>
      )}
    </>
  );
}
