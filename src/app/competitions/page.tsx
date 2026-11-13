// 前台「比赛」页（2026-11-13 张老师需求）
//
// 版式：复用首页 #page.two_columns 双栏壳——左=比赛列表板块（一比赛一 .box，一页 ≤5 个，
// 底部 Pager 翻页），右=玩家卡片 +「我的统计」+「全网统计」（登录态才有前两者）。
// · 板块标题：进行中金色 #fdc61a，未开始/已结束亮灰（张老师 13:12 定「只有进行中是金色」）；
//   标题后括号亮灰小字起止日期；
// · 右上角：总奖金（比标题小两号，hover 出分配方案气泡）+ 状态按钮三态——
//   未开始=绿「报名参加」（已报名暗绿）/ 进行中=黄「开始比赛」（vs_fight 同款，跳练习页）/
//   已结束=灰禁用「已结束」；气泡一律朝上方弹出（2026-11-11 张老师定）；
// · 纪录图表：x 轴排名（最右为 1）y 轴成绩；未开始「尚未开始」，本期成绩采集未接入先占位；
// · 信息行：发起人 | 比赛标识（开始前「待定」，开始后 6 位随机码 + 简称）；
// · 底部：比赛规则。

import type { Metadata } from "next";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { getHeaderUser } from "@/lib/usercard";
import { DefaultAvatar } from "@/components/DefaultAvatar";
import { Pager } from "@/components/Pager";
import { SignupButton } from "@/components/competition/SignupButton";
import { CompChart } from "@/components/competition/CompChart";
import {
  COMP_PAGE_SIZE,
  getCompGlobalStats,
  getCompMyStats,
  getCompetitionPage,
  fmtDateRange,
  fmtDuration,
  fmtEndedAt,
  fmtPrize,
  remainColor,
} from "@/lib/competition";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "比赛" };

export default async function CompetitionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const page = Math.max(parseInt(sp.page ?? "1", 10) || 1, 1);
  const session = await getSession();
  const now = Math.floor(Date.now() / 1000);

  const [data, me, gstats, mstats] = await Promise.all([
    getCompetitionPage(page, session?.uid),
    session ? getHeaderUser(session.uid) : Promise.resolve(null),
    getCompGlobalStats(),
    session ? getCompMyStats(session.uid) : Promise.resolve(null),
  ]);
  // 成绩采集为下一期口径：本期恒为空数组（图表区显示「暂无成绩数据」占位），
  // 接入后按比赛 id 填充排名散点即可渲染折线
  const compPoints: Parameters<typeof CompChart>[0]["points"] = [];

  return (
    <div id="page" className="two_columns comp_page">
      <ul id="home">
        <li className="main">
          <div className="comp_page_head">
            <h1>比赛</h1>
          </div>

          {data.rows.map((c) => (
            <div className="box comp_item" key={c.id}>
              {/* 标题行：标题+日期左，总奖金+按钮右 */}
              <div className="comp_head">
                <div className="comp_title_group">
                  <h3 className={"comp_name" + (c.status === "active" ? " on" : "")}>{c.name}</h3>
                  <span className="comp_dates">{fmtDateRange(c.start, c.end)}</span>
                </div>
                <div className="comp_ctrl">
                  {/* 总奖金（比标题小两号），hover 出分配方案气泡（朝上） */}
                  <span className="comp_tipwrap">
                    <span className="comp_prize">
                      总奖金：<b>{fmtPrize(c.prizeTotal)}</b>
                    </span>
                    {c.prizeLines.length > 0 && (
                      <span className="comp_tip">{`分配方案：${c.prizeLines.join("，")}`}</span>
                    )}
                  </span>

                  {c.status === "upcoming" && (
                    <span className="comp_tipwrap">
                      <span className="comp_btn_zone">
                        {session ? (
                          <SignupButton compId={c.id} joined={c.joined} name={c.name} />
                        ) : (
                          <Link className="comp_btn comp_btn_join" href="/account/login?next=/competitions">
                            报名参加
                          </Link>
                        )}
                      </span>
                      <span className="comp_tip">
                        <em>{fmtDuration(Math.max(c.start - now, 0))}后开始</em>
                        {` / 已有`}
                        <b className="gold">{c.entryCount}</b>
                        {`位玩家报名`}
                      </span>
                    </span>
                  )}

                  {c.status === "active" && (
                    <span className="comp_tipwrap">
                      <a className="vs_fight comp_link" href="/online">
                        开始比赛
                      </a>
                      <span className="comp_tip">
                        <b style={{ color: remainColor(c.end - now) }}>
                          {fmtDuration(Math.max(c.end - now, 0))}
                        </b>
                        后结束
                      </span>
                    </span>
                  )}

                  {c.status === "ended" && (
                    <span className="comp_tipwrap">
                      <span className="comp_btn comp_btn_ended">已结束</span>
                      <span className="comp_tip">
                        已于<b>{fmtEndedAt(c.end, now)}</b>结束 / 点击查看详细成绩
                      </span>
                    </span>
                  )}
                </div>
              </div>

              {/* 纪录图表：x=排名（最右为 1）y=成绩；本期成绩采集未接入，无数据先占位 */}
              <div className="comp_chart">
                {c.status === "upcoming" ? (
                  <span className="comp_chart_empty">尚未开始</span>
                ) : compPoints.length > 0 ? (
                  <CompChart points={compPoints} />
                ) : (
                  <span className="comp_chart_empty">暂无成绩数据</span>
                )}
              </div>

              {/* 信息行：发起人 | 比赛标识 */}
              <div className="comp_meta">
                <span>发起人：{c.creatorName}</span>
                <span className="comp_code">
                  比赛标识：
                  {c.status === "upcoming" ? (
                    "待定"
                  ) : (
                    <>
                      <b className="mono">{c.code}</b>
                      <em>({c.shortName})</em>
                    </>
                  )}
                </span>
              </div>

              <p className="comp_rules">比赛规则：{c.rules}</p>
            </div>
          ))}

          {data.total === 0 && (
            <div className="box comp_item">
              <div className="comp_chart_empty">暂时没有比赛，敬请期待</div>
            </div>
          )}

          <Pager base="/competitions" params={{}} page={data.page} total={data.total} pageSize={COMP_PAGE_SIZE} />
        </li>

        <li className="sidebar">
          {/* 登录态：玩家卡片 + 我的统计（张老师 13:12 定拆两卡，个人口径在上） */}
          {session && (
            <div className="box comp_card">
              <Link href={`/user/${session.uid}`} className="comp_card_link">
                {me?.avatarIsDefault ? (
                  <DefaultAvatar sex={me.sex} size="mid" className="comp_avatar" />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="comp_avatar" src={me?.avatarUrl || "/images/player/no.jpg"} alt="" />
                )}
                <span className="comp_card_info">
                  <b className="comp_card_name">{me?.chineseName || session.username}</b>
                  <em className="comp_card_uid">UID {session.uid}</em>
                </span>
              </Link>
            </div>
          )}
          {session && mstats && (
            <div className="box comp_stats">
              <h3 className="green">我的统计</h3>
              <div className="comp_stat_row">
                <span>参加比赛次数</span>
                <b>{mstats.joined}</b>
              </div>
              <div className="comp_stat_row">
                <span>最高排名</span>
                <b>{mstats.bestRank === null ? "—" : `第 ${mstats.bestRank} 名`}</b>
              </div>
              <div className="comp_stat_row">
                <span>累计奖金</span>
                <b className="gold">{mstats.prize > 0 ? fmtPrize(mstats.prize) : "—"}</b>
              </div>
            </div>
          )}

          {/* 全网统计（全站口径，未登录也显示） */}
          <div className="box comp_stats">
            <h3>全网统计</h3>
            <div className="comp_stat_row">
              <span>比赛个数</span>
              <b>{gstats.competitions}</b>
            </div>
            <div className="comp_stat_row">
              <span>参赛人数</span>
              <b>{gstats.participants}</b>
            </div>
            <div className="comp_stat_row">
              <span>录像数量</span>
              <b>{gstats.videos}</b>
            </div>
            <div className="comp_stat_row">
              <span>累计奖金</span>
              <b className="gold">{fmtPrize(gstats.prizeTotal)}</b>
            </div>
          </div>
        </li>
      </ul>
    </div>
  );
}
