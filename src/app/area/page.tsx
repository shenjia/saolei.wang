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
import { RankingTable } from "@/components/RankingTable";
import { OldPager } from "@/components/OldPager";
import { RankingRules } from "@/components/RankingRules";

export const dynamic = "force-dynamic";

// 地区榜页底规则板块（2026-10-14 张老师要求；口径见 queries.getAreaRanking）
const AREA_RULES = [
  <>
    <b>地区归属</b>：按注册资料中的地区统计；未填写地区或填写了多个地区的玩家不计入地区榜。
  </>,
  <>
    <b>综合排行指数</b>：地区内每位有成绩雷友贡献（全国有成绩总人数 −
    个人全国名次），指数为全体成员贡献值之和。默认按指数降序，点击表头可切换排行人数 /
    活跃人数 / 领军人物排序。
  </>,
  <>
    <b>全国名次</b>：与雷界排行的总计时间榜同口径（初 / 中 / 高级都有成绩且已过审）。
  </>,
  <>
    <b>活跃人数</b>：该地区近 30 天内登录过的雷友人数（含无成绩玩家）。
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
    <b>排序规则</b>：与雷界排行相同（8 个排序维度，点击表头切换；时间升序、3BV/s 降序）。
  </>,
  <>
    <b>地区归属</b>：按注册资料中的地区统计；修改地区资料后实时生效。
  </>,
];
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
    return (
      <div id="page" className="main ranking_old">
        <div className="box ranking_box">
          <div className="page_head">
            <h1 className="page_title">
              <Link href="/area">地区排行</Link>
              <span className="sep">›</span>
              {areaDisplay(area)}
            </h1>
            <RankingNav current="area" by={by} area={area} me={me} />
          </div>
          <RankingTable rows={rows} by={by} base="/area" params={{ name: area }} hlUid={hl} />
          <OldPager
            base="/area"
            params={{ name: area, by: by === "sum_time" ? undefined : by }}
            page={page}
            total={total}
            pageSize={pageSize}
          />
          <RankingRules title={`${areaDisplay(area)}地区排行规则`} items={AREA_INNER_RULES} />
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
          <RankingRules title="地区排行规则" items={AREA_RULES} />
        </AreaRanking>
      </div>
    </div>
  );
}

