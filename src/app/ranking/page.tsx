// 排行榜（2008 编排改造，2026-09-23 张老师要求；同日晚二轮调整）：
// 通栏：榜别 tabs（雷界排行/NF/世界/进步/地区/人气）+ 全级别成绩表（列头点击排序，军衔，日升降）+ 老式分页
// 世界榜作为一个排行种类并入 tabs（minesweepergame.com 实时抓取，1 天缓存）
// 人界/神界榜、右侧每日一星模块按张老师要求取消；兼容旧 URL 参数 level/order/nf

import { getRankingTable } from "@/lib/queries";
import { ensureTodaySnapshot, getSumTimeDeltas } from "@/lib/ranksnap";
import { parseRankingBy } from "@/lib/config";
import { RankingNav } from "@/components/RankingNav";
import { RankingTable } from "@/components/RankingTable";
import { OldPager } from "@/components/OldPager";
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
  let view = sp.view === "nf" ? "nf" : sp.view === "world" ? "world" : "all";
  let by = sp.by;
  if (!sp.view && !sp.by && (sp.level || sp.order || sp.nf)) {
    view = sp.nf === "1" ? "nf" : "all";
    by = `${sp.level ?? "sum"}_${sp.order ?? "time"}`;
  }

  // 世界榜：作为一个排行种类并入 tabs（抓取数据有 1 天缓存，见 lib/worldtop.ts）
  if (view === "world") {
    return (
      <div id="page" className="main ranking_old">
        <RankingNav current="world" />
        <WorldTop10 />
      </div>
    );
  }

  const nf = view === "nf";
  const rankingBy = parseRankingBy(by);
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  const { rows, total, pageSize } = await getRankingTable(rankingBy, nf, page);

  // 日升降：今日快照（惰性生成）vs 昨日；升降列仅按总计时间排序的普通榜显示
  await ensureTodaySnapshot();
  const deltas =
    rankingBy === "sum_time" && !nf ? await getSumTimeDeltas(rows.map((r) => r.id)) : undefined;

  const viewParams = { view: nf ? ("nf" as const) : undefined };

  return (
    <div id="page" className="main ranking_old">
      <RankingNav current={nf ? "nf" : "all"} by={rankingBy} />
      <div className="box ranking_box">
        <RankingTable rows={rows} by={rankingBy} base="/ranking" params={viewParams} deltas={deltas} />
        <OldPager
          base="/ranking"
          params={{ ...viewParams, by: rankingBy === "sum_time" ? undefined : rankingBy }}
          page={page}
          total={total}
          pageSize={pageSize}
        />
      </div>
    </div>
  );
}
