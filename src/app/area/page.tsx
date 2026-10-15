// 地区榜（移植 2008 版 Ranking_Area + Ranking_Areas：地区综合排行 + 地区内用户榜）
// 综合实力公式移植 Ranking_Area_Refresh：Power = Σ(全国有成绩人数 − 个人名次)，实时窗口函数计算
// 2026-10-13 张老师要求：榜单加交互式中国地图（见 components/AreaMap.tsx），地图放在排行最底部；
//                       并把「平均排行」列换成「活跃人数」（近 30 天登录人数）

import Link from "next/link";

import { getAreaRanking, getRankingTable, getRankOfUsers } from "@/lib/queries";
import { title as assessTitle } from "@/lib/assess";
import { parseRankingBy, areaDisplay, parseAreaOrder } from "@/lib/config";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AreaRanking } from "@/components/AreaRanking";
import { RankingNav } from "@/components/RankingNav";
import { RankingFeed } from "@/components/RankingFeed";
import { RankingRules, JoinRankingHelp } from "@/components/RankingRules";

export const dynamic = "force-dynamic";

// 地区榜页底规则板块（2026-10-14 张老师要求；口径见 queries.getAreaRanking）
// 2026-10-15 张老师要求：去掉「全国名次」条目（表中已无此列，领军人物全国名次走用户卡）
// 配色（2026-10-15 张老师定）：金只留小标题，正文数字 <i> 亮灰
const AREA_RULES = [
  <>
    <b>地区归属</b>：按注册资料中的地区统计；未填写地区或填写了多个地区的玩家不计入地区榜。
  </>,
  <>
    <b>综合排行指数</b>：地区内每位有成绩雷友贡献（全国有成绩总人数 −
    个人全国名次），指数为全体成员贡献值之和。默认按指数降序；排行人数 / 活跃人数在地图悬停气泡中查看。
  </>,
  <>
    <b>活跃人数</b>：该地区近 <i>30</i> 天内登录过的雷友人数（含无成绩玩家）。
  </>,
  <>
    <b>更新频率</b>：数据实时计算；点击地区名可进入地区内页，查看该地区玩家的全级别成绩。
  </>,
];

// 地区内页规则（2026-10-14）：口径同雷界排行，仅限定地区
const AREA_INNER_RULES = [
  <>
    <b>统计口径</b>：与雷界排行相同（历史最好成绩、审核通过即计入），仅统计该地区玩家。
  </>,
  <>
    <b>排序规则</b>：与雷界排行相同（<i>8</i> 个排序维度，点击表头切换；时间升序、3BV/s 降序）。
  </>,
  <>
    <b>地区归属</b>：按注册资料中的地区统计；修改地区资料后实时生效。
  </>,
];

// 2026-10-14 张老师要求：带地区参数时 title 为「xx地区排行」（如「福建地区排行」）
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const area = (sp.name ?? "").trim();
  const name = area ? `${areaDisplay(area)}地区排行` : "地区排行";
  return { title: name };
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
    // 搜索定位落地行（whereami 302 携带 hl=<uid>，SSR 即高亮；2026-10-14 张老师要求地区排行支持搜索）
    const hl = Math.max(0, parseInt(sp.hl ?? "0", 10) || 0) || undefined;
    const [{ rows, total, pageSize }, session] = await Promise.all([
      getRankingTable(by, false, page, area),
      getSession(),
    ]);
    // 登录态：搜索框空输入推荐「自己」，名次为该地区内名次（与成绩榜同款的 SuggestUser 形态）
    let me:
      | { id: number; chineseName: string; englishName: string; sex: number; rank?: number }
      | undefined;
    if (session?.uid) {
      const [u, myRanks] = await Promise.all([
        prisma.user.findUnique({
          where: { id: BigInt(session.uid) },
          select: { id: true, chineseName: true, englishName: true, sex: true },
        }),
        getRankOfUsers([session.uid], by, false, area),
      ]);
      if (u) {
        me = {
          id: Number(u.id),
          chineseName: u.chineseName,
          englishName: u.englishName,
          sex: u.sex,
          rank: myRanks.get(Number(u.id)),
        };
      }
    }
    // 军衔列服务端预算（Feed 客户端零成本渲染）——SUB 制按主榜高级时间评定，
    // 与原 RankingTable 内部口径一致（NF 场景优先主榜回填值；地区内页恒主榜口径）
    const titledRows = await Promise.all(
      rows.map((u) => ({ ...u, title: assessTitle(u.overallExpTime ?? u.scores.exp_time) }))
    );
    return (
      <div id="page" className="main ranking_old">
        <div className="box ranking_box">
          <div className="page_head">
            <h1 className="page_title">{areaDisplay(area)}地区排行</h1>
            <RankingNav current="area" by={by} area={area} me={me} />
          </div>
          {/* 2026-10-15 张老师要求：老式分页（首页/上一页/末页）换成全站统一的
              「页码滑条 + 加载更多」（RankingFeed，增量走 /api/ranking/more?area=）；
              页脚右侧「返回地区排行」按钮——进入地区内页后原路回到带地图的地区总榜。
              key 含 by/page/hl：软导航（排序切换、whereami 302 回跳）时强制重挂载，
              否则 Feed 的 useState(initial) 保留旧页数据、表格显示错页 */}
          <RankingFeed
            key={`${page}-${by}-${hl ?? 0}`}
            initial={titledRows}
            by={by}
            base="/area"
            params={{ name: area }}
            total={total}
            pageSize={pageSize}
            initialHl={hl}
            footerExtra={
              <Link href="/area" className="button small pager_full_btn" title="回到带地图的地区排行总榜">
                返回地区排行
              </Link>
            }
          />
        </div>
        {/* 规则板块：独立 box，与主卡片平级（2026-10-15 张老师要求，与各排行页同口径）。
            footer：登录未加入该地区排行时板块内底部「如何加入排行？」（2026-10-15 移入规则板块） */}
        <RankingRules
          title={`${areaDisplay(area)}地区排行规则`}
          items={AREA_INNER_RULES}
          footer={session?.uid && me?.rank === undefined ? <JoinRankingHelp /> : undefined}
        />
      </div>
    );
  }

  const order = parseAreaOrder(sp.order);
  const rows = await getAreaRanking(order);
  // 领军人物的军衔按高级时间评定（2026-10-13 SUB 制）
  const titles = await Promise.all(rows.map((r) => assessTitle(r.bestExpTime)));

  return (
    <div id="page" className="main ranking_old two_columns">
      {/* 2026-10-15 张老师要求：规则、地图各自独立板块（与主卡片平级）。
          同日二轮：地图升到主卡片右侧（AreaRanking 渲染 .area_top 双栏）——
          two_columns 是 legacy 现成的双栏页宽口径（80% / max 960），否则 62% 竖版装不下两栏。
          表格与地图共用 hover 双向联动，须留在同一 client 组件里；页头与规则为服务端内容，以 props 传入。 */}
      {/* 规则板块由 AreaRanking 插入右列（.area_side）地图下方（2026-10-15 三轮：
          左表 20 条/页 + 翻页，右列＝地图+规则，左右高度齐平） */}
      <AreaRanking
        rows={rows}
        titles={titles}
        order={order}
        head={
          <div className="page_head">
            <h1 className="page_title">地区排行</h1>
            <RankingNav current="area" />
          </div>
        }
        rules={<RankingRules title="地区排行规则" items={AREA_RULES} />}
      />
    </div>
  );
}

