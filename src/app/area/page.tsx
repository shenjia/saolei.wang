// 地区榜（移植 2008 版 Ranking_Area + Ranking_Areas：地区综合排行 + 地区内用户榜）
// 综合实力公式移植 Ranking_Area_Refresh：Power = Σ(全国有成绩人数 − 个人名次)，实时窗口函数计算

import Link from "next/link";
import { getAreaRanking, getRankingTable, type AreaOrder } from "@/lib/queries";
import { title as assessTitle } from "@/lib/assess";
import { parseRankingBy } from "@/lib/config";
import { RankingNav } from "@/components/RankingNav";
import { RankingTable } from "@/components/RankingTable";
import { OldPager } from "@/components/OldPager";
import { TitleBadge } from "@/components/Cells";
import { buildUrl } from "@/components/Pager";

export const dynamic = "force-dynamic";
export const metadata = { title: "地区榜 | 扫雷网" };

const AREA_ORDERS: { key: AreaOrder; label: string }[] = [
  { key: "best", label: "领军人物" },
  { key: "players", label: "排行人数" },
  { key: "avg", label: "平均排行" },
  { key: "power", label: "综合排行指数" },
];

// 地区显示名映射（合规表述；链接/查询仍用数据库原值）
const AREA_DISPLAY: Record<string, string> = {
  香港: "中国香港",
  澳门: "中国澳门",
  台湾: "中国台湾",
};
const areaDisplay = (name: string) => AREA_DISPLAY[name] ?? name;

function parseAreaOrder(v?: string): AreaOrder {
  return (["power", "players", "avg", "best"] as const).find((o) => o === v) ?? "power";
}

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
        <RankingNav current="area" />
        <div className="box ranking_box">
          <h1 className="area_title">
            <Link href="/area">地区榜</Link>
            <span className="sep">›</span>
            {areaDisplay(area)}
          </h1>
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
  const maxPower = Math.max(1, ...rows.map((r) => r.power));
  // 领军人物的军衔按总计时间评定（2026-09-23 晚随排行表一起从旧版称号改回军衔）
  const titles = await Promise.all(rows.map((r) => assessTitle(r.bestSumTime)));

  return (
    <div id="page" className="main ranking_old">
      <RankingNav current="area" />
      <div className="box ranking_box">
            <table cellPadding={0} cellSpacing={0} className="ranking_table area_table">
              <thead>
                <tr>
                  <th>排名</th>
                  <th>地区</th>
                  {AREA_ORDERS.map((o) => (
                    <th key={o.key}>
                      <Link
                        href={buildUrl("/area", { order: o.key === "power" ? undefined : o.key })}
                        className={o.key === order ? "current" : ""}
                      >
                        {o.label}
                      </Link>
                    </th>
                  ))}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  return (
                    <tr key={r.area}>
                      <td className="rank">
                        第&nbsp;<em>{i + 1}</em>&nbsp;位
                      </td>
                      <td className="name">
                        <Link href={buildUrl("/area", { name: r.area })} title={`查看${areaDisplay(r.area)}雷友排行`}>
                          {areaDisplay(r.area)}
                        </Link>
                      </td>
                      <td className="best">
                        <TitleBadge title={titles[i]} link />
                        <Link href={`/user/${r.bestId}`} target="_blank" title="点击查看个人信息">
                          {r.bestName}
                        </Link>
                      </td>
                      <td className={order === "players" ? "num current" : "num"}>{r.players}&nbsp;人</td>
                      <td className={order === "avg" ? "num current" : "num"}>{r.avgRank}&nbsp;位</td>
                      <td className="power">
                        <span
                          className="bar"
                          style={{ width: `${Math.max(1, Math.round((r.power / maxPower) * 100))}%` }}
                        ></span>
                      </td>
                      <td className={order === "power" ? "num current" : "num"}>{r.power}</td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ textAlign: "center" }}>
                      暂无数据
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
      </div>
    </div>
  );
}
