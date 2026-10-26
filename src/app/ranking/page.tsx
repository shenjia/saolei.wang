// 排行榜（2008 编排改造，2026-09-23 张老师要求；2026-09-24 多轮调整）：
// 页面主体卡片内：h1「排行榜」+ 榜别 tabs + 右上角查找框（七轮：title/筛选/搜索框
// 整体移回卡片内，title 左、tabs 紧随、搜索框贴行尾）
// + 全级别成绩表 + 「加载更多」（替代老式分页）；右上角查找框无按钮化（模糊推荐）；
// 登录态下搜索框空输入推荐「自己」，回车定位（2026-10-13 替代原底部「我在哪里」按钮）。
// 世界榜作为一个排行种类并入 tabs（minesweepergame.com 实时抓取，1 天缓存）。
// 兼容旧 URL 参数 level/order/nf；page 参数保留兼容旧链接（首次渲染对应页）。

import { redirect } from "next/navigation";
import { getRankingTable, getRankingPageOfUser, getBvRanking, getBvRankOfUser, getStnbRanking, getStnbRankOfUser, getRankOfUsers } from "@/lib/queries";
import { prisma } from "@/lib/db";
import { ensureTodaySnapshot, getSumTimeDeltas } from "@/lib/ranksnap";
import { parseRankingBy, byLevelOrder, parseBvRankingBy, type VideoLevel } from "@/lib/config";
import { title as assessTitle } from "@/lib/assess";
import { dualTitles, getThunderKingId } from "@/lib/title-system";
import { getSession } from "@/lib/auth";
import { RankingNav } from "@/components/RankingNav";
import { RankingFeed } from "@/components/RankingFeed";
import { WorldTop100 } from "@/components/WorldTop100";
import { BvRankingFeed } from "@/components/BvRankingFeed";
import { StnbRankingFeed } from "@/components/StnbRankingFeed";
import { RankingRules, JoinRankingHelp } from "@/components/RankingRules";

export const dynamic = "force-dynamic";

// 雷界/NF 页底规则板块（2026-10-14 张老师要求：所有排行独立标准板块，口径见
// queries.getRankingTable / review.ts / ranksnap.ts 注释）。
// 配色（2026-10-15 张老师定）：金只留小标题「XX：」，正文强调不再用 <b>（金），
// 数字一律 <i>（亮灰）
const ALL_RULES = [
  <>
    <b>统计口径</b>：取每位玩家各项目的历史最好成绩（时间取最短、3BV/s 取最高）；录像
    <i>审核通过</i>即计入成绩，初级 3BV &lt; <i>10</i> 的运气盘不计 3BV/s。可上传录像的
    3BV 最低限制：初级 <i>2</i>、中级 <i>30</i>、高级 <i>100</i>。
  </>,
  <>
    <b>总计成绩</b>：初级、中级、高级都有成绩才计算总计，否则不上总计榜。
  </>,
  <>
    <b>排序规则</b>：点击表头在 <i>8</i> 个维度间切换（初级 / 中级 / 高级 / 总计 × 时间 /
    3BV/s）；时间按升序、3BV/s 按降序；成绩相同时按用户 ID 排序（时间榜注册较早者在前）。
  </>,
  <>
    <b>升降列</b>：仅在按总计时间排序时显示，为今日名次与 30 天窗口基准名次之差（窗口内
    最早可得快照；无基准的显示「新上榜」）。名次快照每天 0:05 定时刷新。
  </>,
  <>
    <b>上榜条件</b>：对应项目成绩大于 <i>0</i> 即在榜；榜单实时更新，录像过审即上榜。
  </>,
];

const NF_RULES = [
  <>
    <b>统计口径</b>：NF（无标）模式录像的历史最好成绩；一盘 NF 录像<i>审核通过</i>
    时同时计入雷界排行与 NF 排行两套成绩，普通（flag）录像不计入 NF 排行。
  </>,
  <>
    <b>总计成绩</b>：初级、中级、高级都有 NF 成绩才计算总计，否则不上总计榜。
  </>,
  <>
    <b>排序规则</b>：与雷界排行相同（<i>8</i> 个排序维度；时间升序、3BV/s 降序；成绩相同时按用户
    ID 排序）。
  </>,
  <>
    <b>称号列</b>：按雷界（flag）高级时间评定；NF 成绩更新不产生破纪录动态。
  </>,
  <>
    <b>上榜条件</b>：对应项目 NF 成绩大于 <i>0</i> 即在榜；榜单实时更新，录像过审即上榜。
  </>,
];

// STNB 榜规则条目（2026-10-20 张老师需求；口径见 queries.fetchStnbCollection）
const STNB_RULES = [
  <>
    <b>统计口径</b>：取每位玩家各难度<i>已通过审核</i>胜局录像的历史最高 STNB（综合评分，
    与录像评级「判雷」轴同源），按初级 / 中级 / 高级分别统计。运气盘限界与 3BV/s 成绩
    同款：初级 3BV &lt; <i>10</i> 的秒开盘不计入（实测不限则 3BV=2 的 0.09s 盘 STNB 达
    <i>4316</i>，远超正常水平 <i>473</i>）。
  </>,
  <>
    <b>总计成绩</b>：初级、中级、高级都有有效 STNB 成绩才计算总计（三级最高值之和），
    否则不上总计榜。
  </>,
  <>
    <b>排序规则</b>：按所选列的 STNB 降序排列；同分时注册较早（用户 ID 较小）的玩家排在
    前面。点击表头可在初级 / 中级 / 高级 / 总计之间切换排序。
  </>,
  <>
    <b>数据来源</b>：与录像分析雷达同一套指标体系（video_metrics），NF 录像同样计入；
    新过审录像破纪录即时计入榜单。
  </>,
];

// STNB 榜规则条目（进度条分母动态注入；2026-10-20 张老师定：渲染与 BV 榜一致）
function stnbRules(den: Record<VideoLevel, number>, totalDen: number, nf = false) {
  return [
    STNB_RULES[0],
    STNB_RULES[1],
    <>
      <b>进度条</b>：进度条分母为该难度全站最高 STNB 纪录（当前初级<i>{den.beg.toFixed(1)}</i>、
      中级 <i>{den.int.toFixed(1)}</i>、高级 <i>{den.exp.toFixed(1)}</i>，总计 <i>{totalDen.toFixed(1)}</i>
      ）；纪录刷新时分母随之更新。点击数值可查看对应录像。
    </>,
    STNB_RULES[2],
    <>
      <b>数据来源</b>：与录像分析雷达同一套指标体系（video_metrics），{nf ? "仅统计 NF 录像" : "NF 录像同样计入"}；
      新过审录像破纪录即时计入榜单。
    </>,
  ];
}

// BV 榜规则条目（分母随统计区间动态变化，故为函数；口径见 queries.fetchBvCollection）
function bvRules(den: Record<VideoLevel, number>, totalDen: number, nf = false) {
  return [
    <>
      <b>统计口径</b>：统计每位玩家<i>已通过审核</i>的{nf ? " NF " : ""}录像中出现过的不同 3BV
      数量——同一个 3BV 值只要有一盘过审录像即算「已收集」，按初级 / 中级 / 高级分别统计。
      统计区间按现行排行规则收敛：初级 3BV ≥ <i>2</i>、中级 ≥ <i>30</i>、高级 ≥
      <i>100</i>，低于下限的录像不计入收集。
    </>,
    <>
      <b>进度条</b>：进度条分母为站内各难度 3BV 的<i>可达值</i>数量（当前初级<i>{den.beg}</i>、
      中级 <i>{den.int}</i>、高级 <i>{den.exp}</i>，总计 <i>{totalDen}</i>）；区间下限按排行规则固定（<i>2</i> / <i>30</i>/
      <i>100</i>），初级上限为理论最大值 <i>54</i>（全部非雷格均为孤立数字格的极限盘），
      其中 <i>50</i>、<i>52</i>、<i>53</i> 在初级盘面数学上不可达、不计入分母；
      中/高级上限随新录像突破自动扩展。
    </>,
    <>
      <b>排名规则</b>：按所选列的收集数降序排列；收集数相同时，注册较早（用户 ID
      较小）的玩家排在前面。点击表头可在初级 / 中级 / 高级 / 总计之间切换排序。
    </>,
    <>
      <b>更新频率</b>：统计数据每小时更新一次，新过审的录像最迟 <i>1</i> 小时后计入榜单。
    </>,
  ];
}

// 页面 title 统一「xx排行」命名（2026-09-24 张老师要求：不再用「xx榜」）
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const nf = sp.view === "nf" || sp.nf === "1";
  const view =
    sp.view === "world"
      ? "world"
      : sp.view === "bv"
        ? "bv"
        : sp.view === "stnb"
          ? "stnb"
          : "all";
  const name =
    view === "world"
      ? "世界排行"
      : view === "bv"
        ? `${nf ? "NF " : ""}BV排行`
        : view === "stnb"
          ? `${nf ? "NF " : ""}STNB排行`
          : nf
            ? "NF排行"
            : "雷界排行";
  return { title: name };
}

export default async function RankingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  // 旧独立 NF 榜入口统一归一到成绩榜的正交 nf 开关，保留排序/页码/定位参数。
  if (sp.view === "nf") {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(sp)) {
      if (key !== "view" && value !== undefined) qs.set(key, value);
    }
    qs.set("nf", "1");
    redirect(`/ranking?${qs.toString()}`);
  }
  // 新参数 view/by；兼容旧参数（level/order/nf → by/view）
  let view =
    sp.view === "world"
      ? "world"
      : sp.view === "bv"
        ? "bv"
        : sp.view === "stnb"
          ? "stnb"
          : "all";
  const nf = sp.view === "nf" || sp.nf === "1";
  let by = sp.by;
  if (!sp.view && !sp.by && (sp.level || sp.order || sp.nf)) {
    view = "all";
    by = `${sp.level ?? "sum"}_${sp.order ?? "time"}`;
  }

  // 世界榜：作为一个排行种类并入 tabs（抓取数据有 1 天缓存，见 lib/worldtop.ts）。
  // 2026-10-15 张老师要求：加交互式世界地图——two_columns 双栏页宽口径（同地区总榜，
  // 三块 Grid 落位在 WorldRankingBody 内）
  if (view === "world") {
    return (
      <div id="page" className="main ranking_old">
        <WorldTop100 />
      </div>
    );
  }

  // BV 收集榜（2026-10-13 张老师需求）：独立服务端渲染——列结构（进度条）与成绩榜
  // 差异大，不进 RankingFeed；数据 1 小时缓存（见 queries.getBvRanking）。
  // 2026-10-14 搜索定位（C 方案）：搜索框与成绩榜同款（`?hl=` 落地高亮 + page 跳页），
  // 名次从缓存数组现查（getBvRankOfUser，零 DB）。
  if (view === "bv") {
    const bvBy = parseBvRankingBy(sp.by);
    const bvPage = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
    // 搜索/定位落地行：SSR 即高亮（无 JS 也可见），客户端接管后持续
    const hl = Math.max(0, parseInt(sp.hl ?? "0", 10) || 0) || undefined;
    const [bvData, session] = await Promise.all([
      // 降级兜底（2026-10-14 张老师要求）：BV 榜数据源是站内最重的查询——30 万行
      // video⋈video_info 全量聚合（queries.fetchBvCollection，1 小时缓存）。冷缓存重建时
      // 若 DB 抖动（P1017 / P2024 连接池打满，生产池仅 5 条），异常冒到页面就是整页 500。
      // 这里兜住改为降级文案（与世界榜 world_fail 同语言）。
      getBvRanking(bvBy, bvPage, undefined, nf).catch((e: unknown) => {
        console.error("[ranking] BV 榜数据获取失败，降级显示", e);
        return null;
      }),
      getSession(),
    ]);

    if (!bvData) {
      return (
        <div id="page" className="main ranking_old">
          <div className="box ranking_box">
            <div className="page_head">
              <h1 className="page_title">{nf ? "NF BV排行" : "BV排行"}</h1>
              <RankingNav current="bv" by={bvBy} nf={nf} />
            </div>
            <p className="ranking_fail">BV 排行数据暂时不可用，请稍后再试。</p>
          </div>
        </div>
      );
    }

    const { rows, total, pageSize, den, totalDen } = bvData;
    // 军衔 SUB 制按高级时间评定（与成绩榜同口径）；Phase 5 补旧版称号备选（BV 榜全在榜）
    // 2026-10-19 总司令=雷界第一人特判（两体系共用 king 判定）
    const bvKing = await getThunderKingId();
    const bvPairs = await dualTitles(rows.map((u) => ({ userId: u.id, expTime: u.expTime, ranked: true, sex: u.sex })));
    const titled = rows.map((u) => ({
      ...u,
      title: assessTitle(u.expTime, bvKing > 0 && bvKing === u.id),
      classic: bvPairs.get(u.id)?.c ?? null,
    }));

    // 登录态：搜索框空输入推荐「自己」——对 BV 榜比成绩榜更实用（自己的名次常在几百页外），
    // 顺带取自己的名次（缓存数组查询，零 DB）；无录像则下拉显示「未加入 BV 排行」
    let me:
      | {
          id: number;
          chineseName: string;
          englishName: string;
          sex: number;
          bvRank?: number;
        }
      | undefined;
    if (session?.uid) {
      const [u, mine] = await Promise.all([
        prisma.user.findUnique({
          where: { id: BigInt(session.uid) },
          select: { id: true, chineseName: true, englishName: true, sex: true },
        }),
        getBvRankOfUser(session.uid, bvBy, nf),
      ]);
      if (u) {
        me = {
          id: Number(u.id),
          chineseName: u.chineseName,
          englishName: u.englishName,
          sex: u.sex,
          bvRank: mine?.rank,
        };
      }
    }

    return (
      <div id="page" className="main ranking_old">
        <div className="box ranking_box">
          <div className="page_head">
            <h1 className="page_title">{nf ? "NF BV排行" : "BV排行"}</h1>
            <RankingNav current="bv" by={bvBy} nf={nf} me={me} />
          </div>
          {/* key 含 by/page/hl：软导航（排序切换、whereami 302 回跳）时强制重挂载，
              否则 useState(initial) 保留旧数据、表格显示错页 */}
          <BvRankingFeed
            key={`bv-${nf ? "nf" : "all"}-${bvBy}-${bvPage}-${hl ?? 0}`}
            initial={titled}
            by={bvBy}
            nf={nf}
            total={total}
            pageSize={pageSize}
            den={den}
            totalDen={totalDen}
            initialHl={hl}
          />
        </div>
        {/* BV 规则板块：独立 box（2026-10-15 张老师要求；从 Feed 移回页面层——
            Feed 是客户端组件，规则无需水合参与，服务端直出）。
            footer：登录未加入 BV 排行时板块内底部「如何加入排行？」（2026-10-15 移入规则板块） */}
        <RankingRules
          title="BV 排行规则"
          items={bvRules(den, totalDen, nf)}
          footer={session?.uid && me?.bvRank === undefined ? <JoinRankingHelp /> : undefined}
        />
      </div>
    );
  }

  // STNB 榜（2026-10-20 张老师需求）：展示形态仿 BV 榜（初级/中级/高级/总计四列排序，
  // 默认总计），数值列替进度条。数据 1 小时缓存（见 queries.getStnbRanking）。
  if (view === "stnb") {
    const stnbBy = parseBvRankingBy(sp.by);
    const stnbPage = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
    const hl = Math.max(0, parseInt(sp.hl ?? "0", 10) || 0) || undefined;
    const [stnbData, session] = await Promise.all([
      // 降级兜底（同 BV 榜）：全量聚合冷缓存重建遇 DB 抖动时降级文案，不整页 500
      getStnbRanking(stnbBy, stnbPage, undefined, nf).catch((e: unknown) => {
        console.error("[ranking] STNB 榜数据获取失败，降级显示", e);
        return null;
      }),
      getSession(),
    ]);

    if (!stnbData) {
      return (
        <div id="page" className="main ranking_old">
          <div className="box ranking_box">
            <div className="page_head">
              <h1 className="page_title">{nf ? "NF STNB排行" : "STNB排行"}</h1>
              <RankingNav current="stnb" by={stnbBy} nf={nf} />
            </div>
            <p className="ranking_fail">STNB 排行数据暂时不可用，请稍后再试。</p>
          </div>
        </div>
      );
    }

    const { rows, total, pageSize, den, totalDen } = stnbData;
    // 军衔 SUB 制按高级时间评定（与成绩榜同口径）；总司令=雷界第一人特判（两体系共用）
    const stnbKing = await getThunderKingId();
    const stnbPairs = await dualTitles(
      rows.map((u) => ({ userId: u.id, expTime: u.expTime, ranked: true, sex: u.sex }))
    );
    const titled = rows.map((u) => ({
      ...u,
      title: assessTitle(u.expTime, stnbKing > 0 && stnbKing === u.id),
      classic: stnbPairs.get(u.id)?.c ?? null,
    }));

    // 登录态：搜索框空输入推荐「自己」+ 自己的名次（缓存数组查询，零 DB）
    let me:
      | {
          id: number;
          chineseName: string;
          englishName: string;
          sex: number;
          stnbRank?: number;
        }
      | undefined;
    if (session?.uid) {
      const [u, mine] = await Promise.all([
        prisma.user.findUnique({
          where: { id: BigInt(session.uid) },
          select: { id: true, chineseName: true, englishName: true, sex: true },
        }),
        getStnbRankOfUser(session.uid, stnbBy, nf),
      ]);
      if (u) {
        me = {
          id: Number(u.id),
          chineseName: u.chineseName,
          englishName: u.englishName,
          sex: u.sex,
          stnbRank: mine?.rank,
        };
      }
    }

    return (
      <div id="page" className="main ranking_old">
        <div className="box ranking_box">
          <div className="page_head">
            <h1 className="page_title">{nf ? "NF STNB排行" : "STNB排行"}</h1>
            <RankingNav current="stnb" by={stnbBy} nf={nf} me={me} />
          </div>
          {/* key 含 by/page/hl：软导航时强制重挂载，否则 useState(initial) 保留旧数据 */}
          <StnbRankingFeed
            key={`stnb-${nf ? "nf" : "all"}-${stnbBy}-${stnbPage}-${hl ?? 0}`}
            initial={titled}
            by={stnbBy}
            nf={nf}
            total={total}
            pageSize={pageSize}
            den={den}
            totalDen={totalDen}
            initialHl={hl}
          />
        </div>
        <RankingRules
          title="STNB 排行规则"
          items={stnbRules(den, totalDen, nf)}
          footer={session?.uid && me?.stnbRank === undefined ? <JoinRankingHelp /> : undefined}
        />
      </div>
    );
  }

  const rankingBy = parseRankingBy(by);
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  const [{ rows, total, pageSize }, session] = await Promise.all([
    getRankingTable(rankingBy, nf, page),
    getSession(),
  ]);

  // 升降：30 天窗口预计算 delta（cron 00:05 刷新，此处惰性兜底）；升降列仅按总计时间排序的普通榜显示
  let deltas: Map<number, number | null> | undefined;
  if (rankingBy === "sum_time" && !nf) {
    await ensureTodaySnapshot();
    deltas = await getSumTimeDeltas(rows.map((r) => r.id));
  }

  // 登录态：是否已加入当前排行（决定底部是否显示「如何加入排行」）；
  // 同时取出本人信息传给搜索框——空输入时下拉推荐「自己」（2026-10-13 替代「我在哪里」按钮）
  const myUid = session?.uid;
  let inRanking = false;
  let me:
    | { id: number; chineseName: string; englishName: string; sex: number; rank?: number }
    | undefined;
  if (myUid) {
    const { level, order } = byLevelOrder(rankingBy);
    const [page, u, myRanks] = await Promise.all([
      getRankingPageOfUser(myUid, level, order, nf),
      prisma.user.findUnique({
        where: { id: BigInt(myUid) },
        select: { id: true, chineseName: true, englishName: true, sex: true },
      }),
      // 本人榜内名次（下拉「自己」显示「第 N 位」；三查并行，不增加等待）
      getRankOfUsers([myUid], rankingBy, nf),
    ]);
    inRanking = page > 0;
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

  // 军衔列在服务端预算（Feed 客户端零成本渲染）——SUB 制按高级时间评定（2026-10-13）
  // Phase 5：补旧版称号备选（榜单行全部在榜 ranked=true）
  // 2026-10-19 总司令=雷界第一人特判（两体系共用 king 判定）
  const king = await getThunderKingId();
  const rankPairs = await dualTitles(
    rows.map((u) => ({ userId: Number(u.id), expTime: u.scores.exp_time, ranked: true, sex: u.sex }))
  );
  const titled = await Promise.all(
    rows.map(async (u) => ({
      ...u,
      title: await assessTitle(u.scores.exp_time, king > 0 && king === Number(u.id)),
      classic: rankPairs.get(Number(u.id))?.c ?? null,
    }))
  );

  const viewParams = { nf: nf ? "1" : undefined };

  // 搜索/whereami 定位落地行：SSR 即高亮（无 JS 也可见），客户端接管后持续
  const hl = Math.max(0, parseInt(sp.hl ?? "0", 10) || 0) || undefined;

  return (
    <div id="page" className="main ranking_old">
      <div className="box ranking_box">
        <div className="page_head">
          <h1 className="page_title">{nf ? "NF排行" : "雷界排行"}</h1>
          <RankingNav current="all" by={rankingBy} me={me} nf={nf} />
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
          initialHl={hl}
          reserveDelta={!nf}
        />
      </div>
      {/* 规则板块：独立 box，与主卡片平级（2026-10-15 张老师要求：所有排行的
          规则各自成板块，不再嵌在数据卡片内）。
          footer：登录未入榜时板块内底部「如何加入排行？」（2026-10-15 从翻页控件右侧移入） */}
      <RankingRules
        title={nf ? "NF 排行规则" : "雷界排行规则"}
        items={nf ? NF_RULES : ALL_RULES}
        footer={myUid && !inRanking ? <JoinRankingHelp /> : undefined}
      />
    </div>
  );
}
