// 地区榜（移植 2008 版 Ranking_Area + Ranking_Areas：地区综合排行 + 地区内用户榜）
// 综合实力公式移植 Ranking_Area_Refresh：Power = Σ(全国有成绩人数 − 个人名次)，实时窗口函数计算
// 2026-10-13 张老师要求：榜单加交互式中国地图（见 components/AreaMap.tsx），地图放在排行最底部；
//                       并把「平均排行」列换成「活跃人数」（近 30 天登录人数）

import Link from "next/link";
import { getAreaRanking, getRankingTable } from "@/lib/queries";
import { title as assessTitle } from "@/lib/assess";
import { parseRankingBy, areaDisplay, parseAreaOrder } from "@/lib/config";
import { AreaRanking } from "@/components/AreaRanking";
import { RankingNav } from "@/components/RankingNav";
import { RankingTable } from "@/components/RankingTable";
import { OldPager } from "@/components/OldPager";

export const dynamic = "force-dynamic";
export const metadata = { title: "地区排行 | 扫雷网" };

export default async function AreaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const area = (sp.name ?? "").trim();

  // 地区内用户榜（移植 Ranking_Areas：全级别表，按 By 排序）
  if (area) {
    const by = parseRankingBy(sp.by);
    const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
    const { rows, total, pageSize } = await getRankingTable(by, false, page, area);
    return (
      <div id="page" className="main ranking_old">
        <div className="box ranking_box">
          <div className="page_head">
            <h1 className="page_title">
              <Link href="/area">地区排行</Link>
              <span className="sep">›</span>
              {areaDisplay(area)}
            </h1>
            <RankingNav current="area" />
          </div>
          <RankingTable rows={rows} by={by} base="/area" params={{ name: area }} />
          <OldPager
            base="/area"
            params={{ name: area, by: by === "sum_time" ? undefined : by }}
            page={page}
            total={total}
            pageSize={pageSize}
          />
        </div>
      </div>
    );
  }

  const order = parseAreaOrder(sp.order);
  const rows = await getAreaRanking(order);
  // 领军人物的军衔按高级时间评定（2026-10-13 SUB 制）
  const titles = await Promise.all(rows.map((r) => assessTitle(r.bestExpTime)));

  return (
    <div id="page" className="main ranking_old">
      <div className="box ranking_box">
        <div className="page_head">
          <h1 className="page_title">地区排行</h1>
          <RankingNav current="area" />
        </div>
        <AreaRanking rows={rows} titles={titles} order={order}>
          <div className="area_note">
            综合排行指数计算方式：地区内每位有成绩雷友贡献（全国有成绩总人数 − 个人全国名次），指数 = 地区全体成员贡献值之和。
            活跃人数 = 该地区近 30 天内登录过的雷友人数。
          </div>
        </AreaRanking>
      </div>
    </div>
  );
}

