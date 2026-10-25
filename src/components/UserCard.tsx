// 侧栏个人面板（2026-10-13 六轮定稿，设计稿 design/sidebar-panel.html）
// 布局：左列正方形照片（点击进主页）｜ 右列姓名 + 性别图标（首页同款 AvatarCell）
//   + 军衔（TitleBadge，条件文案走 hover 气泡），其下地区/全国排行
//   （与用户主页 #user_view .ranks 同构：两行 rank_line、13px / #888 /
//   名次数字 #e6db74 加粗正体；整块与左侧头像上下等高齐平）；
//   分隔线以下为四级纪录（直接复用用户主页的 ScoreTime / Score3bvs 渲染，
//   级别灰阶与 hover 变色同源，数字可点进对应录像）。
//   2026-10-14 张老师要求：卡片不再显示最近登录时间。
//   2026-10-21 张老师要求：恢复——底部「最近登录」行重新上线（绝对日期 Y年n月j日），
//   四级纪录表头级别名后加「纪录」二字（初级纪录 / 中级纪录 / 高级纪录 / 总计纪录）。
//   2026-10-25 张老师要求：「发消息」气泡小按钮（用户主页同款 SendMessageButton）；
//   二轮定稿：钉在排行块（两行排名）右缘、与其垂直中线对齐，登录且非本人时渲染。
//   同日晚些去重：十二轮曾把按钮复制到「最近登录」行右端一份，导致双气泡——
//   已删，只保留排行块右缘这一个。
// 卡片下方可跟一个「实力」雷达图板块（UserPanel 统一组装，与用户主页同款）。
// 旧版「进入TA的地盘」按钮、人气 / 今日人气、旧版称号、(id) 均已下线。
// 用于 /bbs/[id] 右栏与 /video/[id] 右栏。

import Link from "next/link";
import type { UserCardData } from "@/lib/usercard";
import { getUserCard } from "@/lib/usercard";
import { getRadarData } from "@/lib/radar";
import { getSession } from "@/lib/auth";
import { AvatarCell, Score3bvs, ScoreTime, TitleBadge } from "./Cells";
import { RadarChart } from "./RadarChart";
import { SendMessageButton } from "./SendMessageButton";
import { areaDisplay, AREA_OVERSEAS, LEVELS, LEVEL_NAMES } from "@/lib/config";
import { formatDate } from "@/lib/format";

export function UserCard({
  card,
  viewerId = 0,
}: {
  card: UserCardData;
  /** 当前登录用户 id（0=未登录）：登录且非本人时，「最近登录」行右端渲染发消息按钮 */
  viewerId?: number;
}) {
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
            <TitleBadge title={card.militaryTitle} classic={card.classicTitle} link />
          </p>
          {/* 地区 / 全国排名：与用户主页 #user_view .info .rank_label .ranks 完全同构
              （两行 rank_line、13px、文字 #888、名次数字 Monokai 黄加粗正体；
              省份行在前、全国行在后），紧随名字下方，整体与左侧头像上下齐平。
              海外玩家（外国人）：显示「海外第 X 名」（组内名次，2026-10-15 张老师要求，
              口径与地区榜海外条目同构），不显示全国名次；无成绩保留灰「海外玩家」 */}
          <div className="ranks">
            {card.area === AREA_OVERSEAS ? (
              card.areaPos !== null ? (
                <span className="rank_line">
                  海外第 <em>{card.areaPos}</em> 名
                </span>
              ) : (
                <span className="rank_line ranks_overseas">海外玩家</span>
              )
            ) : (
              <>
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
              </>
            )}
            {/* 发消息气泡按钮（2026-10-25 二轮定稿）：绝对定位钉在排行块右缘、
                与两行排名的中线垂直对齐（二轮调整：原「最近登录」行右端位置被否），
                登录且非本人时渲染——不参与文字流、不挤占排名文字 */}
            {/* 十二轮（2026-10-25）：按钮常驻——未登录/看自己灰置 + hover 提示 */}
            <span className="ucd_msg">
              <SendMessageButton to={card.id} name={card.chineseName} authorId={viewerId} />
            </span>
          </div>
        </div>
      </div>

      <hr className="ucd_hr" />

      {/* 四级纪录：照搬用户主页 .scores 的渲染（ScoreTime / Score3bvs）；
          2026-10-15 张老师要求：卡片不再传 date（不显示纪录达成日期），用户主页不受影响；
          2026-10-21 张老师要求：表头级别名后加「纪录」二字（初级纪录 / … / 总计纪录） */}
      <table className="scores" cellPadding={0} cellSpacing={0}>
        <tbody>
          {LEVELS.map((level) => {
            const timeRec = card.scores[`${level}_time`];
            const bvsRec = card.scores[`${level}_3bvs`];
            return (
              <tr key={level} className={level}>
                <th>{LEVEL_NAMES[level]}纪录</th>
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

      {/* 最近登录（2026-10-21 张老师要求恢复）：绝对日期显示，从未登录显示「?」。
          二轮调整：整行字体与表头「XX纪录」一致（12.5px / #75715e），
          日期用亮灰 #b1b1a4（em，与卡片中级数字/正文亮灰同源）；
          三轮：标签后不放冒号，空格分隔 */}
      <p className="ucd_login">
        最近登录{" "}
        {card.lastLoginTime > 0 ? <em>{formatDate(card.lastLoginTime, "Y年n月j日")}</em> : "?"}
      </p>
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
  // 卡片展示计人气（十五轮 2026-10-25 张老师定）：同 IP 同日跨来源去重，失败不阻断渲染
  try {
    const { headers } = await import("next/headers");
    const h = await headers();
    const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "";
    const { recordClick } = await import("@/lib/star");
    await recordClick(userId, ip, "card");
  } catch {}
  const radar = card.hasVideos && !hideRadar ? await getRadarData(card.scores) : [];
  // 发消息按钮（2026-10-25）：登录且非本人时渲染（本人卡片不渲染，与用户主页同口径）
  const session = await getSession();
  return (
    <>
      <div id={cardId} className="box">
        <UserCard card={card} viewerId={session?.uid ?? 0} />
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
