// 前台「比赛」页（2026-11-13 张老师需求；二轮 14:45 口径修订）
//
// 版式：复用首页 #page.two_columns 双栏壳——左=比赛列表板块（一比赛一 .box，一页 ≤5 个，
// 底部 Pager 翻页），右=标准玩家卡片（UserPanel，与录像页同款）+「参赛记录」+「数据统计」。
// 二轮修订：
// · 顶部去掉页标题 h1（与导航「比赛」重复，张老师 14:45 定）；
// · 板块渲染抽到 TourBlock 共用（详情页顶部同款），状态气泡/标识/奖金口径见该组件头注；
// · 排序＝进行中 → 未开始 → 已结束（张老师 13:12 定）。

import type { Metadata } from "next";
import { getSession } from "@/lib/auth";
import { UserPanel } from "@/components/UserCard";
import { TourListFeed } from "@/components/tournament/TourListFeed";
import {
  getTourGlobalStats,
  getTourMyStats,
  getTournamentPage,
  ensureTourLifecycleEvents,
  fmtPrize,
} from "@/lib/tournament";

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

  const data = await getTournamentPage(page, session?.uid);
  // 惰性补写本页可见比赛的「正式开始 / 正式结束」动态（详情页渲染期同样兜底）；
  // 窗口赛补写需 scoreMode/scoreConfig/includeLevels → getTournamentPage 行不带，
  // 完赛补写函数内部自行查库，只透传 windowHours 判窗
  await Promise.all(
    data.rows.map((c) =>
      ensureTourLifecycleEvents(
        { id: c.id, startTime: c.start, endTime: c.end, windowHours: c.windowHours },
        now
      )
    )
  );
  const [gstats, mstats] = await Promise.all([
    getTourGlobalStats(),
    session ? getTourMyStats(session.uid) : Promise.resolve(null),
  ]);

  return (
    <div id="page" className="two_columns comp_page">
      <ul id="home">
        <li className="main">
          {/* 通用「加载更多+滑轨」翻页器（张老师三轮定）：客户端壳接 PageSlider，
              首屏服务端渲染，换页走 URL、加载更多走 /api/tournament/list */}
          <TourListFeed
            // key=页码重挂载（2026-11-21 张老师报「翻页无效」）：客户端壳 useState 接
            // 服务端初值，换页 RSC 重渲染时 props 更新但 state 不重置——列表永远停在
            // 首屏那 5 行。与 ranking 页三处 key={含 page} 同判例（ui-conventions 铁律）。
            key={page}
            initialRows={data.rows}
            initialPage={data.page}
            initialTotal={data.total}
            initialTotalPages={data.totalPages}
            now={now}
            loggedIn={!!session}
            myUid={session?.uid}
          />
        </li>

        <li className="sidebar">
          {/* 登录态：标准玩家卡片（与录像详情页右栏同款 UserPanel，四轮 20:03 定不带雷达板块） */}
          {session && <UserPanel userId={session.uid} hideRadar />}
          {session && mstats && (
            <div className="box comp_stats">
              <h2>参赛记录</h2>
              <div className="comp_stat_row">
                <span>参赛次数</span>
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

          {/* 全网统计（全站口径，未登录也显示）。
              2026-11-22 张老师定：数字亮灰（.comp_stat_row b 统一改色）+
              今日有更新加绿色括号增量（形态与首页数据统计一致——delta>0 才显示，
              全站今日增量统一绿色 .stat_today）。口径：动态事件表当日写入量——
              比赛个数=type1（发起）、参赛人数=type2 去重人、录像数量=type4 行数 */}
          <div className="box comp_stats">
            <h2>数据统计</h2>
            <div className="comp_stat_row">
              <span>比赛个数</span>
              <b>
                {gstats.tournaments}
                {gstats.tournamentsToday > 0 && (
                  <span className="stat_today">（+{gstats.tournamentsToday}）</span>
                )}
              </b>
            </div>
            <div className="comp_stat_row">
              <span>参赛人数</span>
              <b>
                {gstats.participants}
                {gstats.participantsToday > 0 && (
                  <span className="stat_today">（+{gstats.participantsToday}）</span>
                )}
              </b>
            </div>
            <div className="comp_stat_row">
              <span>录像数量</span>
              <b>
                {gstats.videos}
                {gstats.videosToday > 0 && (
                  <span className="stat_today">（+{gstats.videosToday}）</span>
                )}
              </b>
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
