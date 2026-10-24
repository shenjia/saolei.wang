// 每日一星（2026-10-25 恢复，新版评选口径见 lib/star.ts）：首页右栏展示
// 七轮定稿（张老师 03:37）：左右布局——头像局左（50% 宽）；
//   右侧姓名+性别 / 军衔 / 地区排行 / 全国排行（与用户主页 .ranks 同构）。
// 八轮（03:54）：性别标记后加「发消息」对话按钮（与用户卡片同逻辑，登录且非本人）。
// 九轮（04:12）：感言区移到 star_body 下方通栏（头像下面，充分利用板块宽度）；
//   本人登录态板块底部「发表感言」按钮（论坛「写文章」同款 button active small + 笔形 ICON）；
//   管理员登录态感言旁「删除」入口（删两次本人永久不能再发，delStarSpeech 计数）。

import Link from "next/link";
import { getTodayStar, recordClick } from "@/lib/star";
import { headers } from "next/headers";
import { getUserCard } from "@/lib/usercard";
import { AvatarCell, TitleBadge } from "@/components/Cells";
import { areaDisplay, AREA_OVERSEAS, isManager } from "@/lib/config";
import { getSession } from "@/lib/auth";
import { SendMessageButton } from "@/components/SendMessageButton";
import { StarSpeechBar } from "@/components/StarSpeechBar";
import { StarSpeechDeleteButton } from "@/components/StarSpeechDeleteButton";

export async function DailyStar() {
  const star = await getTodayStar();
  if (!star?.user) return null;
  // 卡片展示计人气（十五轮）：同 IP 同日跨来源去重，失败不阻断渲染
  try {
    const h = await headers();
    const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "";
    await recordClick(star.user.id, ip, "star");
  } catch {}
  const [card, session] = await Promise.all([getUserCard(star.user.id), getSession()]);
  if (!card) return null;
  const own = !!session && session.uid === card.id;
  const manager = !!session && isManager(session.role);
  return (
    <div id="daily_star" className="box">
      <h2>
        每日一星
        {/* 问号圆圈图标（十轮 04:17）：hover 显示评选规则气泡（data-tip 复用全站模式） */}
        <span className="star_help" data-tip="每日凌晨，在30天内有打破过记录且排名处上升状态者，以及少将以上军衔玩家中随机选择。30日内当选过的不参选，上传本人真实照片可增加选中概率。">
          <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <circle cx="10" cy="10" r="8.4" />
            <path d="M7.6 8a2.5 2.5 0 1 1 3.4 2.33c-.7.28-1 .77-1 1.47v.3" strokeLinecap="round" />
            <circle cx="10" cy="14.6" r="0.9" fill="currentColor" stroke="none" />
          </svg>
        </span>
      </h2>
      <div className="star_body">
        <Link
          className="avatar_link star_left"
          href={`/user/${card.id}`}
          target="_blank"
          title={`进入 ${card.chineseName} 的地盘`}
        >
          <img className="star_avatar" src={card.avatarUrl} alt={card.chineseName} />
        </Link>
        <div className="star_right">
          <p className="star_name">
            <AvatarCell id={card.id} name={card.chineseName} sex={card.sex} gender="small" link />
            {/* 发消息气泡按钮（八轮）：与用户卡片同逻辑——登录且非本人 */}
            <SendMessageButton to={card.id} name={card.chineseName} authorId={session?.uid ?? 0} />
          </p>
          <p className="star_title">
            <TitleBadge title={card.militaryTitle} classic={card.classicTitle} link />
          </p>
          {/* 排名行：与用户主页 .ranks 同构（海外玩家同口径组内名次，2026-10-15） */}
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
                  <span className="rank_line star_null">未加入地区排行</span>
                )}
                {card.rank !== null ? (
                  <span className="rank_line">
                    全国第 <em>{card.rank}</em> 名
                  </span>
                ) : (
                  <span className="rank_line star_null">未加入排行</span>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {/* 感言（九轮）：已发表时显示在 star_body 下方通栏（头像下面）——
          全角引号 + 亮灰，充分利用板块宽度；管理员旁附「删除」小按钮 */}
      {star.speech && (
        <p className="star_speech">
          “{star.speech}”
          {manager && <StarSpeechDeleteButton />}
        </p>
      )}
      {/* 本人「发表感言」按钮（九轮）：论坛「写文章」同款样式 + 笔形 ICON；
          未发表且未被删两次时显示，板块底部 */}
      {own && !star.speech && star.speechDel < 2 && <StarSpeechBar />}
    </div>
  );
}
