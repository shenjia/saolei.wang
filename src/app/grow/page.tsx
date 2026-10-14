// 进步榜（2026-09-24 改版：对齐 2008 版 Ranking_Grow 表格编排 + 「加载更多」）：
// 表格列与雷界排行一致（排名=今日总计时间名次 | 姓名 | 军衔 | 8 列成绩 | 升降），
// 榜内排序按日升降幅度降序；底部「加载更多」替代翻页。

import { getGrowRanking } from "@/lib/ranksnap";
import { title as assessTitle } from "@/lib/assess";
import { RankingNav } from "@/components/RankingNav";
import { GrowFeed } from "@/components/GrowFeed";
import { RankingRules } from "@/components/RankingRules";

export const dynamic = "force-dynamic";
export const metadata = { title: "进步排行" };

// 进步榜页底规则板块（2026-10-14 张老师要求；口径见 ranksnap.getGrowRanking）
const GROW_RULES = [
  <>
    <b>统计口径</b>：比较今日与昨日的<b>总计时间榜</b>名次（日对日），不设周 / 月榜。
  </>,
  <>
    <b>排序规则</b>：按进步幅度（昨日名次 − 今日名次）降序；幅度相同时今日名次较高者在前。
  </>,
  <>
    <b>排名列</b>：为今日总计时间榜名次，与雷界排行的总计时间同口径（初 / 中 / 高级都有成绩）。
  </>,
  <>
    <b>上榜条件</b>：昨天和今天都在总计时间榜内；今日新上榜或今日掉出榜的玩家不出现在进步榜。
  </>,
  <>
    <b>更新频率</b>：名次快照于每天首次访问时生成一次，榜单实时查询。
  </>,
];

export default async function GrowPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const { rows, total, pageSize } = await getGrowRanking(page);
  const titled = await Promise.all(
    rows.map(async (u) => ({ ...u, title: await assessTitle(u.scores.exp_time) }))
  );

  return (
    <div id="page" className="main ranking_old">
      <div className="box ranking_box">
        <div className="page_head">
          <h1 className="page_title">进步排行</h1>
          <RankingNav current="grow" />
        </div>
        <GrowFeed key={page} initial={titled} total={total} pageSize={pageSize} />
        <RankingRules title="进步排行规则" items={GROW_RULES} />
      </div>
    </div>
  );
}
