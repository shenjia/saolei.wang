// 排行榜（2008 编排改造，2026-09-23 张老师要求）：
// 左：榜别 tabs（雷界排行/NF/进步/地区/人气）+ 全级别成绩表（列头点击排序，旧版称号，日升降）+ 老式分页
// 右：每日一星/雷界统计 切换卡 + 世界TOP10（minesweepergame.com 实时抓取，1 天缓存）
// 人界/神界榜按张老师要求取消；兼容旧 URL 参数 level/order/nf

import { getRankingTable, getFirstRankedUserId } from "@/lib/queries";
import { getTodayStar } from "@/lib/star";
import { ensureTodaySnapshot, getSumTimeDeltas } from "@/lib/ranksnap";
import { parseRankingBy } from "@/lib/config";
import { RankingNav } from "@/components/RankingNav";
import { RankingTable } from "@/components/RankingTable";
import { OldPager } from "@/components/OldPager";
import { RankingSidebar } from "@/components/RankingSidebar";
import { DailyStarCard } from "@/components/DailyStarCard";
import { SiteStats } from "@/components/SiteStats";
import { WorldTop10 } from "@/components/WorldTop10";

export const dynamic = "force-dynamic";
export const metadata = { title: "排行榜 | 扫雷网" };

export default async function RankingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  // 新参数 view/by；兼容旧参数（level/order/nf → by/view）
  let view = sp.view === "nf" ? "nf" : "all";
  let by = sp.by;
  if (!sp.view && !sp.by && (sp.level || sp.order || sp.nf)) {
    view = sp.nf === "1" ? "nf" : "all";
    by = `${sp.level ?? "sum"}_${sp.order ?? "time"}`;
  }
  const nf = view === "nf";
  const rankingBy = parseRankingBy(by);
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  const [{ rows, total, pageSize }, firstId, star] = await Promise.all([
    getRankingTable(rankingBy, nf, page),
    nf ? Promise.resolve(null) : getFirstRankedUserId(),
    getTodayStar(),
  ]);

  // 日升降：今日快照（惰性生成）vs 昨日；升降列仅按总计时间排序的普通榜显示，一星卡也需要
  await ensureTodaySnapshot();
  const deltas =
    rankingBy === "sum_time" && !nf ? await getSumTimeDeltas(rows.map((r) => r.id)) : undefined;
  const starDelta = star?.user ? (await getSumTimeDeltas([star.user.id])).get(star.user.id) : undefined;

  const viewParams = { view: nf ? ("nf" as const) : undefined };

  return (
    <div id="page" className="two_columns ranking_old">
      <ul id="home">
        <li className="main">
          <RankingNav current={nf ? "nf" : "all"} by={rankingBy} />
          <div className="box ranking_box">
            <RankingTable
              rows={rows}
              by={rankingBy}
              base="/ranking"
              params={viewParams}
              deltas={deltas}
              firstId={firstId}
            />
            <OldPager
              base="/ranking"
              params={{ ...viewParams, by: rankingBy === "sum_time" ? undefined : rankingBy }}
              page={page}
              total={total}
              pageSize={pageSize}
            />
          </div>
        </li>
        <li className="sidebar">
          <RankingSidebar star={<DailyStarCard delta={starDelta} />} stats={<SiteStats />} />
          <WorldTop10 />
        </li>
      </ul>
    </div>
  );
}
