// 排行榜（2008 编排改造，2026-09-23 张老师要求；2026-09-24 多轮调整）：
// 页面顶部 h1「排行榜」（2026-09-24 五轮：移出卡片，置于最上面）+ 榜别 tabs
// + 全级别成绩表 + 「加载更多」（替代老式分页）；右上角查找框无按钮化（模糊推荐）；
// 登录态下「我在哪里」在底部加载更多右侧（点击定位到自己所在行）。
// 世界榜作为一个排行种类并入 tabs（minesweepergame.com 实时抓取，1 天缓存）。
// 兼容旧 URL 参数 level/order/nf；page 参数保留兼容旧链接（首次渲染对应页）。

import { getRankingTable } from "@/lib/queries";
import { ensureTodaySnapshot, getSumTimeDeltas } from "@/lib/ranksnap";
import { parseRankingBy } from "@/lib/config";
import { title as assessTitle } from "@/lib/assess";
import { getSession } from "@/lib/auth";
import { RankingNav } from "@/components/RankingNav";
import { RankingFeed } from "@/components/RankingFeed";
import { WorldTop100 } from "@/components/WorldTop100";

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
        <WorldTop100 />
      </div>
    );
  }

  const nf = view === "nf";
  const rankingBy = parseRankingBy(by);
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  const [{ rows, total, pageSize }, session] = await Promise.all([
    getRankingTable(rankingBy, nf, page),
    getSession(),
  ]);

  // 日升降：今日快照（惰性生成）vs 昨日；升降列仅按总计时间排序的普通榜显示
  let deltas: Map<number, number | null> | undefined;
  if (rankingBy === "sum_time" && !nf) {
    await ensureTodaySnapshot();
    deltas = await getSumTimeDeltas(rows.map((r) => r.id));
  }

  // 军衔列在服务端预算（Feed 客户端零成本渲染）
  const titled = await Promise.all(
    rows.map(async (u) => ({ ...u, title: await assessTitle(u.overallSumTime ?? u.scores.sum_time) }))
  );

  const viewParams = { view: nf ? ("nf" as const) : undefined };

  // 搜索/whereami 定位落地行：SSR 即高亮（无 JS 也可见），客户端接管后持续
  const hl = Math.max(0, parseInt(sp.hl ?? "0", 10) || 0) || undefined;

  return (
    <div id="page" className="main ranking_old">
      <div className="page_head">
        <h1 className="page_title">排行榜</h1>
        <RankingNav current={nf ? "nf" : "all"} by={rankingBy} />
      </div>
      <div className="box ranking_box">
        {/* key 含 page/view/by/hl：软导航（whereami 302 回跳）时强制重挂载，
            否则 Feed 的 useState(initial) 保留旧页数据、表格显示错页 */}
        <RankingFeed
          key={`${page}-${nf ? "nf" : "all"}-${rankingBy}-${hl ?? 0}`}
          initial={titled}
          initialDeltas={deltas}
          by={rankingBy}
          base="/ranking"
          params={viewParams}
          total={total}
          pageSize={pageSize}
          myUid={session?.uid}
          initialHl={hl}
        />
      </div>
    </div>
  );
}
