// 排行榜（2008 编排改造，2026-09-23 张老师要求；2026-09-24 多轮调整）：
// 页面主体卡片内：h1「排行榜」+ 榜别 tabs + 右上角查找框（七轮：title/筛选/搜索框
// 整体移回卡片内，title 左、tabs 紧随、搜索框贴行尾）
// + 全级别成绩表 + 「加载更多」（替代老式分页）；右上角查找框无按钮化（模糊推荐）；
// 登录态下搜索框空输入推荐「自己」，回车定位（2026-10-13 替代原底部「我在哪里」按钮）。
// 世界榜作为一个排行种类并入 tabs（minesweepergame.com 实时抓取，1 天缓存）。
// 兼容旧 URL 参数 level/order/nf；page 参数保留兼容旧链接（首次渲染对应页）。

import { getRankingTable, getRankingPageOfUser, getBvRanking } from "@/lib/queries";
import { prisma } from "@/lib/db";
import { ensureTodaySnapshot, getSumTimeDeltas } from "@/lib/ranksnap";
import { parseRankingBy, byLevelOrder, parseBvRankingBy } from "@/lib/config";
import { title as assessTitle } from "@/lib/assess";
import { getSession } from "@/lib/auth";
import { RankingNav } from "@/components/RankingNav";
import { RankingFeed } from "@/components/RankingFeed";
import { WorldTop100 } from "@/components/WorldTop100";
import { BvRankingFeed } from "@/components/BvRankingFeed";

export const dynamic = "force-dynamic";

// 页面 title 统一「xx排行」命名（2026-09-24 张老师要求：不再用「xx榜」）
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const view =
    sp.view === "nf" || sp.nf === "1"
      ? "nf"
      : sp.view === "world"
        ? "world"
        : sp.view === "bv"
          ? "bv"
          : "all";
  const name =
    view === "world" ? "世界排行" : view === "nf" ? "NF排行" : view === "bv" ? "BV排行" : "雷界排行";
  return { title: `${name} | 扫雷网` };
}

export default async function RankingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  // 新参数 view/by；兼容旧参数（level/order/nf → by/view）
  let view =
    sp.view === "nf"
      ? "nf"
      : sp.view === "world"
        ? "world"
        : sp.view === "bv"
          ? "bv"
          : "all";
  let by = sp.by;
  if (!sp.view && !sp.by && (sp.level || sp.order || sp.nf)) {
    view = sp.nf === "1" ? "nf" : "all";
    by = `${sp.level ?? "sum"}_${sp.order ?? "time"}`;
  }

  // 世界榜：作为一个排行种类并入 tabs（抓取数据有 1 天缓存，见 lib/worldtop.ts）
  if (view === "world") {
    return (
      <div id="page" className="main ranking_old">
        <WorldTop100 />
      </div>
    );
  }

  // BV 收集榜（2026-10-13 张老师需求）：独立服务端渲染——列结构（进度条）与成绩榜
  // 差异大，不进 RankingFeed；无搜索定位/升降列；数据 1 小时缓存（见 queries.getBvRanking）
  if (view === "bv") {
    const bvBy = parseBvRankingBy(sp.by);
    const bvPage = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
    const { rows, total, pageSize, den, totalDen, ranges } = await getBvRanking(bvBy, bvPage);
    // 军衔 SUB 制按高级时间评定（与成绩榜同口径）
    const titled = rows.map((u) => ({ ...u, title: assessTitle(u.expTime) }));
    return (
      <div id="page" className="main ranking_old">
        <div className="box ranking_box">
          <div className="page_head">
            <h1 className="page_title">BV排行</h1>
            <RankingNav current="bv" />
          </div>
          {/* key 含 by/page：软导航切换排序时强制重挂载，避免 useState(initial) 保留旧数据 */}
          <BvRankingFeed
            key={`bv-${bvBy}-${bvPage}`}
            initial={titled}
            by={bvBy}
            total={total}
            pageSize={pageSize}
            den={den}
            totalDen={totalDen}
            ranges={ranges}
          />
        </div>
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

  // 登录态：是否已加入当前排行（决定底部是否显示「如何加入排行」）；
  // 同时取出本人信息传给搜索框——空输入时下拉推荐「自己」（2026-10-13 替代「我在哪里」按钮）
  const myUid = session?.uid;
  let inRanking = false;
  let me: { id: number; chineseName: string; englishName: string; sex: number } | undefined;
  if (myUid) {
    const { level, order } = byLevelOrder(rankingBy);
    const [page, u] = await Promise.all([
      getRankingPageOfUser(myUid, level, order, nf),
      prisma.user.findUnique({
        where: { id: BigInt(myUid) },
        select: { id: true, chineseName: true, englishName: true, sex: true },
      }),
    ]);
    inRanking = page > 0;
    if (u) me = { id: Number(u.id), chineseName: u.chineseName, englishName: u.englishName, sex: u.sex };
  }

  // 军衔列在服务端预算（Feed 客户端零成本渲染）——SUB 制按高级时间评定（2026-10-13）
  const titled = await Promise.all(
    rows.map(async (u) => ({ ...u, title: await assessTitle(u.scores.exp_time) }))
  );

  const viewParams = { view: nf ? ("nf" as const) : undefined };

  // 搜索/whereami 定位落地行：SSR 即高亮（无 JS 也可见），客户端接管后持续
  const hl = Math.max(0, parseInt(sp.hl ?? "0", 10) || 0) || undefined;

  return (
    <div id="page" className="main ranking_old">
      <div className="box ranking_box">
        <div className="page_head">
          <h1 className="page_title">{view === "nf" ? "NF排行" : "雷界排行"}</h1>
          <RankingNav current={nf ? "nf" : "all"} by={rankingBy} me={me} />
        </div>
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
          inRanking={inRanking}
          initialHl={hl}
        />
      </div>
    </div>
  );
}
