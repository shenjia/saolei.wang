// 进步榜（2026-09-24 改版：对齐 2008 版 Ranking_Grow 表格编排 + 「加载更多」）：
// 表格列与雷界排行一致（排名=本进步榜内名次 | 姓名 | 军衔 | 8 列成绩 | 升降），
// 榜内排序按日升降幅度降序；底部「加载更多」替代翻页。

import { getGrowRanking } from "@/lib/ranksnap";
import { getRankingPageOfUser } from "@/lib/queries";
import { getSession } from "@/lib/auth";
import { title as assessTitle } from "@/lib/assess";
import { dualTitles, getThunderKingId } from "@/lib/title-system";
import { RankingNav } from "@/components/RankingNav";
import { GrowFeed } from "@/components/GrowFeed";
import { RankingRules, JoinRankingHelp } from "@/components/RankingRules";

export const dynamic = "force-dynamic";
export const metadata = { title: "进步排行" };

// 进步榜页底规则板块（2026-10-14 张老师要求；口径见 ranksnap.getGrowRanking）。
// 配色（2026-10-15 张老师定）：金只留小标题，正文数字 <i> 亮灰
const GROW_RULES = [
  <>
    <b>统计口径</b>：比较今日与 30 天内最早可得快照的总计时间榜名次（对齐旧站 30 天
    窗口口径；快照积累不足 30 天时以最早一天为基准）。
  </>,
  <>
    <b>排序规则</b>：按进步幅度（基准名次 − 今日名次）降序；幅度相同时今日名次较高者在前。
  </>,
  <>
    <b>排名列</b>：为本进步榜中的名次（按进步幅度排序后的位次）；升降列另注明比基准日
    升降的名次数。
  </>,
  <>
    <b>上榜条件</b>：名次比基准日上升的玩家才上榜（上升越多排越前）；持平、下降与窗口内
    首次上榜（无基准）的玩家不出现。
  </>,
  <>
    <b>更新频率</b>：名次快照于每天 0:05 定时刷新（异常时当日首次访问补算），榜单实时查询。
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
  // Phase 5：补旧版称号备选（进步榜行全部在榜）
  const growPairs = await dualTitles(
    rows.map((u) => ({ userId: Number(u.id), expTime: u.scores.exp_time, ranked: true, sex: u.sex }))
  );
  // 2026-10-19 总司令=雷界第一人特判
  const king = await getThunderKingId();
  const titled = await Promise.all(
    rows.map(async (u, i) => ({
      ...u,
      title: await assessTitle(u.scores.exp_time, king > 0 && king === Number(u.id)),
      classic: growPairs[i]?.c ?? null,
    }))
  );

  // 登录未入榜 → 规则板块底部「如何加入排行？」（2026-10-15 从翻页控件右侧移入）。
  // 入榜判定与雷界总计时间榜同口径（上榜条件=昨天和今天都在总计时间榜内）
  const session = await getSession();
  const joined = session?.uid
    ? (await getRankingPageOfUser(session.uid, "sum", "time", false)) > 0
    : true;

  return (
    <div id="page" className="main ranking_old">
      <div className="box ranking_box">
        <div className="page_head">
          <h1 className="page_title">进步排行</h1>
          <RankingNav current="grow" />
        </div>
        <GrowFeed key={page} initial={titled} total={total} pageSize={pageSize} />
      </div>
      {/* 规则板块：独立 box，与主卡片平级（2026-10-15 张老师要求） */}
      <RankingRules
        title="进步排行规则"
        items={GROW_RULES}
        footer={session?.uid && !joined ? <JoinRankingHelp /> : undefined}
      />
    </div>
  );
}
