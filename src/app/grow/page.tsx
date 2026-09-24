// 进步榜（2026-09-24 改版：对齐 2008 版 Ranking_Grow 表格编排 + 「加载更多」）：
// 表格列与雷界排行一致（排名=今日总计时间名次 | 姓名 | 军衔 | 8 列成绩 | 升降），
// 榜内排序按日升降幅度降序；底部「加载更多」替代翻页。

import { getGrowRanking } from "@/lib/ranksnap";
import { title as assessTitle } from "@/lib/assess";
import { RankingNav } from "@/components/RankingNav";
import { GrowFeed } from "@/components/GrowFeed";

export const dynamic = "force-dynamic";
export const metadata = { title: "进步榜 | 扫雷网" };

export default async function GrowPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const { rows, total, pageSize } = await getGrowRanking(page);
  const titled = await Promise.all(
    rows.map(async (u) => ({ ...u, title: await assessTitle(u.scores.sum_time) }))
  );

  return (
    <div id="page" className="main ranking_old">
      <div className="box ranking_box">
        <div className="page_head">
          <h1 className="page_title">进步榜</h1>
          <RankingNav current="grow" />
        </div>
        <GrowFeed key={page} initial={titled} total={total} pageSize={pageSize} />
      </div>
    </div>
  );
}
