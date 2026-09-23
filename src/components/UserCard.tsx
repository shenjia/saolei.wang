// 个人信息卡片（2026-09-23 张老师要求，参照旧版「查看信息」卡片 + 新版个人首页编排重设计）
// 布局（横排，默认）：左列头像 + 「进入TA的地盘」按钮叠放；右列姓名(Id)称号GG、
//   全国名次(日升降)、四级纪录表（时间黄 | 3BVS 灰，列对齐）、最近登录
// 竖排（vertical，窄容器如首页右栏「我的地盘」）：头像+按钮在上居中，信息块通栏在下

import Link from "next/link";
import type { UserCardData, UserCardScore } from "@/lib/usercard";
import { formatDate } from "@/lib/format";

function ScoreRow({ label, s }: { label: string; s: UserCardScore }) {
  return (
    <tr>
      <th>{label}</th>
      <td className="t">{s.time > 0 ? (s.time / 1000).toFixed(2) : "?"}</td>
      <td className="sep">|</td>
      <td className="b">{s.bvs > 0 ? (s.bvs / 1000).toFixed(2) : "?"}</td>
    </tr>
  );
}

export function UserCard({
  card,
  own = false,
  vertical = false,
}: {
  card: UserCardData;
  own?: boolean;
  vertical?: boolean;
}) {
  return (
    <div className={vertical ? "user_card v" : "user_card"}>
      <div className="uc_body">
        <div className="uc_left">
          <img className="uc_avatar" src={card.avatarUrl} alt={card.chineseName} />
          {/* data-uc-nav：全站人名弹层（UserCardPopover）放行此链接，仅它可跳转玩家详情页 */}
          <Link className="uc_home" href={`/user/${card.id}`} target="_blank" data-uc-nav>
            {own ? "进入我的地盘" : "进入TA的地盘"}
          </Link>
        </div>
        <div className="uc_right">
          <p className="uc_name">
            {card.chineseName}
            <span className="uc_id"> (id: {card.id})</span>
            <span className="uc_title" style={{ color: card.title.color }}>
              {card.title.name}
            </span>
            <span className="uc_sex">{card.sex ? "GG" : "mm"}</span>
          </p>
          <p className="uc_rank">
            {card.rank ? (
              <>
                全国第 <em>{card.rank}</em> 位{" "}
                {card.delta === null ? (
                  <span className="uc_delta new">新上榜</span>
                ) : card.delta > 0 ? (
                  <span className="uc_delta up">↑{card.delta}</span>
                ) : card.delta < 0 ? (
                  <span className="uc_delta down">↓{-card.delta}</span>
                ) : (
                  <span className="uc_delta">-</span>
                )}
              </>
            ) : (
              "未加入排行"
            )}
          </p>
          <table className="uc_scores" cellPadding={0} cellSpacing={0}>
            <tbody>
              <ScoreRow label="初级" s={card.beg} />
              <ScoreRow label="中级" s={card.int} />
              <ScoreRow label="高级" s={card.exp} />
              <ScoreRow label="总计" s={card.sum} />
            </tbody>
          </table>
          <p className="uc_login">
            最近登录：{card.lastLoginTime > 0 ? formatDate(card.lastLoginTime, "Y年n月j日") : "?"}
          </p>
        </div>
      </div>
    </div>
  );
}
